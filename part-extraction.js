// part-extraction.js
//
// Splits one multi-part MusicXML score into N standalone, single-part
// MusicXML documents — one per <score-part> — so each instrumentalist's
// part can be engraved on its own.
//
// Pure text-in / text-out, same philosophy as musicxml-fixups.js: no
// Verovio, no app state, defensive no-ops on anything unexpected rather
// than guessing.
//
// SCOPE OF THIS VERSION (plan §9 step 5): splitting + header retention
// only. Two later steps add work inside this module, both downstream of
// the split:
//   - §3.2 global-direction propagation (rehearsal letters, tempo,
//     segno/D.S. that live on one part only)
//   - §3.3 multi-measure-rest run collapsing
// Both operate on the per-part documents built here, which is why the
// split is written as "build one Document per part" and only serialized
// at the very end — those steps will slot in between.
//
// Entry point: extractParts(fixedXmlText) -> [{ id, name, xmlText }, ...]

/**
 * Splits a fixed MusicXML score into one standalone document per part.
 *
 * Input must already have been through preprocessMusicXml() — this
 * module does not run fixers itself (see plan §3). Output order is
 * <part-list> order, which is also the order parts appear in the review
 * picker and the exported PDF.
 *
 * What each output document contains:
 *   - the root <score-partwise> element with its own attributes
 *     (version, any xmlns:* declarations), and the original DOCTYPE
 *   - every score-level header element that precedes <part-list>,
 *     copied wholesale: <work>, <movement-number>, <movement-title>,
 *     <identification>, <defaults>, <credit>. These drive the title/
 *     composer/rights that extractScoreMetadata() and Verovio's own
 *     header read, so extracted parts get the same treatment as the
 *     full score at zero extra code. Copying "everything that isn't
 *     <part-list> or <part>" rather than a fixed whitelist means any
 *     header element a future MusicXML version adds comes along too.
 *   - a <part-list> holding only this part's <score-part>, copied
 *     wholesale (keeps <score-instrument>/<midi-instrument>/
 *     <part-abbreviation>). Any <part-group> bracket entries are
 *     dropped: a bracket around one part, or a stop with no start,
 *     is meaningless and risks confusing the importer.
 *   - this part's <part> element, copied wholesale. That is what
 *     preserves clefs, transposition, staves, and all notation
 *     without this module having to understand any of it.
 *
 * Every <score-part> that has a matching <part> is extracted — no
 * exclusions. Skipped (with a console.warn, never a throw):
 *   - a <score-part> with no id attribute
 *   - a <score-part> whose id was already seen (duplicate id)
 *   - a <score-part> with no <part> carrying its id
 * A <part> with no matching <score-part> is an orphan and is ignored.
 *
 * Returns [] (with a warning) for anything that isn't a well-formed
 * <score-partwise> document, including <score-timewise>, which this
 * app doesn't otherwise handle.
 *
 * @param {string} fixedXmlText
 * @returns {Array<{id: string, name: string, xmlText: string}>}
 */
export function extractParts(fixedXmlText) {
  const doc = new DOMParser().parseFromString(fixedXmlText, "application/xml");

  if (doc.getElementsByTagName("parsererror").length > 0) {
    console.warn("[part-extraction] input is not well-formed XML; no parts extracted.");
    return [];
  }

  const root = doc.documentElement;
  if (!root || root.tagName !== "score-partwise") {
    console.warn(
      `[part-extraction] root element is <${root ? root.tagName : "none"}>, ` +
        "not <score-partwise>; no parts extracted."
    );
    return [];
  }

  const partList = childElements(root, "part-list")[0];
  if (!partList) {
    console.warn("[part-extraction] no <part-list>; no parts extracted.");
    return [];
  }

  // First <part> element per id. A duplicate <part id> is malformed; the
  // first one wins, matching how duplicate score-part ids are handled.
  const partsById = new Map();
  for (const part of childElements(root, "part")) {
    const id = part.getAttribute("id");
    if (id && !partsById.has(id)) partsById.set(id, part);
  }

  const serializer = new XMLSerializer();
  const results = [];
  const seenIds = new Set();

  childElements(partList, "score-part").forEach((scorePart, index) => {
    const id = scorePart.getAttribute("id");
    if (!id) {
      console.warn(`[part-extraction] <score-part> #${index + 1} has no id; skipped.`);
      return;
    }
    if (seenIds.has(id)) {
      console.warn(`[part-extraction] duplicate <score-part id="${id}">; skipped.`);
      return;
    }
    seenIds.add(id);

    const part = partsById.get(id);
    if (!part) {
      console.warn(`[part-extraction] <score-part id="${id}"> has no matching <part>; skipped.`);
      return;
    }

    const partDoc = buildSinglePartDocument(doc, scorePart, part);
    results.push({
      id,
      name: partDisplayName(scorePart, index + 1),
      xmlText: serializer.serializeToString(partDoc),
    });
  });

  return results;
}

// --- Helpers ---------------------------------------------------------

/**
 * Direct element children of `parent` with the given tag name. Unlike
 * getElementsByTagName this doesn't descend, which matters here: a
 * <part> has <measure>s full of nested elements, and <score-part> has
 * its own nested <part-name>, so only immediate children are wanted.
 */
function childElements(parent, tagName) {
  return Array.from(parent.children).filter((el) => el.tagName === tagName);
}

/**
 * Builds one new Document containing the score header plus a single
 * part. Nodes are imported (deep-copied) into the new document one
 * piece at a time, walking the source root's children in their original
 * order, so the output keeps the same element order as the input and
 * never clones the other parts' measures — for a 16-part score that's
 * the difference between copying the header + 1 part vs. header + 16
 * parts, sixteen times over.
 *
 * Non-element children of the root (whitespace, comments) are not
 * carried over; they carry no musical content.
 */
function buildSinglePartDocument(sourceDoc, scorePart, part) {
  const sourceRoot = sourceDoc.documentElement;
  const sourceDoctype = sourceDoc.doctype;
  const doctype = sourceDoctype
    ? sourceDoc.implementation.createDocumentType(
        sourceDoctype.name,
        sourceDoctype.publicId,
        sourceDoctype.systemId
      )
    : null;

  const partDoc = sourceDoc.implementation.createDocument(
    sourceRoot.namespaceURI,
    sourceRoot.tagName,
    doctype
  );

  // createDocument() makes a bare root. Swap in a shallow import of the
  // source root instead, so its attributes (version, namespace
  // declarations such as xmlns:xlink) come across exactly as authored.
  const newRoot = partDoc.importNode(sourceRoot, false);
  partDoc.replaceChild(newRoot, partDoc.documentElement);

  for (const child of Array.from(sourceRoot.children)) {
    if (child.tagName === "part") {
      if (child === part) newRoot.appendChild(partDoc.importNode(child, true));
    } else if (child.tagName === "part-list") {
      const reducedList = partDoc.importNode(child, false);
      reducedList.appendChild(partDoc.importNode(scorePart, true));
      newRoot.appendChild(reducedList);
    } else {
      newRoot.appendChild(partDoc.importNode(child, true));
    }
  }

  return partDoc;
}

/**
 * Display name for the review picker and the on-page part label: the
 * score-part's <part-name>, whitespace-collapsed. Falls back to
 * "Part N" (N = 1-based position in <part-list>) when the name is
 * missing or blank, so the picker never shows an empty entry.
 */
function partDisplayName(scorePart, position) {
  const nameEl = childElements(scorePart, "part-name")[0];
  const name = nameEl ? nameEl.textContent.replace(/\s+/g, " ").trim() : "";
  return name || `Part ${position}`;
}
