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
const FIXERS = [fixUnterminatedMeasureRepeats];

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
