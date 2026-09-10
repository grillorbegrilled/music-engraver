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
const FIXERS = [fixUnterminatedMeasureRepeats, fixZBuzzRollDirections, fixComposerArrangerCredit];

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
    const count = fixer(doc) || 0;
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
 * as the first element of `measure`. Reuses an existing leading
 * <attributes> element if the measure already starts with one, so
 * divisions/clef/key/etc. declared there are left untouched.
 */
function insertMeasureRepeatStop(doc, measure, key) {
  const firstChild = measure.firstElementChild;
  let attributes;

  if (firstChild && firstChild.tagName === "attributes") {
    attributes = firstChild;
  } else {
    attributes = doc.createElement("attributes");
    measure.insertBefore(attributes, firstChild);
  }

  const style = doc.createElement("measure-style");
  if (key !== "_default") style.setAttribute("number", key);

  const repeat = doc.createElement("measure-repeat");
  repeat.setAttribute("type", "stop");

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
 * Verovio import quirk: it only prints composer/arranger text on the
 * rendered page when it comes from a <credit> block with a matching
 * <credit-type> — the same mechanism it already uses for title and
 * subtitle (both present as <credit> in this file and both render
 * fine). Composer/arranger info stored only in
 * <identification><creator type="composer|arranger"> — which is
 * exactly how tools like Flat.io export it — is read into score
 * *metadata* but never makes it onto the page.
 *
 * Fix: pull the composer/arranger names out of <identification>,
 * delete those <creator> elements, and write a single new
 *   <credit>
 *     <credit-type>composer</credit-type>
 *     <credit-words>by {composer}\narr. {arranger}</credit-words>
 *   </credit>
 * in their place (inserted before <part-list>, alongside the other
 * credits, per the MusicXML element order). No default-x/default-y
 * is set — Verovio positions standard credit types (title, composer,
 * etc.) itself, and pinning coordinates here would just fight that.
 *
 * A missing composer or arranger degrades gracefully: whichever one
 * exists still gets its own line ("by ..." / "arr. ..."); if neither
 * exists there's nothing to do.
 *
 * @param {Document} doc
 * @returns {number} 1 if a composer/arranger credit was rewritten, 0 otherwise
 */
function fixComposerArrangerCredit(doc) {
  const identification = doc.getElementsByTagName("identification")[0];
  if (!identification) return 0;

  const creators = Array.from(identification.getElementsByTagName("creator"));
  const composer = creators.find((c) => (c.getAttribute("type") || "").toLowerCase() === "composer");
  const arranger = creators.find((c) => (c.getAttribute("type") || "").toLowerCase() === "arranger");
  if (!composer && !arranger) return 0; // nothing in the shape this fixer targets

  const lines = [];
  if (composer) lines.push(`by ${composer.textContent.trim()}`);
  if (arranger) lines.push(`arr. ${arranger.textContent.trim()}`);

  if (composer) identification.removeChild(composer);
  if (arranger) identification.removeChild(arranger);

  const credit = doc.createElement("credit");
  const creditType = doc.createElement("credit-type");
  creditType.textContent = "composer";
  const creditWords = doc.createElement("credit-words");
  creditWords.textContent = lines.join("\n");
  credit.appendChild(creditType);
  credit.appendChild(creditWords);

  // <credit>* comes right before <part-list> in score-partwise's
  // content model, after <identification>/<defaults> and any other
  // credits (title, subtitle, etc.) that are already there.
  const scorePartwise = doc.documentElement;
  const partList = scorePartwise.getElementsByTagName("part-list")[0];
  scorePartwise.insertBefore(credit, partList || null); // insertBefore(x, null) appends

  return 1;
}
