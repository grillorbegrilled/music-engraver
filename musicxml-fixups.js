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
const FIXERS = [fixUnterminatedMeasureRepeats, fixZBuzzRollDirections,
               fixBassDrumNoteheads, fixCymbalNoteheads, fixAllRestMeasures,
               fixMissingComposerCredit];

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

    // Use the duration from the existing rest. All the notes are rests,
    // so preserve the duration of the first one as the measure duration.
    const firstNote = notes[0];

    const duration = Array.from(firstNote.children).find(
      (el) => el.tagName === "duration"
    );

    if (!duration) continue;

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
    newDuration.textContent = duration.textContent;
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
 * Missing composer credit workaround: with `header`/`footer` set to
 * "auto", Verovio builds the printed title/composer/etc. block from
 * MusicXML's <credit> elements — the page-layout data that says what
 * actually gets drawn on the page — not from <identification><creator>,
 * which is bibliographic/indexing metadata and isn't itself positioned
 * on the page. A file can have a perfectly correct
 * <creator type="composer"> and still print no composer line if there
 * is no <credit> whose <credit-type> is "composer" alongside it.
 *
 * This is a common gap in exported MusicXML: exporters that emit a
 * title/subtitle credit block sometimes still forget the matching
 * composer one, even though they got the semantic <creator> right.
 *
 * Fix: if <identification> has a non-empty <creator type="composer">
 * and no existing <credit> is typed "composer", add one. It's built
 * the way notation software conventionally builds it (Finale, Sibelius,
 * Dolet exports, etc.): right-justified, aligned to the top of the
 * page, positioned from the page's own layout metrics when given.
 *
 * Important: if a composer <credit> already exists, this is a no-op —
 * the file already stores the composer the way Verovio expects, and
 * the fixer won't touch or duplicate it.
 *
 * @param {Document} doc
 * @returns {number} 1 if a composer credit was added, 0 otherwise
 */
function fixMissingComposerCredit(doc) {
  const creators = Array.from(doc.getElementsByTagName("creator"));
  const composerCreator = creators.find(
    (el) => (el.getAttribute("type") || "").trim().toLowerCase() === "composer"
  );
  if (!composerCreator) return 0; // no composer metadata to work from

  const composerName = composerCreator.textContent.trim();
  if (!composerName) return 0;

  const creditTypes = Array.from(doc.getElementsByTagName("credit-type"));
  const hasComposerCredit = creditTypes.some(
    (el) => el.textContent.trim().toLowerCase() === "composer"
  );
  // Already stored the way Verovio expects — nothing to fix.
  if (hasComposerCredit) return 0;

  const root = doc.documentElement;

  // Position it the way exporters conventionally do: right-justified,
  // aligned to the top of the page. Pull actual page dimensions from
  // <defaults><page-layout> when present so it lands in the real
  // top-right corner instead of an arbitrary guessed position.
  let defaultX = null;
  let defaultY = null;
  const defaults = doc.getElementsByTagName("defaults")[0];
  const pageLayout = defaults
    ? defaults.getElementsByTagName("page-layout")[0]
    : null;
  if (pageLayout) {
    const pageWidth = parseFloat(
      getFirstChildText(pageLayout, "page-width")
    );
    const pageHeight = parseFloat(
      getFirstChildText(pageLayout, "page-height")
    );
    const pageMargins = pageLayout.getElementsByTagName("page-margins")[0];
    const rightMargin = pageMargins
      ? parseFloat(getFirstChildText(pageMargins, "right-margin"))
      : NaN;
    const topMargin = pageMargins
      ? parseFloat(getFirstChildText(pageMargins, "top-margin"))
      : NaN;
    if (!isNaN(pageWidth) && !isNaN(rightMargin)) defaultX = pageWidth - rightMargin;
    if (!isNaN(pageHeight) && !isNaN(topMargin)) defaultY = pageHeight - topMargin;
  }

  const credit = doc.createElement("credit");
  credit.setAttribute("page", "1");

  const creditType = doc.createElement("credit-type");
  creditType.textContent = "composer";
  credit.appendChild(creditType);

  const words = doc.createElement("credit-words");
  if (defaultX !== null) words.setAttribute("default-x", String(defaultX));
  if (defaultY !== null) words.setAttribute("default-y", String(defaultY));
  words.setAttribute("justify", "right");
  words.setAttribute("valign", "top");
  words.textContent = composerName;
  credit.appendChild(words);

  // <credit> is only legal as a direct child of <score-partwise> (or
  // <score-timewise>), after <defaults> and before <part-list>. Insert
  // it alongside any existing credits (right before the first one, so
  // it stacks with title/subtitle) or, failing that, right before
  // <part-list>.
  const rootChildren = Array.from(root.children);
  const firstCredit = rootChildren.find((el) => el.tagName === "credit");
  const partList = rootChildren.find((el) => el.tagName === "part-list");
  root.insertBefore(credit, firstCredit || partList || null);

  return 1;
}

/**
 * Returns the trimmed text content of the first direct child of
 * `parent` named `tagName`, or an empty string if there isn't one.
 */
function getFirstChildText(parent, tagName) {
  const child = Array.from(parent.children).find(
    (el) => el.tagName === tagName
  );
  return child ? child.textContent.trim() : "";
}
