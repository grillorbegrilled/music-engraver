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
// SCOPE OF THIS VERSION (plan §9 steps 5-6): splitting + header
// retention, and §3.2 global-direction propagation (rehearsal letters,
// tempo, segno/coda/D.S./D.C./Fine that live on one part only). One
// later step still adds work inside this module:
//   - §3.3 multi-measure-rest run collapsing
// It operates on the per-part documents built here, which is why the
// split is written as "build one Document per part" and only serialized
// at the very end — propagation runs on each per-part Document right
// after it's built, and collapsing will slot in right after that.
//
// Entry point: extractParts(fixedXmlText) -> [{ id, name, xmlText }, ...]

import {
  NAV_ATTRS,
  NAV_WORDS_FAMILY,
  hasNavAttr,
  firstNonHeaderChild,
  endOfMeasureInsertionPoint,
} from "./musicxml-fixups.js";

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
 * Global marks (plan §1, §3.2) are then propagated into each part —
 * see propagateGlobalMarks(). This is why the output is not a pure
 * "subset" of the input: a part can gain directions that only its
 * siblings carried in the source.
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

  // Pass 1: decide which <score-part>s are extractable. Kept separate
  // from building the documents because propagation needs to read
  // EVERY extractable part's measures before any single part is built —
  // a global mark can live on any part, not just the first.
  const entries = [];
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
    entries.push({ id, scorePart, part, position: index + 1 });
  });

  const marksByIndex = collectGlobalMarksByMeasure(entries);

  // Pass 2: one document per part, propagation applied, then serialized.
  const serializer = new XMLSerializer();
  const results = [];
  let propagated = 0;

  for (const { id, scorePart, part, position } of entries) {
    const partDoc = buildSinglePartDocument(doc, scorePart, part);
    propagated += propagateGlobalMarks(partDoc, id, marksByIndex);
    results.push({
      id,
      name: partDisplayName(scorePart, position),
      xmlText: serializer.serializeToString(partDoc),
    });
  }

  if (propagated > 0) {
    console.info(`[part-extraction] propagated ${propagated} global mark(s) across ${results.length} part(s)`);
  }

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

// --- §3.2 Global-mark propagation ------------------------------------
//
// Some markings apply to the whole ensemble but are written on ONE part
// only (plan §1): rehearsal letters, tempo, segno/D.S. Extract a part
// as-is and they silently vanish. The functions below find them by
// structure (what an element contains or carries — never a text
// list), then clone them into every part that lacks them.

/** <direction-type> children that are ensemble-wide by nature. */
const GLOBAL_DIRECTION_TYPES = new Set(["rehearsal", "segno", "coda", "metronome"]);

/**
 * The spec's own `system` attribute on <direction>: "associated with a
 * system rather than the particular part where the element appears".
 * Honored if a file encodes it (plan §1); almost none do.
 */
const GLOBAL_SYSTEM_VALUES = new Set(["only-top", "also-top", "only-bottom", "also-bottom"]);

/**
 * <sound> attributes that make a sound global: tempo, plus every
 * navigation attribute fixSoundOnlyNavigationMarks() understands.
 */
const GLOBAL_SOUND_ATTRS = ["tempo", ...NAV_ATTRS];

/**
 * Visual-text navigation attributes: the ones a bare <sound> gets a
 * plain <words> direction for (segno/coda get glyph directions, which
 * are detectable on their own). See §2.1's "follow-up for §3.2".
 */
const NAV_WORDS_ATTRS = ["dalsegno", "dacapo", "tocoda", "fine"];

/**
 * Finds every global mark in every extractable part, keyed by measure
 * index. Reads all parts, not just the one being built: nothing in the
 * spec says global marks live on the first part.
 *
 * Measure counts should match across parts. If they don't, marks are
 * only collected (and later propagated) for the first N measures, N =
 * the shortest part — alignment of the overhanging measures would be a
 * guess, so it isn't attempted.
 *
 * Marks are deduped by signature per measure index, so a file that
 * already duplicates a marking across every part isn't doubled up.
 * `owners` records which parts already carry a mark, so a part never
 * gets a clone of something it has itself.
 *
 * @param {Array<{id: string, part: Element}>} entries
 * @returns {Array<Array<{signature: string, kind: string, node: Element,
 *   atEnd: boolean, owners: Set<string>}>>} index i = marks for measure i
 */
function collectGlobalMarksByMeasure(entries) {
  if (entries.length < 2) return []; // nothing to propagate between

  const measuresPerPart = entries.map((e) => childElements(e.part, "measure"));
  const counts = measuresPerPart.map((m) => m.length);
  const minCount = Math.min(...counts);
  const maxCount = Math.max(...counts);
  if (minCount !== maxCount) {
    console.warn(
      `[part-extraction] parts have differing measure counts (${minCount} to ${maxCount}); ` +
        `global marks propagate across the first ${minCount} measure(s) only.`
    );
  }

  const byIndex = Array.from({ length: minCount }, () => new Map());
  entries.forEach((entry, p) => {
    for (let i = 0; i < minCount; i++) {
      for (const mark of collectGlobalMarks(measuresPerPart[p][i])) {
        const seen = byIndex[i].get(mark.signature);
        if (seen) seen.owners.add(entry.id);
        else byIndex[i].set(mark.signature, { ...mark, owners: new Set([entry.id]) });
      }
    }
  });

  return byIndex.map((marks) => Array.from(marks.values()));
}

/**
 * Global marks in one <measure>, in document order. Three shapes:
 *
 *   - a <direction> that is global by content (isGlobalDirection)
 *   - a bare measure-level <sound> carrying a global attribute — the
 *     Flat shape, where playback data has no visual of its own
 *   - a plain <words> <direction> that is the synthesized visual for a
 *     bare <sound> in the same measure (D.S., D.C., To Coda, Fine).
 *     Structurally it's ordinary text; only its sibling <sound> says
 *     it's a navigation mark, hence the pairing (§2.1 follow-up). The
 *     sound and its visual are separate marks with separate
 *     signatures, so a part that has one but not the other gets just
 *     the missing half.
 *
 * `atEnd` records whether the mark sits after the measure's last
 * <note> in the source. fixSoundOnlyNavigationMarks() deliberately
 * puts text marks at the END of a measure (that's what makes Verovio
 * anchor them at the barline), so a clone must land in the same spot
 * in the target measure — cloning D.S. to the measure start would
 * draw it at the wrong end of the bar.
 */
function collectGlobalMarks(measure) {
  const kids = Array.from(measure.children);
  let lastNote = -1;
  kids.forEach((el, i) => {
    if (el.tagName === "note") lastNote = i;
  });
  const isAtEnd = (i) => lastNote >= 0 && i > lastNote;

  const marks = [];
  const wordsAttrsWanted = new Set();

  kids.forEach((el, i) => {
    if (el.tagName === "sound") {
      const attrs = globalSoundAttrs(el);
      if (attrs.length === 0) return;
      marks.push({ kind: "sound", node: el, signature: "sound|" + attrs.join(";"), atEnd: isAtEnd(i) });
      for (const name of NAV_WORDS_ATTRS) if (hasNavAttr(el, name)) wordsAttrsWanted.add(name);
    } else if (el.tagName === "direction" && isGlobalDirection(el)) {
      marks.push({ kind: "direction", node: el, signature: directionSignature(el), atEnd: isAtEnd(i) });
    }
  });

  if (wordsAttrsWanted.size > 0) {
    kids.forEach((el, i) => {
      if (el.tagName !== "direction" || isGlobalDirection(el)) return; // global ones are already marks
      if (!directionHasNavWords(el, wordsAttrsWanted)) return;
      marks.push({ kind: "direction", node: el, signature: directionSignature(el), atEnd: isAtEnd(i) });
    });
    // Paired visuals were appended after the loop; restore document order.
    marks.sort((a, b) => kids.indexOf(a.node) - kids.indexOf(b.node));
  }

  return marks;
}

/**
 * True if `direction` is global by what it contains or carries:
 * a <rehearsal>/<segno>/<coda>/<metronome> direction-type, a child
 * <sound> with a global attribute, or the spec's own `system`
 * attribute. Deliberately NOT text-based: plain <words> ("rit.",
 * "Swing") has nothing structural to key off, which is fine — accel./
 * rit. are hand-authored per part and need no propagation (§1).
 */
function isGlobalDirection(direction) {
  if (GLOBAL_SYSTEM_VALUES.has(direction.getAttribute("system"))) return true;
  if (childElements(direction, "sound").some((s) => globalSoundAttrs(s).length > 0)) return true;
  return directionContent(direction).some((el) => GLOBAL_DIRECTION_TYPES.has(el.tagName));
}

/** Content elements (<words>, <segno>, <rehearsal>, ...) of every <direction-type> in `direction`. */
function directionContent(direction) {
  return childElements(direction, "direction-type").flatMap((dt) => Array.from(dt.children));
}

/**
 * Does `direction` carry <words> that read as one of the wanted
 * navigation marks? Uses the same normalized patterns
 * (NAV_WORDS_FAMILY) fixSoundOnlyNavigationMarks() uses to decide a
 * mark is "already written out", so the two stay in agreement.
 */
function directionHasNavWords(direction, wantedAttrs) {
  return directionContent(direction).some((el) => {
    if (el.tagName !== "words") return false;
    const normalized = el.textContent.toLowerCase().replace(/[^a-z0-9]/g, "");
    return Array.from(wantedAttrs).some((attr) => NAV_WORDS_FAMILY[attr].test(normalized));
  });
}

/** "name=value" strings for `sound`'s global attributes, in a fixed order (so signatures are stable). */
function globalSoundAttrs(sound) {
  return GLOBAL_SOUND_ATTRS.filter((name) => hasNavAttr(sound, name)).map(
    (name) => `${name}=${sound.getAttribute(name).trim()}`
  );
}

/**
 * Identity of a direction for dedupe: its direction-type content, any
 * global sound attributes, and its `system` value. Placement, staff,
 * position attributes, and formatting are left out on purpose — two
 * "rehearsal A" directions are the same mark however they're styled.
 */
function directionSignature(direction) {
  const content = directionContent(direction).map(structuralSignature).join(",");
  const sounds = childElements(direction, "sound").flatMap(globalSoundAttrs).join(";");
  const system = direction.getAttribute("system") || "";
  return `direction|${content}|${sounds}|${system}`;
}

/** tag(children-or-text), attributes ignored. E.g. metronome(beat-unit(quarter),per-minute(80)). */
function structuralSignature(el) {
  const kids = Array.from(el.children);
  const inner = kids.length
    ? kids.map(structuralSignature).join(",")
    : el.textContent.replace(/\s+/g, " ").trim();
  return `${el.tagName}(${inner})`;
}

/**
 * Inserts into `partDoc`, at each measure index, every global mark that
 * some other part carries and this one doesn't. Runs before rest-run
 * collapsing (§3.3) so collapsing only ever meets one case — a mark on
 * an interior measure of a run — whether the mark was original to the
 * part or propagated in.
 *
 * Insertion spot follows the mark's source position: after the last
 * note in the source -> after the last note here; otherwise at the
 * measure's header-block boundary (after leading attributes/print/
 * sound, before the first real content — same convention as
 * addMeasureRepeatMarker()). Both spots are computed once per measure
 * so several marks in one measure keep their order. Known limit: a
 * mark mid-measure in the source (not at either edge) lands at the
 * start here; timing within a measure can't be mapped across parts
 * with different rhythms without guessing.
 *
 * @returns {number} number of marks inserted
 */
function propagateGlobalMarks(partDoc, partId, marksByIndex) {
  if (marksByIndex.length === 0) return 0;

  const partEl = childElements(partDoc.documentElement, "part")[0];
  const measures = childElements(partEl, "measure");

  let inserted = 0;
  for (let i = 0; i < marksByIndex.length && i < measures.length; i++) {
    const pending = marksByIndex[i].filter((mark) => !mark.owners.has(partId));
    if (pending.length === 0) continue;

    const target = measures[i];
    const startPoint = firstNonHeaderChild(target);
    const endPoint = endOfMeasureInsertionPoint(target);
    for (const mark of pending) {
      target.insertBefore(cloneMarkForPart(partDoc, mark), mark.atEnd ? endPoint : startPoint); // null = append
      inserted++;
    }
  }
  return inserted;
}

/**
 * Deep copy of a mark, made safe for a part that isn't its source:
 *   - <staff> and <voice> are dropped from directions. They name a
 *     staff/voice of the SOURCE part; the target may not have it (a
 *     piano's staff 2 mark going to a single-staff flute). Defaults to
 *     staff 1 — the top, where rehearsal letters and tempo belong.
 *   - a <sound> is cut down to its global attributes, with no
 *     children. Its other attributes (dynamics, pan, ...) are the
 *     source part's playback, and children like <midi-instrument>
 *     reference instrument ids that only exist in the source part.
 */
function cloneMarkForPart(partDoc, mark) {
  if (mark.kind === "sound") return sanitizeSound(partDoc.importNode(mark.node, false));

  const clone = partDoc.importNode(mark.node, true);
  for (const child of Array.from(clone.children)) {
    if (child.tagName === "staff" || child.tagName === "voice") clone.removeChild(child);
    else if (child.tagName === "sound") sanitizeSound(child);
  }
  return clone;
}

/** Strips a <sound> down to GLOBAL_SOUND_ATTRS, no children. Mutates and returns it. */
function sanitizeSound(sound) {
  for (const attr of Array.from(sound.attributes)) {
    if (!GLOBAL_SOUND_ATTRS.includes(attr.name)) sound.removeAttribute(attr.name);
  }
  while (sound.firstChild) sound.removeChild(sound.firstChild);
  return sound;
}
