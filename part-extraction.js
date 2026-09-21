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
// SCOPE OF THIS VERSION (plan §9 steps 5-7): splitting + header
// retention, §3.2 global-direction propagation (rehearsal letters,
// tempo, segno/coda/D.S./D.C./Fine that live on one part only), and
// §3.3 multi-measure-rest run collapsing. Everything works on the
// per-part Documents built here, which is why the split is written as
// "build one Document per part" and only serialized at the very end:
// propagation runs on each per-part Document right after it's built,
// then collapsing runs on the propagated result.
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
 * Runs of rest-only measures are then collapsed into multi-measure
 * rests (plan §3.3) — see collapseRestRuns(). Collapsing happens after
 * propagation, so it only ever has to deal with one case: a mark
 * sitting on an interior measure of a run, whether that mark was
 * original to the part or just propagated in.
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
  let collapsedRuns = 0;

  for (const { id, scorePart, part, position } of entries) {
    const partDoc = buildSinglePartDocument(doc, scorePart, part);
    propagated += propagateGlobalMarks(partDoc, id, marksByIndex);
    collapsedRuns += collapseRestRuns(partDoc); // must follow propagation (§3.3)
    results.push({
      id,
      name: partDisplayName(scorePart, position),
      xmlText: serializer.serializeToString(partDoc),
    });
  }

  if (propagated > 0) {
    console.info(`[part-extraction] propagated ${propagated} global mark(s) across ${results.length} part(s)`);
  }

  if (collapsedRuns > 0) {
    console.info(`[part-extraction] collapsed ${collapsedRuns} rest run(s) into multi-measure rests`);
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

// --- §3.3 Multi-measure-rest run collapsing --------------------------
//
// A part that sits out eight bars shouldn't spend eight bars of paper
// on it. MusicXML's encoding is tiny (plan §1): put
// <measure-style><multiple-rest>N</multiple-rest></measure-style> in the
// FIRST measure of the run and leave every measure's own rest note in
// place. Verovio does the collapsing; this module only decides where
// runs are and makes sure nothing meaningful is stranded inside one.

/** Runs shorter than this gain nothing from a multi-rest marking saying "1". */
const MIN_REST_RUN = 2;

/**
 * Bar styles that are structural section boundaries rather than
 * ordinary bars: double (light-light), final (light-heavy — a mid-piece
 * one is a Fine or the bar before a D.C./D.S., see plan §1), and the
 * two heavy-first forms. A multi-rest must never span one.
 */
const STRUCTURAL_BAR_STYLES = new Set(["light-light", "light-heavy", "heavy-light", "heavy-heavy"]);

/**
 * <attributes> children that change what a bar IS: meter, key, clef,
 * transposition, staff count. A measure carrying one can't fold into
 * the run before it — the bars would no longer be the same length /
 * in the same key, and the change itself would vanish. (Not in the
 * plan's boundary list; added because silently dropping a time
 * signature is worse than not collapsing. <divisions> is deliberately
 * absent: it changes how durations are written, not the music.)
 */
const NOTATION_STATE_TAGS = new Set(["time", "key", "clef", "transpose", "staves"]);

/**
 * Collapses every run of 2+ consecutive rest-only measures in the
 * part into a multi-measure rest, and relocates any marking that sat
 * on the interior of a run. Mutates `partDoc`; returns the number of
 * runs collapsed.
 *
 * This module owns multi-rest layout: any <multiple-rest> the source
 * already carried is recomputed rather than trusted (the source's run
 * may span a boundary this module refuses to cross, or stop short of
 * one it would happily span). That also makes the pass idempotent —
 * re-collapsing an already-collapsed part changes nothing.
 *
 * @param {Document} partDoc — single-part document from buildSinglePartDocument
 * @returns {number}
 */
function collapseRestRuns(partDoc) {
  const partEl = childElements(partDoc.documentElement, "part")[0];
  if (!partEl) return 0;

  const measures = childElements(partEl, "measure");
  const runs = findRestRuns(measures, findMeasureRepeatMeasures(measures));

  const inRun = new Set(runs.flat());
  for (const measure of measures) {
    if (!inRun.has(measure)) stripMultipleRest(measure); // stale marker from the source
  }
  for (const run of runs) applyRestRun(partDoc, run);

  return runs.length;
}

/**
 * Groups measures into runs of consecutive collapsible rest measures
 * (length >= MIN_REST_RUN only), split at hard boundaries and at
 * measures that change meter/key/clef. Measures drawn as measure
 * repeats (`repeatStyled`) are never collapsible: they break a run
 * just like a measure with notes in it.
 *
 * @param {Element[]} measures
 * @param {Set<Element>} repeatStyled — from findMeasureRepeatMeasures
 * @returns {Element[][]}
 */
function findRestRuns(measures, repeatStyled) {
  const runs = [];
  let run = [];
  const flush = () => {
    if (run.length >= MIN_REST_RUN) runs.push(run);
    run = [];
  };

  for (const measure of measures) {
    if (repeatStyled.has(measure) || !isCollapsibleRestMeasure(measure)) {
      flush();
      continue;
    }
    if (run.length > 0 && (isHardBoundary(run[run.length - 1], measure) || changesNotationState(measure))) {
      flush();
    }
    run.push(measure);
  }
  flush();

  return runs;
}

/**
 * The measures that are drawn as a measure-repeat symbol (the "%"
 * slash bar), whatever their written content is. That symbol takes
 * precedence over rest/not-rest: exporters (Flat, and this app's own
 * fixNumeralRepeatDirections) leave plain rests inside these measures,
 * so a rest-only test alone would happily fold them into a multi-rest
 * and the repeat symbol would vanish.
 *
 * <measure-repeat> is a STATE, not a per-measure marker: only the
 * measure carrying type="start" has it, and every following measure
 * inherits it until a type="stop" — or, unterminated (legal, and
 * exactly what fixUnterminatedMeasureRepeats worries about), to the
 * end of the part. State is tracked per staff (<measure-style
 * number="...">, "_default" when absent); a measure counts if ANY
 * staff has a repeat open, since a measure whose other staff is
 * resting isn't a plain rest either.
 *
 * Start and stop measures are both included. By the spec a stop
 * measure is the first one NOT displayed as a repeat, but
 * fixNumeralRepeatDirections puts its stop on the last measure of the
 * block, so the two encodings disagree and the stop measure can't be
 * classified reliably. Excluding it costs at most one bar of
 * collapsing; including it wrongly would eat a repeat symbol. A stop
 * with no matching open start (fixUnterminatedMeasureRepeats inserts
 * those as leak resets in a part's first bar) marks nothing.
 *
 * @param {Element[]} measures — one part's measures, in order
 * @returns {Set<Element>}
 */
function findMeasureRepeatMeasures(measures) {
  const styled = new Set();
  const open = new Set(); // staff keys with a repeat currently open

  for (const measure of measures) {
    let hit = open.size > 0; // inherited from an earlier start
    for (const style of Array.from(measure.getElementsByTagName("measure-style"))) {
      const repeat = childElements(style, "measure-repeat")[0];
      if (!repeat) continue;
      const key = style.getAttribute("number") || "_default";
      const type = repeat.getAttribute("type");
      if (type === "start") {
        open.add(key);
        hit = true;
      } else if (type === "stop") {
        if (open.has(key)) hit = true; // the stop bar itself: see above
        open.delete(key);
      }
    }
    if (hit) styled.add(measure);
  }

  return styled;
}

/**
 * True if every <note> in the measure is a rest. Mirrors
 * fixAllRestMeasures()'s check, but deliberately NOT its single-voice
 * restriction: that fixer had to represent the measure as one note;
 * collapsing leaves note content alone, so two voices resting
 * together still fold fine. A measure with NO notes is not rest-only
 * (same conservative call as that fixer): it breaks a run.
 *
 * (Measure-repeat measures are excluded separately, by
 * findMeasureRepeatMeasures — that needs cross-measure state.)
 *
 * Also refuses, so nothing real is dropped from the drawn page:
 *   - <harmony> / <figured-bass> (chord symbols over rests are content)
 *   - implicit="yes" measures (pickups / split bars aren't full bars)
 * Cue notes and anything else pitched already fail the every-rest test.
 */
function isCollapsibleRestMeasure(measure) {
  const notes = childElements(measure, "note");
  if (notes.length === 0) return false;
  if (!notes.every((note) => childElements(note, "rest").length > 0)) return false;
  if (measure.getAttribute("implicit") === "yes") return false;
  if (childElements(measure, "harmony").length > 0) return false;
  if (childElements(measure, "figured-bass").length > 0) return false;
  return true;
}

/** True if `measure` has an <attributes> child carrying a NOTATION_STATE_TAGS element. */
function changesNotationState(measure) {
  return childElements(measure, "attributes").some((attrs) =>
    Array.from(attrs.children).some((el) => NOTATION_STATE_TAGS.has(el.tagName))
  );
}

/**
 * True if the barline of `measure` at `location` ("left" | "right";
 * an absent location attribute means right, per the spec) is a hard
 * boundary: a structural bar style, a repeat, a volta <ending>, or a
 * barline-attached <segno>/<coda>. The last two aren't in the plan's
 * list; a volta bracket or sign stranded inside a collapsed run would
 * simply not be drawn.
 */
function hasHardBarline(measure, location) {
  return childElements(measure, "barline")
    .filter((b) => (b.getAttribute("location") || "right") === location)
    .some((barline) => {
      const style = childElements(barline, "bar-style")[0];
      const styleText = style ? style.textContent.trim() : "";
      return (
        STRUCTURAL_BAR_STYLES.has(styleText) ||
        childElements(barline, "repeat").length > 0 ||
        childElements(barline, "ending").length > 0 ||
        childElements(barline, "segno").length > 0 ||
        childElements(barline, "coda").length > 0
      );
    });
}

/** The gap between two adjacent measures is hard if either barline touching it is. */
function isHardBoundary(measureBefore, measureAfter) {
  return hasHardBarline(measureBefore, "right") || hasHardBarline(measureAfter, "left");
}

/**
 * Applies one collapse: multi-rest marker on the first measure, and
 * every <direction>/<sound> on an interior measure moved to whichever
 * edge of the run it's nearer.
 *
 * MusicXML can't say "this happens 3 bars into an 8-bar rest", so an
 * interior mark has nowhere to render once the bars visually merge:
 *   - run-relative index < N/2  -> start of `first`, immediately
 *     before its first <note> (so after the measure's own leading
 *     attributes/marks: chronological order is kept — what `first`
 *     already said comes before what moved in from later bars)
 *   - index >= N/2              -> end of `last`, immediately after its
 *     last <note>, ahead of any marks `last` already has after it
 *     (same chronological logic). Not "before the trailing barline":
 *     fixAllRestMeasures appends the collapsed rest AFTER a right
 *     <barline>, so "after the note" is the only end that's reliable
 *     (Verovio anchors on time position, not XML order relative to
 *     the barline).
 * Marks already on `first` or `last` stay put. Moves keep document
 * order, because each batch is inserted before one fixed reference node.
 */
function applyRestRun(partDoc, run) {
  const n = run.length;
  const first = run[0];
  const last = run[n - 1];

  setMultipleRest(partDoc, first, n);
  for (const interior of run.slice(1)) stripMultipleRest(interior);

  const toStart = [];
  const toEnd = [];
  run.forEach((measure, k) => {
    if (k === 0 || k === n - 1) return;
    const marks = Array.from(measure.children).filter(
      (el) => el.tagName === "direction" || el.tagName === "sound"
    );
    (k < n / 2 ? toStart : toEnd).push(...marks);
  });

  // Reference nodes are computed once, before anything moves, so each
  // batch keeps its order.
  const startPoint = childElements(first, "note")[0]; // exists: isCollapsibleRestMeasure guarantees a note
  const endPoint = endOfMeasureInsertionPoint(last); // null = append
  for (const mark of toStart) first.insertBefore(mark, startPoint);
  for (const mark of toEnd) last.insertBefore(mark, endPoint);
}

/**
 * Puts <measure-style><multiple-rest>N</multiple-rest></measure-style>
 * in `measure`, reusing a leading <attributes> (one in the header
 * block: before the first note/direction) when there is one, else
 * creating it at the end of the header block. An existing
 * <multiple-rest> is updated in place (keeps its use-symbols
 * attribute); extras are removed. measure-style comes last in
 * <attributes>' content model, so appending is schema-valid.
 * No `number` attribute: omitted means "all staves", right for a
 * multi-staff part resting on every staff.
 */
function setMultipleRest(partDoc, measure, count) {
  const existing = Array.from(measure.getElementsByTagName("multiple-rest"));
  if (existing.length > 0) {
    existing[0].textContent = String(count);
    for (const extra of existing.slice(1)) removeAndPrune(extra);
    return;
  }

  const boundary = firstNonHeaderChild(measure);
  let attributes = null;
  for (const el of Array.from(measure.children)) {
    if (el === boundary) break;
    if (el.tagName === "attributes") {
      attributes = el;
      break;
    }
  }
  if (!attributes) {
    attributes = partDoc.createElement("attributes");
    measure.insertBefore(attributes, boundary); // null = append
  }

  const style = partDoc.createElement("measure-style");
  const rest = partDoc.createElement("multiple-rest");
  rest.textContent = String(count);
  style.appendChild(rest);
  attributes.appendChild(style);
}

/** Removes every <multiple-rest> in `measure`, pruning wrappers it leaves empty. */
function stripMultipleRest(measure) {
  for (const el of Array.from(measure.getElementsByTagName("multiple-rest"))) removeAndPrune(el);
}

/** Removes `el`, then its <measure-style> and <attributes> parents if that left them childless. */
function removeAndPrune(el) {
  let parent = el.parentNode;
  parent.removeChild(el);
  while (parent && (parent.tagName === "measure-style" || parent.tagName === "attributes") && parent.children.length === 0) {
    const up = parent.parentNode;
    up.removeChild(parent);
    parent = up;
  }
}
