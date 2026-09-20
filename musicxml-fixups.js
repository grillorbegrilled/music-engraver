// musicxml-fixups.js
//
// Runs a pipeline of small, targeted repairs on a MusicXML document in
// memory, after it's read from disk/upload but before it's handed to
// Verovio. Each fixer patches around one known Verovio import quirk —
// none of them change the musical meaning of the score, they just make
// sure Verovio's importer doesn't misread input that's valid but easy
// to trip on.
//
// Entry point: preprocessMusicXml(xmlText) -> xmlText (string in, string out)

/**
 * Ordered list of fixers. Each one takes a parsed XML Document, mutates
 * it in place, and returns how many fixes it made (for logging). Add
 * new fixers here as new Verovio import quirks turn up — that's the
 * whole extension point for this file.
 */
const FIXERS = [fixUnterminatedMeasureRepeats, fixNumeralRepeatDirections,
               fixZBuzzRollDirections, fixBassDrumNoteheads, fixCymbalNoteheads,
               fixAllRestMeasures, fixSoundOnlyNavigationMarks];

/**
 * Runs every fixer in FIXERS over the given MusicXML text and returns
 * the patched XML as a string. Safe to call on any MusicXML — a fixer
 * that finds nothing to do is a no-op. If the text doesn't parse as
 * XML at all, it's returned untouched so Verovio's own loader can
 * surface the real parse error with its own message.
 *
 * @param {string} xmlText
 * @returns {string}
 */
export function preprocessMusicXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  if (doc.getElementsByTagName("parsererror").length > 0) {
    return xmlText;
  }

  let totalFixes = 0;
  for (const fixer of FIXERS) {
    // Each fixer mutates the shared `doc` directly and runs after the
    // ones before it, so a bug in one fixer must not be allowed to
    // throw away every other fixer's already-applied, already-correct
    // mutations — that would silently fall all the way back to
    // unfixed input (fixers this one depends on quietly "undone")
    // instead of just missing the one broken fix.
    let count = 0;
    try {
      count = fixer(doc) || 0;
    } catch (err) {
      console.error(`[musicxml-fixups] ${fixer.name} threw and was skipped:`, err);
      continue;
    }
    if (count > 0) {
      totalFixes += count;
      console.info(`[musicxml-fixups] ${fixer.name}: ${count} fix(es)`);
    }
  }

  if (totalFixes === 0) return xmlText;

  return new XMLSerializer().serializeToString(doc);
}

// --- Fixers ----------------------------------------------------------

/**
 * Verovio bug workaround: an unterminated <measure-repeat type="start">
 * is legal MusicXML — the spec allows omitting the stop when the
 * repeat is meant to run through the end of the part. But Verovio's
 * importer doesn't reset that "repeat is open" state at the part
 * boundary, so it leaks into the *next* part in the file. Real, fully
 * notated measures in that next part then get rendered as
 * repeat-measure glyphs instead of their actual content.
 *
 * Fix: for every <part>, track measure-repeat start/stop per staff
 * number (the "number" attribute on <measure-style>, when a part has
 * more than one staff).
 *
 * Important: the fix must NOT touch the affected part's own last
 * measure. A <measure-repeat type="stop"/> marks "the first measure
 * where the repeat is no longer displayed" — inserting one there
 * would correctly stop the leak, but also flip that part's own last
 * measure from the repeat glyph over to its literal written-out
 * notes, which changes how the originating part looks. Instead, the
 * reset gets inserted into the *next* part's first measure: it clears
 * Verovio's carried-over flag before that part's real notes are
 * processed, without altering anything about the part that actually
 * owns the repeat.
 *
 * @param {Document} doc
 * @returns {number} number of stops inserted
 */
function fixUnterminatedMeasureRepeats(doc) {
  let fixes = 0;
  const parts = Array.from(doc.getElementsByTagName("part"));

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const measures = Array.from(part.getElementsByTagName("measure"));
    if (measures.length === 0) continue;

    // Key: staff "number" attribute on <measure-style>, or "_default"
    // for parts that don't use it (single-staff parts — the common
    // case for things like snare drum, quads, bass drums, cymbals).
    const openStaves = new Set();

    for (const measure of measures) {
      const styles = Array.from(measure.getElementsByTagName("measure-style"));
      for (const style of styles) {
        const repeat = style.getElementsByTagName("measure-repeat")[0];
        if (!repeat) continue;

        const key = style.getAttribute("number") || "_default";
        const type = repeat.getAttribute("type");
        if (type === "start") openStaves.add(key);
        else if (type === "stop") openStaves.delete(key);
      }
    }

    if (openStaves.size === 0) continue;

    // This part ends with the repeat still open. Legal by spec, but
    // it's exactly the state Verovio fails to reset at the part
    // boundary. Neutralize it in whatever part comes next, so it
    // can't bleed into real notation — leaving this part untouched.
    const nextPart = parts[i + 1];
    if (!nextPart) continue; // last part in the file — nothing downstream to protect

    const nextMeasures = nextPart.getElementsByTagName("measure");
    if (nextMeasures.length === 0) continue;

    for (const key of openStaves) {
      insertMeasureRepeatStop(doc, nextMeasures[0], key);
      fixes++;
    }
  }

  return fixes;
}
/**
 * Inserts:
 *   <attributes>
 *     <measure-style[ number="key"]>
 *       <measure-repeat type="stop"/>
 *     </measure-style>
 *   </attributes>
 * into `measure`, positioned to actually survive Verovio's importer.
 *
 * This is NOT just "the first element of the measure" — that was the
 * original (broken) approach. Verovio has a separate pre-pass,
 * ReadMusicXmlPartAttributesAsStaffDef, that runs on each part's
 * *first* measure before any notes are read, to build the staff
 * definition. It walks that measure's leading run of
 * attributes/barline/print/sound elements — and while doing so it
 * renames every <attributes> tag it touches to <mei-read>, precisely
 * so the real note-reading pass skips it later. A stop placed inside
 * that leading block (reused or newly inserted as the first child)
 * gets renamed away before Verovio's measure-repeat handling ever
 * sees it — so it's silently discarded, and the leaked repeat state
 * keeps bleeding through.
 *
 * The fix is positional: find the first child of `measure` that is
 * NOT one of attributes/barline/print/sound (almost always the first
 * <note>) — that's exactly where the StaffDef sweep stops looking —
 * and insert a fresh <attributes> right after it. Anything past that
 * point is untouched by the sweep, so this one keeps its real tag
 * name and gets processed normally.
 *
 * A second, separate <attributes> element later in a measure is
 * ordinary, legal MusicXML (mid-measure attribute changes use exactly
 * this pattern), so this doesn't touch or reuse whatever attributes
 * the measure already declares up front.
 */
function insertMeasureRepeatStop(doc, measure, key) {
  const sweepExempt = new Set(["attributes", "barline", "print", "sound"]);
  const children = Array.from(measure.children);
  const firstNonSwept = children.find((el) => !sweepExempt.has(el.tagName));

  const attributes = doc.createElement("attributes");
  const style = doc.createElement("measure-style");
  if (key !== "_default") style.setAttribute("number", key);

  const repeat = doc.createElement("measure-repeat");
  repeat.setAttribute("type", "stop");

  style.appendChild(repeat);
  attributes.appendChild(style);

  // insertBefore(x, null) appends — covers the (rare) case of a
  // measure that's entirely attributes/barline/print/sound with no
  // real content at all.
  measure.insertBefore(attributes, firstNonSwept ? firstNonSwept.nextElementSibling : null);
}

/**
 * Shorthand repeat markings: a <direction> whose words are exactly "2"
 * or "4" (nothing else) is a percussion-chart convention for "the next
 * 2 (or 4) measures repeat the previous 2 (or 4) measures" — a numeral
 * written over otherwise-blank placeholder measures instead of the
 * proper <measure-repeat> encoding. Verovio doesn't understand that
 * convention: it just prints a floating "2" or "4" above the staff and
 * renders whatever's actually written in those measures (typically
 * rests) instead of drawing the repeat-bar slashes.
 *
 * Fix: for each such direction, take the measure it's attached to plus
 * the following (N - 1) measures in the same part (N = 2 or 4, read
 * off the direction's text) as the placeholder block, then:
 *   - delete the numeral <direction>
 *   - open the block with <measure-repeat type="start" slashes="N">N</measure-repeat>
 *     on the first measure of the block
 *   - close it with an empty <measure-repeat type="stop"/> on the last
 *     measure of the block
 * slashes is set to N so the engraved symbol draws N diagonal slashes
 * — unambiguous at a glance, rather than defaulting to a single slash
 * that a 2- or 4-bar repeat could otherwise be misread as.
 *
 * The block's existing content (typically whole-measure rests) is left
 * untouched. As with the single-measure <measure-repeat> elsewhere in
 * this file, once the block is properly marked Verovio draws the
 * repeat glyph and disregards whatever notes are actually written.
 *
 * If fewer than N measures remain in the part — a malformed or
 * truncated marking — the direction is left in place rather than
 * guessed at.
 *
 * @param {Document} doc
 * @returns {number} number of numeral directions converted
 */
function fixNumeralRepeatDirections(doc) {
  let fixes = 0;
  const parts = Array.from(doc.getElementsByTagName("part"));

  for (const part of parts) {
    const measures = Array.from(part.getElementsByTagName("measure"));

    for (let i = 0; i < measures.length; i++) {
      // Snapshot per measure: removing a matched <direction> below
      // must not disturb iteration over that same measure's other
      // directions.
      const directions = Array.from(measures[i].getElementsByTagName("direction"));
      const match = directions.find((d) => numeralRepeatCount(d) !== null);
      if (!match) continue;

      const count = numeralRepeatCount(match);
      if (i + count > measures.length) continue; // not enough measures left — leave marking in place

      const staffNumber = directionStaffNumber(match);

      match.parentNode.removeChild(match);

      addMeasureRepeatMarker(doc, measures[i], "start", count, staffNumber, String(count));
      addMeasureRepeatMarker(doc, measures[i + count - 1], "stop", count, staffNumber, "");

      fixes++;
    }
  }

  return fixes;
}

/**
 * Returns 2 or 4 if `direction`'s combined <words> text (trimmed) is
 * exactly "2" or "4", otherwise null. Mirrors isZOnlyDirection's
 * all-or-nothing matching below: a direction mixing a numeral with any
 * other text is left alone rather than guessed at.
 */
function numeralRepeatCount(direction) {
  const directionTypes = Array.from(direction.getElementsByTagName("direction-type"));
  if (directionTypes.length === 0) return null;

  let text = "";
  for (const directionType of directionTypes) {
    for (const words of Array.from(directionType.getElementsByTagName("words"))) {
      text += words.textContent;
    }
  }

  text = text.trim();
  return text === "2" || text === "4" ? Number(text) : null;
}

/**
 * Reads the optional <staff> child some multi-staff-part directions
 * carry, so an inserted <measure-repeat> can be scoped to the same
 * staff the numeral marking was written on, via measure-style's
 * "number" attribute. Returns null for single-staff parts, where
 * measure-style's "number" attribute is omitted entirely — same
 * "_default" convention fixUnterminatedMeasureRepeats uses above.
 */
function directionStaffNumber(direction) {
  const staff = Array.from(direction.children).find((el) => el.tagName === "staff");
  return staff ? staff.textContent.trim() : null;
}

/**
 * Inserts a <measure-repeat> of the given type into `measure`, scoped
 * to `staffNumber` when given. Reuses a leading <attributes> element
 * if the measure already opens with one (the common case, since
 * measure-level attributes conventionally come first); otherwise
 * creates a fresh <attributes> as the very first child.
 *
 * Unlike insertMeasureRepeatStop above, this doesn't need to dodge
 * Verovio's part-boundary StaffDef sweep — that sweep only mis-reads
 * a *stop* leaking in from a different, already-finished part. Here
 * both the start and stop stay within the same part's own written-out
 * block, so a normal leading <attributes> is read correctly.
 */
function addMeasureRepeatMarker(doc, measure, type, count, staffNumber, text) {
  const first = measure.firstElementChild;
  let attributes;
  if (first && first.tagName === "attributes") {
    attributes = first;
  } else {
    attributes = doc.createElement("attributes");
    measure.insertBefore(attributes, first || null); // insertBefore(x, null) appends
  }

  const style = doc.createElement("measure-style");
  if (staffNumber) style.setAttribute("number", staffNumber);

  const repeat = doc.createElement("measure-repeat");
  repeat.setAttribute("type", type);
  if (type === "start") repeat.setAttribute("slashes", String(count));
  repeat.textContent = text;

  style.appendChild(repeat);
  attributes.appendChild(style);
}

/**
 * Percussion shorthand: a <direction> whose words say only "z" (case
 * insensitive, whitespace trimmed) is a buzz-roll marking written as
 * text instead of notation — the composer/arranger's way of saying
 * "unmeasured tremolo on the next note." Verovio doesn't understand
 * that convention, so it just renders a floating "z" above the staff
 * and the note itself keeps looking like a plain single hit.
 *
 * Fix: for every such <direction>, find the <note> immediately
 * following it, attach a proper
 *   <notations><ornaments><tremolo type="unmeasured"/></ornaments></notations>
 * (the MusicXML 4.0 encoding of a buzz roll / unmeasured tremolo —
 * Verovio and other renderers draw the standard buzz-roll glyph for
 * this by default), then delete the now-redundant <direction>.
 *
 * Only direct next-sibling notes are treated as "immediately
 * following" — if a direction isn't directly followed by a <note>
 * element, it's left alone rather than guessed at.
 *
 * @param {Document} doc
 * @returns {number} number of "z" directions converted
 */
function fixZBuzzRollDirections(doc) {
  let fixes = 0;

  // Snapshot into a plain array first: getElementsByTagName returns a
  // live collection, and removing a <direction> from the document
  // while iterating that collection would shift indices and skip
  // elements.
  const directions = Array.from(doc.getElementsByTagName("direction"));

  for (const direction of directions) {
    if (!isZOnlyDirection(direction)) continue;

    const note = direction.nextElementSibling;
    if (!note || note.tagName !== "note") continue; // nothing to attach the roll to — leave it in place

    addUnmeasuredTremolo(doc, note);
    direction.parentNode.removeChild(direction);
    fixes++;
  }

  return fixes;
}

/**
 * True if every <words> element inside `direction`'s <direction-type>
 * children combines (trimmed, case-insensitive) to exactly "z". Other
 * direction-type content (dynamics, wedges, etc.) contributes no text
 * here, so a direction mixing "z" with anything else correctly fails
 * this check instead of being treated as a match.
 */
function isZOnlyDirection(direction) {
  const directionTypes = Array.from(direction.getElementsByTagName("direction-type"));
  if (directionTypes.length === 0) return false;

  let text = "";
  for (const directionType of directionTypes) {
    for (const words of Array.from(directionType.getElementsByTagName("words"))) {
      text += words.textContent;
    }
  }

  return text.trim().toUpperCase() === "Z";
}

/**
 * Attaches a buzz-roll (unmeasured tremolo) ornament to `note`,
 * respecting MusicXML's content model instead of just appending:
 * <notations> must come before any <lyric> elements on the note, so
 * a new <notations> is inserted right before the first <lyric> when
 * one exists. An existing <notations>/<ornaments> pair is reused so
 * this doesn't clobber other notations (fermatas, articulations,
 * etc.) already present on the note.
 */
function addUnmeasuredTremolo(doc, note) {
  const children = Array.from(note.children);

  let notations = children.find((el) => el.tagName === "notations");
  if (!notations) {
    notations = doc.createElement("notations");
    const lyric = children.find((el) => el.tagName === "lyric");
    note.insertBefore(notations, lyric || null); // insertBefore(x, null) appends
  }

  let ornaments = Array.from(notations.children).find((el) => el.tagName === "ornaments");
  if (!ornaments) {
    ornaments = doc.createElement("ornaments");
    notations.appendChild(ornaments);
  }

  const tremolo = doc.createElement("tremolo");
  tremolo.setAttribute("type", "unmeasured");
  ornaments.appendChild(tremolo);
}

/**
 * Percussion notation workaround: notes in the bass drum part that use
 * slash or x noteheads need an explicit unpitched display position so
 * Verovio places them on the intended staff position.
 *
 * Fix: locate the <part> whose corresponding <score-part>/<part-name>
 * contains "bass drum" (case insensitive), then only within that part,
 * find notes whose <notehead> is "slash" or "x". Set their unpitched
 * display position to B4.
 *
 * Important: only the matching bass drum part is inspected. No notes in
 * any other part are modified.
 *
 * @param {Document} doc
 * @returns {number} number of notes changed
 */
function fixBassDrumNoteheads(doc) {
  let fixes = 0;

  // MusicXML identifies a <part> by its id, while the human-readable
  // instrument name lives in the corresponding <score-part>/<part-name>.
  const scoreParts = Array.from(doc.getElementsByTagName("score-part"));

  const bassDrumPartIds = new Set();

  for (const scorePart of scoreParts) {
    const partName = scorePart.getElementsByTagName("part-name")[0];
    if (!partName) continue;

    if (partName.textContent.toLowerCase().includes("bass drum")) {
      const id = scorePart.getAttribute("id");
      if (id) bassDrumPartIds.add(id);
    }
  }

  if (bassDrumPartIds.size === 0) return 0;

  // Only inspect <part> elements whose id corresponds to a matching
  // <score-part>. This deliberately prevents the fixer from touching
  // similarly notated notes in other instruments.
  const parts = Array.from(doc.getElementsByTagName("part"));

  for (const part of parts) {
    if (!bassDrumPartIds.has(part.getAttribute("id"))) continue;

    const notes = Array.from(part.getElementsByTagName("note"));

    for (const note of notes) {
      const notehead = Array.from(note.children).find(
        (el) => el.tagName === "notehead"
      );

      if (!notehead) continue;

      const value = notehead.textContent.trim().toLowerCase();
      if (value !== "slash" && value !== "x") continue;

      setBassDrumDisplayPosition(doc, note);
      fixes++;
    }
  }

  return fixes;
}

/**
 * Sets the note's <unpitched> display position to B4.
 *
 * Existing <unpitched> elements are reused. If one does not exist,
 * a correctly positioned one is created before <duration>.
 */
function setBassDrumDisplayPosition(doc, note) {
  let unpitched = Array.from(note.children).find(
    (el) => el.tagName === "unpitched"
  );

  if (!unpitched) {
    unpitched = doc.createElement("unpitched");

    const duration = Array.from(note.children).find(
      (el) => el.tagName === "duration"
    );

    note.insertBefore(unpitched, duration || null);
  }

  let displayStep = Array.from(unpitched.children).find(
    (el) => el.tagName === "display-step"
  );

  if (!displayStep) {
    displayStep = doc.createElement("display-step");
    unpitched.appendChild(displayStep);
  }

  displayStep.textContent = "B";

  let displayOctave = Array.from(unpitched.children).find(
    (el) => el.tagName === "display-octave"
  );

  if (!displayOctave) {
    displayOctave = doc.createElement("display-octave");
    unpitched.appendChild(displayOctave);
  }

  displayOctave.textContent = "4";
}

/**
 * Cymbal notation workaround: cymbal parts sometimes contain special
 * <notehead> values on notes positioned at A4 or B4. For those notes,
 * remove the <notehead> element entirely so Verovio uses its normal
 * notehead.
 *
 * Fix: locate any <part> whose corresponding <score-part>/<part-name>
 * contains "cymbal" (case insensitive). Within those parts only, find
 * notes with an <unpitched> display position of A4 or B4 and remove
 * their <notehead> element.
 *
 * Important: only matching cymbal parts are inspected. No notes in any
 * other part are modified.
 *
 * @param {Document} doc
 * @returns {number} number of noteheads removed
 */
function fixCymbalNoteheads(doc) {
  let fixes = 0;

  // Find the IDs of score-parts whose names contain "cymbal".
  const scoreParts = Array.from(doc.getElementsByTagName("score-part"));
  const cymbalPartIds = new Set();

  for (const scorePart of scoreParts) {
    const partName = scorePart.getElementsByTagName("part-name")[0];
    if (!partName) continue;

    if (partName.textContent.toLowerCase().includes("cymbal")) {
      const id = scorePart.getAttribute("id");
      if (id) cymbalPartIds.add(id);
    }
  }

  if (cymbalPartIds.size === 0) return 0;

  // Only inspect the actual <part> elements corresponding to those
  // score-parts.
  const parts = Array.from(doc.getElementsByTagName("part"));

  for (const part of parts) {
    if (!cymbalPartIds.has(part.getAttribute("id"))) continue;

    const notes = Array.from(part.getElementsByTagName("note"));

    for (const note of notes) {
      const unpitched = Array.from(note.children).find(
        (el) => el.tagName === "unpitched"
      );

      if (!unpitched) continue;

      const displayStep = Array.from(unpitched.children).find(
        (el) => el.tagName === "display-step"
      );
      const displayOctave = Array.from(unpitched.children).find(
        (el) => el.tagName === "display-octave"
      );

      if (!displayStep || !displayOctave) continue;

      const step = displayStep.textContent.trim().toUpperCase();
      const octave = displayOctave.textContent.trim();

      if (octave !== "4" || (step !== "E" && step !== "D")) continue;

      const notehead = Array.from(note.children).find(
        (el) => el.tagName === "notehead"
      );

      if (!notehead) continue;

      note.removeChild(notehead);
      fixes++;
    }
  }

  return fixes;
}

/**
 * Whole-measure rest workaround: when a measure contains only rests,
 * replace all of its <note> elements with a single whole-measure rest.
 *
 * MusicXML has a dedicated encoding for this:
 *
 *   <note>
 *     <rest measure="yes"/>
 *     <duration>...</duration>
 *     <voice>...</voice>
 *     <type>whole</type>
 *   </note>
 *
 * The measure="yes" attribute tells the renderer that this is a
 * measure-level rest, which is rendered centered in the measure rather
 * than as an ordinary whole-note rest.
 *
 * Only measures where EVERY <note> is a rest are changed. Measures
 * containing any pitched or unpitched note are left untouched.
 *
 * @param {Document} doc
 * @returns {number} number of measures converted
 */
function fixAllRestMeasures(doc) {
  let fixes = 0;

  const measures = Array.from(doc.getElementsByTagName("measure"));

  for (const measure of measures) {
    const notes = Array.from(measure.getElementsByTagName("note"));

    // An empty measure isn't an all-rest measure.
    if (notes.length === 0) continue;

    // Every note must contain a <rest>.
    const allRests = notes.every((note) =>
      Array.from(note.children).some((el) => el.tagName === "rest")
    );

    if (!allRests) continue;

    // Don't attempt to collapse a measure containing multiple voices
    // or staves into one note. Those can have independently timed
    // rests and require separate measure-level rests.
    const voices = new Set();
    const staffs = new Set();

    for (const note of notes) {
      const voice = Array.from(note.children).find(
        (el) => el.tagName === "voice"
      );
      const staff = Array.from(note.children).find(
        (el) => el.tagName === "staff"
      );

      if (voice) voices.add(voice.textContent.trim());
      if (staff) staffs.add(staff.textContent.trim());
    }

    if (voices.size > 1 || staffs.size > 1) continue;

    // The replacement note has to last as long as everything it
    // replaces, so total the durations of all the rests. (Copying the
    // first rest's duration alone was a bug: a measure of four quarter
    // rests came out as a whole-measure rest lasting one quarter.)
    // A missing or unparseable duration on any rest means we can't
    // know the real total, so leave the measure alone.
    const firstNote = notes[0];

    let totalDuration = 0;
    let durationsKnown = true;
    for (const note of notes) {
      const noteDuration = Array.from(note.children).find(
        (el) => el.tagName === "duration"
      );
      const value = noteDuration ? Number(noteDuration.textContent.trim()) : NaN;
      if (!Number.isFinite(value)) {
        durationsKnown = false;
        break;
      }
      totalDuration += value;
    }

    if (!durationsKnown) continue;

    // Preserve voice/staff information where present.
    const voice = Array.from(firstNote.children).find(
      (el) => el.tagName === "voice"
    );
    const staff = Array.from(firstNote.children).find(
      (el) => el.tagName === "staff"
    );

    // Remove every existing note.
    for (const note of notes) {
      measure.removeChild(note);
    }

    const newNote = doc.createElement("note");

    const rest = doc.createElement("rest");
    rest.setAttribute("measure", "yes");
    newNote.appendChild(rest);

    const newDuration = doc.createElement("duration");
    newDuration.textContent = String(totalDuration);
    newNote.appendChild(newDuration);

    if (voice) {
      const newVoice = doc.createElement("voice");
      newVoice.textContent = voice.textContent;
      newNote.appendChild(newVoice);
    }

    const type = doc.createElement("type");
    type.textContent = "whole";
    newNote.appendChild(type);

    if (staff) {
      const newStaff = doc.createElement("staff");
      newStaff.textContent = staff.textContent;
      newNote.appendChild(newStaff);
    }

    measure.appendChild(newNote);
    fixes++;
  }

  return fixes;
}

/**
 * Navigation-mark workaround: some exporters (Flat, confirmed on
 * several real files) write segno / coda / D.S. / D.C. / To Coda /
 * Fine purely as <sound> attributes — real jump semantics for
 * playback — but never write the visual that a well-behaved exporter
 * puts next to them (no <segno/> glyph, no <coda/> glyph, no
 * <words>D.S.</words>, ...). Verovio only draws what's in a
 * <direction-type>, so on screen and in the PDF the structure just
 * silently isn't there.
 *
 * Fix: for every <sound> carrying one of those attributes, synthesize
 * the missing visual as an ordinary <direction placement="above">.
 * The <sound> itself is never moved, edited, or removed — this only
 * adds the visual, it doesn't reinterpret or drop playback data.
 *
 * | attribute   | visual                                           |
 * | segno       | <segno/> glyph                                   |
 * | coda        | <coda/> glyph                                    |
 * | dalsegno    | "D.S." (+ " al Coda" / " al Fine", see below)    |
 * | dacapo      | "D.C." (+ " al Coda" / " al Fine", see below)    |
 * | tocoda      | "To Coda"                                        |
 * | fine        | "Fine"                                           |
 *
 * D.S./D.C. suffix: " al Coda" if any <sound> in the document has a
 * tocoda, else " al Fine" if any has a fine, else no suffix. A single
 * piece won't realistically mix both endings, so a document-wide check
 * is enough — no matching by token value across independent
 * navigation structures.
 *
 * Two shapes of <sound> are handled, both spec-legal:
 *   - <direction><...><sound/></direction>: the visual is added as a
 *     new <direction-type> among the direction's existing leading
 *     <direction-type> children (the content model is
 *     direction-type+, offset?, ..., staff?, sound?, so appending after
 *     <staff>/<sound> would be invalid). Skipped for an attribute
 *     whose visual is already there (the matching glyph for
 *     segno/coda; any <words> for the textual ones) so authored
 *     content is never overwritten.
 *   - <measure><sound/></measure> (the bare shape Flat writes): a new
 *     <direction> is inserted — for glyphs, at the measure's "header
 *     block" (after the leading attributes/print/sound/left-barline
 *     run, before the first real content); for text, after the last
 *     <note> (see placement below).
 *
 * Idempotent, which matters: loadScore() runs preprocessMusicXml()
 * again on text that's already been fixed. Because the bare <sound>
 * stays put, it would keep triggering a fresh synthesis on every run
 * — so for that shape the measure is first checked for a <direction>
 * that already carries the visual (matching glyph; for the textual
 * ones, <words> in the same family — see NAV_WORDS_FAMILY). Barline
 * <segno>/<coda> children are deliberately not counted: only
 * <direction-type> content is known to render.
 *
 * Placement follows engraving convention. Glyph marks (segno, coda)
 * go at the start of the measure. Textual marks (D.S., D.C., To
 * Coda, Fine) go at the end: the direction is inserted right after
 * the measure's last <note>, so Verovio anchors it at the end of the
 * measure, and its <words> get justify="right" and halign="right" so
 * the text ends at the barline instead of running into the next
 * measure.
 *
 * @param {Document} doc
 * @returns {number} number of visuals synthesized
 */
function fixSoundOnlyNavigationMarks(doc) {
  const sounds = Array.from(doc.getElementsByTagName("sound")).filter((sound) => {
    const parentTag = sound.parentNode && sound.parentNode.tagName;
    return parentTag === "measure" || parentTag === "direction";
  });

  const anyToCoda = sounds.some((sound) => hasNavAttr(sound, "tocoda"));
  const anyFine = sounds.some((sound) => hasNavAttr(sound, "fine"));
  const suffix = anyToCoda ? " al Coda" : anyFine ? " al Fine" : "";

  // Where new directions go in each measure, computed once per
  // measure so several marks in the same measure keep document order
  // instead of each one being inserted in front of the previous one.
  const startInsertionPoints = new Map();
  const endInsertionPoints = new Map();

  let fixes = 0;

  for (const sound of sounds) {
    const visuals = navVisualsFor(sound, suffix);
    if (visuals.length === 0) continue;

    const parent = sound.parentNode;

    if (parent.tagName === "direction") {
      // Decide everything up front: adding one visual must not change
      // the "already has <words>?" answer for the next.
      const missing = visuals.filter((v) => !directionHasNavVisual(parent, v));
      for (const visual of missing) {
        addNavVisualToDirection(doc, parent, visual);
        fixes++;
      }
      continue;
    }

    // parent is <measure>: the bare shape.
    if (!startInsertionPoints.has(parent)) {
      startInsertionPoints.set(parent, firstNonHeaderChild(parent));
      endInsertionPoints.set(parent, endOfMeasureInsertionPoint(parent));
    }

    for (const visual of visuals) {
      if (measureHasNavVisual(parent, visual)) continue;

      const direction = doc.createElement("direction");
      direction.setAttribute("placement", "above");
      direction.appendChild(buildNavDirectionType(doc, visual, visual.kind === "words"));

      // Text marks belong at the measure's end, glyphs at its start.
      const before = (visual.kind === "words" ? endInsertionPoints : startInsertionPoints).get(parent);
      parent.insertBefore(direction, before); // insertBefore(x, null) appends
      fixes++;
    }
  }

  return fixes;
}

// Order here is the order visuals are produced when one <sound>
// carries several attributes.
const NAV_ATTRS = ["segno", "coda", "dalsegno", "dacapo", "tocoda", "fine"];

/**
 * Normalized-<words> patterns meaning "this text is already the visual
 * for this attribute". Normalization = lowercase, everything except
 * a-z/0-9 stripped, so "D.S. al Coda", "d.s.", and "DS al Fine" all
 * start with "ds". Small, explicit vocabulary on purpose — used only
 * to avoid double-drawing a mark that's already written out, never to
 * decide that something *is* a navigation mark.
 */
const NAV_WORDS_FAMILY = {
  dalsegno: /^(ds|dalsegno)/,
  dacapo: /^(dc|dacapo)/,
  tocoda: /^tocoda/,
  fine: /^fine$/,
};

/**
 * True if `sound` carries a meaningful value for navigation attribute
 * `name`. dacapo and fine are yes/no-style flags in practice, so an
 * explicit "no" doesn't count; empty values never do.
 */
function hasNavAttr(sound, name) {
  const value = (sound.getAttribute(name) || "").trim().toLowerCase();
  if (value === "") return false;
  if ((name === "dacapo" || name === "fine") && value === "no") return false;
  return true;
}

/**
 * The visuals `sound` needs, as {attr, kind, text?} in NAV_ATTRS order.
 * kind is the element to draw: "segno" / "coda" glyphs, or "words".
 */
function navVisualsFor(sound, suffix) {
  const visuals = [];
  for (const attr of NAV_ATTRS) {
    if (!hasNavAttr(sound, attr)) continue;
    if (attr === "segno") visuals.push({ attr, kind: "segno" });
    else if (attr === "coda") visuals.push({ attr, kind: "coda" });
    else if (attr === "dalsegno") visuals.push({ attr, kind: "words", text: "D.S." + suffix });
    else if (attr === "dacapo") visuals.push({ attr, kind: "words", text: "D.C." + suffix });
    else if (attr === "tocoda") visuals.push({ attr, kind: "words", text: "To Coda" });
    else if (attr === "fine") visuals.push({ attr, kind: "words", text: "Fine" });
  }
  return visuals;
}

/**
 * Builds <direction-type><segno/> | <coda/> | <words>text</words></direction-type>.
 * `rightAligned` (bare-sound case only) sets justify="right" and
 * halign="right" on the words, so text anchored at the end of a
 * measure ends at the barline.
 */
function buildNavDirectionType(doc, visual, rightAligned = false) {
  const directionType = doc.createElement("direction-type");
  const content = doc.createElement(visual.kind);
  if (visual.kind === "words") {
    content.textContent = visual.text;
    if (rightAligned) {
      // Both are standard text-formatting attributes on <words>.
      // Verovio honors at most one of them; set both rather than
      // guess which.
      content.setAttribute("justify", "right");
      content.setAttribute("halign", "right");
    }
  }
  directionType.appendChild(content);
  return directionType;
}

/** <direction-type> children of `direction`, in order. */
function directionTypesOf(direction) {
  return Array.from(direction.children).filter((el) => el.tagName === "direction-type");
}

/**
 * Sound-inside-direction case: does this direction already show the
 * visual? Glyph marks need the matching glyph; textual marks are
 * satisfied by any <words> (the author wrote something next to the
 * sound — respect it).
 */
function directionHasNavVisual(direction, visual) {
  return directionTypesOf(direction).some((dt) =>
    Array.from(dt.children).some((el) => el.tagName === visual.kind)
  );
}

/**
 * Bare-sound case: does any <direction> in this measure already show
 * the visual? Glyph marks need the matching glyph; textual marks need
 * <words> in the same family (NAV_WORDS_FAMILY) — stricter than the
 * sound-inside-direction check, since here the words aren't tied to
 * the sound and could be unrelated text (an "rit." in the same
 * measure must not suppress a D.S.).
 */
function measureHasNavVisual(measure, visual) {
  const directions = Array.from(measure.children).filter((el) => el.tagName === "direction");
  return directions.some((direction) =>
    directionTypesOf(direction).some((dt) =>
      Array.from(dt.children).some((el) => {
        if (el.tagName !== visual.kind) return false;
        if (visual.kind !== "words") return true;
        const normalized = el.textContent.toLowerCase().replace(/[^a-z0-9]/g, "");
        return NAV_WORDS_FAMILY[visual.attr].test(normalized);
      })
    )
  );
}

/** Adds the visual as a new <direction-type> right after the direction's last existing one. */
function addNavVisualToDirection(doc, direction, visual) {
  const existing = directionTypesOf(direction);
  const last = existing[existing.length - 1];
  const newType = buildNavDirectionType(doc, visual);
  direction.insertBefore(newType, last ? last.nextSibling : direction.firstChild);
}

/**
 * Node to insert before so a new direction lands right after the
 * measure's last <note> (null = append). Verovio anchors a direction
 * placed after all the notes at the end of the measure. A measure
 * with no notes has no separate end, so it falls back to the header
 * insertion point.
 */
function endOfMeasureInsertionPoint(measure) {
  const notes = Array.from(measure.children).filter((el) => el.tagName === "note");
  if (notes.length === 0) return firstNonHeaderChild(measure);
  return notes[notes.length - 1].nextElementSibling;
}

/**
 * First child of `measure` past its leading header run of
 * attributes / print / sound / left-<barline>, or null if the whole
 * measure is header. New directions go right before this node, so
 * the leading run Verovio's StaffDef pre-pass sweeps over (see
 * insertMeasureRepeatStop) stays intact. A right <barline> stops the
 * run, so a note-less measure still gets its direction ahead of its
 * closing barline rather than after it.
 */
function firstNonHeaderChild(measure) {
  const headerTags = new Set(["attributes", "print", "sound"]);
  return (
    Array.from(measure.children).find((el) => {
      if (headerTags.has(el.tagName)) return false;
      if (el.tagName === "barline") return (el.getAttribute("location") || "right") !== "left";
      return true;
    }) || null
  );
}

/**
 * Pulls composer, arranger, and rights/copyright text straight out of
 * <identification> — the same fields the fixers above leave alone,
 * since they're already stored the standard way. Used by main.js to
 * feed score-overlay.js, which stamps this text directly onto the
 * rendered SVG rather than relying on Verovio's own header/footer
 * conversion (see score-overlay.js for why).
 *
 * Never throws: unparseable or metadata-less input just yields nulls,
 * same as a normal "nothing to add" result from any fixer here.
 *
 * @param {string} xmlText
 * @returns {{composer: string|null, arranger: string|null, rights: string|null}}
 */
export function extractScoreMetadata(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  if (doc.getElementsByTagName("parsererror").length > 0) {
    return { composer: null, arranger: null, rights: null };
  }

  const creators = Array.from(doc.getElementsByTagName("creator"));
  const findCreator = (type) =>
    creators.find(
      (el) => (el.getAttribute("type") || "").trim().toLowerCase() === type
    );
  const composerEl = findCreator("composer");
  const arrangerEl = findCreator("arranger");
  const rightsEl = doc.getElementsByTagName("rights")[0];

  const composer = composerEl ? composerEl.textContent.trim() : "";
  const arranger = arrangerEl ? arrangerEl.textContent.trim() : "";
  const rights = rightsEl ? rightsEl.textContent.trim() : "";

  return {
    composer: composer || null,
    arranger: arranger || null,
    rights: rights || null,
  };
}
