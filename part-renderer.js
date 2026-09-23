// part-renderer.js
//
// Turns extractParts()'s per-part MusicXML into rendered SVG pages on a
// fixed landscape-Letter layout, auto-fitting each part to one page
// whenever possible (plan §4).
//
// Owns its own Verovio toolkit instance for the life of one batch, so the
// on-screen preview's toolkit (verovio-engine.js getToolkit()) is never
// touched.
//
// SCOPE OF THIS VERSION (plan §9 step 8): layout options (§4.2), the
// two-tier auto-fit scale search (§4.3), and the batch driver. Stamping
// (§4.4 — title/composer on page 1, part name on every page) is step 9
// and needs score-overlay.js; `renderPartsToSvg` takes an optional
// `stampPage` callback so step 9 can plug in without touching the loop.
//
// Entry points:
//   renderPartsToSvg(parts, opts) -> [{ id, name, pages, pageCount, scale, fit }, ...]
//   fitPartToPages(tk, partXmlText) -> { pages, pageCount, scale, fit }
//   buildPartVerovioOptions(scale)

import {
  PAGE_SIZE_MM,
  buildSharedVerovioOptions,
  createToolkitInstance,
  forceSerifFont,
} from "./verovio-engine.js";

// Parts are ALWAYS landscape Letter — this does not follow the main
// score's orientation dropdown. PAGE_SIZE_MM is portrait, so swap.
export const PART_LAYOUT_MM = {
  widthMm: PAGE_SIZE_MM.height,
  heightMm: PAGE_SIZE_MM.width,
  marginTopMm: 12,
  marginBottomMm: 12,
  marginLeftMm: 25,
  marginRightMm: 25,
};

export const MIN_PART_SCALE = 25; // matches the sidebar slider's existing floor
export const MAX_PART_SCALE = 150;

/**
 * Verovio options for one part page at a given notation scale.
 *
 * Differs from the full-score options in three deliberate ways (plan
 * §4.2): several systems flow onto one page (no systemMaxPerPage:1),
 * the last system isn't force-justified (that override only existed to
 * counter systemMaxPerPage:1), and pages are vertically justified so a
 * short, rest-collapsed part doesn't leave the bottom half blank.
 *
 * systemMaxPerPage and minLastJustification are set to Verovio's own
 * defaults (0 = unlimited, 0.8) rather than omitted. The plan said
 * "omitted", but setOptions() is sticky on a toolkit instance, so being
 * explicit costs nothing and keeps this correct if an instance is ever
 * reused after a score-style layout.
 *
 * shrinkToFit is a cheap secondary safety net only; it is NOT what
 * guarantees the page count. That is the scale search below.
 *
 * @param {number} scale  notation scale percent (rounded to an integer)
 */
export function buildPartVerovioOptions(scale) {
  return {
    ...buildSharedVerovioOptions({ ...PART_LAYOUT_MM, scale }),
    systemMaxPerPage: 0,
    minLastJustification: 0.8,
    justifyVertically: true,
    shrinkToFit: true,
  };
}

/**
 * Page-count probe for one loaded part, memoised by scale.
 *
 * Every probe is a setOptions + redoLayout, the same cheap re-layout
 * path the on-screen slider uses; the XML is parsed once by the caller.
 * Memoising means tier 2 never re-lays-out a scale tier 1 already tried,
 * and `settleAt()` skips the final redoLayout when the toolkit is
 * already sitting at the chosen scale.
 */
function createLayoutProbe(tk) {
  const pageCounts = new Map(); // scale -> page count
  let current = null; // scale the toolkit is currently laid out at

  function layoutAt(scale) {
    if (current !== scale) {
      tk.setOptions(buildPartVerovioOptions(scale));
      tk.redoLayout();
      current = scale;
    }
  }

  return {
    pageCountAt(scale) {
      if (!pageCounts.has(scale)) {
        layoutAt(scale);
        pageCounts.set(scale, tk.getPageCount());
      }
      return pageCounts.get(scale);
    },
    /** Leaves the toolkit laid out at `scale` and returns its page count. */
    settleAt(scale) {
      layoutAt(scale);
      const n = tk.getPageCount();
      pageCounts.set(scale, n);
      return n;
    },
  };
}

/**
 * Largest integer scale in [low, high] whose page count is <= maxPages,
 * or null if even `low` needs more pages. Binary search is valid because
 * page count is monotonic non-increasing as scale decreases.
 */
function fitScaleForPageBudget(probe, maxPages, low = MIN_PART_SCALE, high = MAX_PART_SCALE) {
  let best = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (probe.pageCountAt(mid) <= maxPages) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * Loads one part into `tk` and finds its display scale (plan §4.3).
 *
 * Tier 1: the largest scale that fits on ONE page.
 * Tier 2: if even MIN_PART_SCALE needs more than one page, the largest
 *         scale that fits in TWO — so a genuinely long part gets two
 *         comfortable pages rather than one cramped page's floor scale.
 * Fallback: if two pages aren't enough even at MIN_PART_SCALE, render
 *         at MIN_PART_SCALE with however many pages that produces
 *         (plan §8, "extremely long, uncollapsed parts").
 *
 * @returns {{pages: string[], pageCount: number, scale: number,
 *            fit: "one-page"|"two-page"|"overflow"}}
 *   `fit` records which tier landed; the plan didn't ask for it but the
 *   review UI and the test page both want to know.
 * @throws {Error} if Verovio can't parse the part.
 */
export function fitPartToPages(tk, partXmlText) {
  // Set options before loading, same order loadScore() uses: the first
  // load then lays out at a sane geometry rather than Verovio's default.
  tk.setOptions(buildPartVerovioOptions(MAX_PART_SCALE));
  let loaded;
  try {
    loaded = tk.loadData(partXmlText);
  } catch (err) {
    throw new Error("Verovio could not parse this extracted part.");
  }
  if (!loaded) throw new Error("Verovio could not parse this extracted part.");

  // loadData() laid the part out at MAX_PART_SCALE; the probe's `current`
  // starts unset so its first probe re-lays-out explicitly rather than
  // trusting that.
  const probe = createLayoutProbe(tk);

  let fit = "one-page";
  let scale = fitScaleForPageBudget(probe, 1);
  if (scale === null) {
    fit = "two-page";
    scale = fitScaleForPageBudget(probe, 2);
    if (scale === null) {
      fit = "overflow";
      scale = MIN_PART_SCALE;
    }
  }

  const pageCount = probe.settleAt(scale);
  if (!pageCount || pageCount < 1) {
    throw new Error("The part loaded, but no pages of music were produced.");
  }
  const pages = [];
  for (let p = 1; p <= pageCount; p++) pages.push(forceSerifFont(tk.renderToSVG(p)));
  return { pages: restoreMultiRestRehearsals(pages, partXmlText), pageCount, scale, fit };
}

// --- Rehearsal marks over multi-measure rests -------------------------
//
// Verovio (6.3.0) does not draw a <rehearsal> that sits on the first
// measure of a <multiple-rest> run, even though part-extraction.js
// leaves it there in the right place (attributes/multiple-rest, then
// the rehearsal <direction>, then the rest). The same mark on any
// ordinary measure renders fine. Rather than guess at Verovio's
// internals, the missing box is drawn into the SVG after the fact,
// copying the geometry Verovio itself uses for a rehearsal box (see the
// constants). A measure that already has a Verovio-drawn <g class="reh">
// is left alone, so this becomes a no-op if a later Verovio fixes it.

const SVG_NS = "http://www.w3.org/2000/svg";

// Rehearsal-box geometry in Verovio's SVG units at staff-line spacing
// 180 (the value at every notation scale; scale is applied by the
// viewBox). Measured from Verovio's own boxes for letters A and C:
// box top sits 640 above the top staff line, 498 tall, baseline 370
// below the box top, 405px bold Times, centered on the measure's left
// edge.
const REH_BOX_TOP_ABOVE_STAFF = 640;
const REH_BOX_HEIGHT = 498;
const REH_BASELINE_BELOW_BOX_TOP = 370;
const REH_FONT_SIZE = 405;
const REH_BOX_PADDING = 150; // total left+right, so one capital ~ 440 wide
const REH_BOX_GAP = 60; // between two marks on the same measure

/**
 * Draws any rehearsal marks Verovio dropped over multi-measure rests.
 * Returns the pages unchanged if nothing is missing, or if the SVG
 * doesn't line up with the part (different number of multi-rests than
 * the XML has) — a wrong guess would be worse than a missing letter.
 *
 * @param {string[]} pages - SVG per page, from tk.renderToSVG()
 * @param {string} partXmlText - the part's MusicXML, as loaded
 * @returns {string[]}
 */
export function restoreMultiRestRehearsals(pages, partXmlText) {
  try {
    const expected = multiRestRehearsalLabels(partXmlText);
    if (!expected.some((labels) => labels.length > 0)) return pages;

    const parser = new DOMParser();
    const docs = pages.map((svg) => parser.parseFromString(svg, "image/svg+xml"));
    const perPage = docs.map(multiRestMeasures);
    const total = perPage.reduce((n, list) => n + list.length, 0);
    if (total !== expected.length) {
      console.warn(
        `[part-renderer] found ${total} multi-rest(s) in the SVG but ${expected.length} in the XML; ` +
          "rehearsal marks over multi-rests not restored."
      );
      return pages;
    }

    const serializer = new XMLSerializer();
    let runIndex = 0;
    return pages.map((svg, i) => {
      let changed = false;
      for (const measure of perPage[i]) {
        const labels = expected[runIndex++];
        if (labels.length === 0 || hasRehearsalBox(measure)) continue;
        if (drawRehearsalBoxes(docs[i], measure, labels)) changed = true;
      }
      return changed ? serializer.serializeToString(docs[i]) : svg;
    });
  } catch (err) {
    console.warn("[part-renderer] could not restore multi-rest rehearsal marks:", err);
    return pages;
  }
}

/**
 * For each measure of the part that carries <multiple-rest>, in score
 * order: the text of its start-of-measure rehearsal marks (possibly
 * none). One entry per multi-rest, matching multiRestMeasures().
 */
function multiRestRehearsalLabels(partXmlText) {
  const doc = new DOMParser().parseFromString(partXmlText, "application/xml");
  const runs = [];
  for (const measure of Array.from(doc.getElementsByTagName("measure"))) {
    if (measure.getElementsByTagName("multiple-rest").length === 0) continue;
    const kids = Array.from(measure.children);
    let lastNote = -1;
    kids.forEach((el, i) => {
      if (el.tagName === "note") lastNote = i;
    });
    const labels = [];
    kids.forEach((el, i) => {
      if (el.tagName !== "direction" || (lastNote >= 0 && i > lastNote)) return;
      for (const reh of Array.from(el.getElementsByTagName("rehearsal"))) {
        const text = reh.textContent.trim();
        if (text) labels.push(text);
      }
    });
    runs.push(labels);
  }
  return runs;
}

const hasClass = (el, name) => (el.getAttribute("class") || "").split(/\s+/).includes(name);

/** The <g class="measure"> of every multi-rest on a page, once each, in document order. */
function multiRestMeasures(svgDoc) {
  const measures = [];
  for (const g of Array.from(svgDoc.getElementsByTagName("g"))) {
    if (!hasClass(g, "multiRest")) continue;
    let node = g.parentNode;
    while (node && !(node.nodeType === 1 && hasClass(node, "measure"))) node = node.parentNode;
    if (node && !measures.includes(node)) measures.push(node);
  }
  return measures;
}

function hasRehearsalBox(measure) {
  return Array.from(measure.children).some((el) => el.tagName === "g" && hasClass(el, "reh"));
}

/** Rough width of a bold Times rehearsal label at REH_FONT_SIZE. */
function rehearsalTextWidth(label, k) {
  let w = 0;
  for (const ch of label) w += (/[A-Z]/.test(ch) ? 292 : /[0-9]/.test(ch) ? 202 : 200) * k;
  return w;
}

/**
 * Appends one boxed label per entry of `labels` to `measure`, centered
 * on the measure's left edge (side by side if there's more than one).
 * Returns false if the staff geometry can't be read.
 */
function drawRehearsalBoxes(svgDoc, measure, labels) {
  const staff = Array.from(measure.children).find((el) => el.tagName === "g" && hasClass(el, "staff"));
  if (!staff) return false;
  const lines = Array.from(staff.getElementsByTagName("path"))
    .map((path) => (path.getAttribute("d") || "").match(/^M\s*(-?[\d.]+)\s+(-?[\d.]+)/))
    .filter(Boolean)
    .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  if (lines.length < 2) return false;

  const left = lines[0].x;
  const top = lines[0].y;
  const spacing = lines[1].y - lines[0].y;
  const k = spacing > 0 ? spacing / 180 : 1;

  const widths = labels.map((label) => REH_BOX_PADDING * k + rehearsalTextWidth(label, k));
  const gap = REH_BOX_GAP * k;
  const totalWidth = widths.reduce((a, b) => a + b, 0) + gap * (labels.length - 1);

  const boxTop = Math.round(top - REH_BOX_TOP_ABOVE_STAFF * k);
  let x = left - totalWidth / 2;
  labels.forEach((label, i) => {
    const width = widths[i];
    measure.appendChild(buildRehearsalBox(svgDoc, label, x, boxTop, width, k));
    x += width + gap;
  });
  return true;
}

function buildRehearsalBox(svgDoc, label, x, boxTop, width, k) {
  const make = (tag, attrs) => {
    const el = svgDoc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, String(value));
    return el;
  };

  const g = make("g", { class: "reh" });
  g.appendChild(
    make("rect", {
      "stroke-width": Math.round(20 * k),
      stroke: "currentColor",
      "fill-opacity": 0,
      x: Math.round(x),
      y: boxTop,
      height: Math.round(REH_BOX_HEIGHT * k),
      width: Math.round(width),
    })
  );

  const text = make("text", {
    x: Math.round(x + width / 2),
    y: Math.round(boxTop + REH_BASELINE_BELOW_BOX_TOP * k),
    "text-anchor": "middle",
    "font-size": "0px",
    "font-family": "Times",
    "font-weight": "bold",
  });
  const rend = make("tspan", { class: "rend" });
  const inner = make("tspan", { class: "text" });
  const run = make("tspan", { "font-size": `${Math.round(REH_FONT_SIZE * k)}px` });
  run.textContent = label;
  inner.appendChild(run);
  rend.appendChild(inner);
  text.appendChild(rend);
  g.appendChild(text);
  return g;
}

/** Lets the browser paint (status text, progress) between heavy parts. */
function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Renders every extracted part to SVG pages using one dedicated toolkit
 * instance, disposed when the batch finishes (even on error).
 *
 * A part that fails to parse or lay out is logged with console.warn and
 * left out of the result — it never aborts the batch (plan §6.4 item 4).
 * Result order matches `parts` order (= <part-list> order).
 *
 * @param {Array<{id: string, name: string, xmlText: string}>} parts
 *   output of extractParts()
 * @param {object} [opts]
 * @param {(done: number, total: number, name: string) => void} [opts.onProgress]
 *   called just BEFORE each part is rendered, with `done` = parts already
 *   finished, so a status line can read "Preparing parts… (4 of 16: Alto Sax)"
 *   as `done + 1` of `total`.
 * @param {(svg: string, ctx: {part: object, pageNumber: number,
 *          pageCount: number}) => string} [opts.stampPage]
 *   optional per-page post-processor (step 9: title/composer on page 1,
 *   part name on every page). Receives and must return an SVG string.
 *   Runs after the scale is settled, so it never affects page counts.
 * @returns {Promise<Array<{id: string, name: string, pages: string[],
 *   pageCount: number, scale: number, fit: string}>>}
 */
export async function renderPartsToSvg(parts, opts = {}) {
  const { onProgress, stampPage } = opts;
  const results = [];
  const tk = await createToolkitInstance();
  try {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (onProgress) onProgress(i, parts.length, part.name);
      await yieldToBrowser();
      try {
        const fitted = fitPartToPages(tk, part.xmlText);
        const pages = stampPage
          ? fitted.pages.map((svg, idx) =>
              stampPage(svg, { part, pageNumber: idx + 1, pageCount: fitted.pageCount })
            )
          : fitted.pages;
        results.push({
          id: part.id,
          name: part.name,
          pages,
          pageCount: fitted.pageCount,
          scale: fitted.scale,
          fit: fitted.fit,
        });
      } catch (err) {
        console.warn(
          `Part "${part.name}" (${part.id}) skipped:`,
          err && err.message ? err.message : err
        );
      }
    }
  } finally {
    try {
      tk.destroy();
    } catch (err) {
      /* nothing useful to do if dispose itself fails */
    }
  }
  return results;
}
