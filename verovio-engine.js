// verovio-engine.js
//
// Thin wrapper around the Verovio WASM toolkit. Nothing in this file
// knows about the DOM or about app UI state — it only knows how to
// turn (MusicXML text + engraving settings) into SVG pages.
//
// Verovio is loaded from jsDelivr at runtime (not bundled), because this
// project has no build step. See README-spike.md for why.

import { preprocessMusicXmlDetailed } from "./musicxml-fixups.js";
import { applyTwoMeasureRepeats } from "./mei-repeats.js";

const VEROVIO_SCRIPT_URL =
  "https://cdn.jsdelivr.net/npm/verovio@6.3.0/dist/verovio-toolkit-wasm.js";

let scriptLoadPromise = null;
let toolkitReadyPromise = null;
let toolkit = null;
// Multi-measure repeat blocks found while preprocessing the loaded score
// (see mei-repeats.js for why they're needed after import).
let repeatBlocks = [];
// Plain-text summary of the last MEI repeat pass (shown by the debug box).
let repeatReport = "";

/**
 * Injects the Verovio <script> tag once and resolves when the global
 * `verovio` object exists. Safe to call multiple times.
 */
function loadVerovioScript() {
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise((resolve, reject) => {
    if (window.verovio) {
      resolve(window.verovio);
      return;
    }
    const script = document.createElement("script");
    script.src = VEROVIO_SCRIPT_URL;
    script.onload = () => {
      if (window.verovio) {
        resolve(window.verovio);
      } else {
        reject(new Error("Verovio script loaded but window.verovio is missing."));
      }
    };
    script.onerror = () => {
      reject(new Error("Could not load the Verovio engraving engine from the CDN."));
    };
    document.head.appendChild(script);
  });

  return scriptLoadPromise;
}

/**
 * Resolves once a Verovio toolkit instance exists and its WASM runtime
 * has finished initializing. Only ever creates one instance.
 */
export function getToolkit() {
  if (toolkitReadyPromise) return toolkitReadyPromise;

  toolkitReadyPromise = loadVerovioScript().then((verovio) => {
    return new Promise((resolve, reject) => {
      try {
        verovio.module.onRuntimeInitialized = () => {
          toolkit = new verovio.toolkit();
          resolve(toolkit);
        };
      } catch (err) {
        reject(err);
      }
    });
  });

  return toolkitReadyPromise;
}

// --- Option translation --------------------------------------------------
// The app UI works in millimeters and plain percentages. Verovio's
// toolkit options are integers in "tenths of a millimeter" (its
// internal abstract unit — confirmed against the Verovio reference book:
// default pageHeight 2970 / pageWidth 2100 == A4 in tenths-of-mm).

const MM_TO_VRV_UNIT = 10;

// Letter is the only page size this app supports. Simpler than a
// dictionary lookup with only one entry.
export const PAGE_SIZE_MM = { width: 215.9, height: 279.4 };

/**
 * @param {object} settings
 * @param {"portrait"|"landscape"} settings.orientation
 * @param {number} settings.marginTopMm
 * @param {number} settings.marginBottomMm
 * @param {number} settings.marginLeftMm
 * @param {number} settings.marginRightMm
 * @param {number} settings.notationScalePercent  e.g. 100 = default size
 */
export function buildVerovioOptions(settings) {
  let widthMm = PAGE_SIZE_MM.width;
  let heightMm = PAGE_SIZE_MM.height;
  if (settings.orientation === "landscape") {
    [widthMm, heightMm] = [heightMm, widthMm];
  }

  return {
    pageWidth: Math.round(widthMm * MM_TO_VRV_UNIT),
    pageHeight: Math.round(heightMm * MM_TO_VRV_UNIT),
    pageMarginTop: Math.round(settings.marginTopMm * MM_TO_VRV_UNIT),
    pageMarginBottom: Math.round(settings.marginBottomMm * MM_TO_VRV_UNIT),
    pageMarginLeft: Math.round(settings.marginLeftMm * MM_TO_VRV_UNIT),
    pageMarginRight: Math.round(settings.marginRightMm * MM_TO_VRV_UNIT),
    scale: Math.round(settings.notationScalePercent),
    // Scale the whole rendered output down to fit the fixed physical page
    // size, independent of the "scale" (notation size) factor above. This
    // is what actually keeps staves from running off the bottom of the
    // page now that there's no auto-fit logic computing a safe scale for
    // you — you pick a notation size, and Verovio guarantees it lands on
    // the page rather than truncating.
    scaleToPageSize: true,
    // Keep each page to one system. Verovio's automatic system layout will
    // fit the system horizontally rather than truncating its staves.
    systemMaxPerPage: 1,
    shrinkToFit: false,
    justifyVertically: false,
    spacingLinear: settings.spacingLinear ?? 0.25,
    spacingNonLinear: settings.spacingNonLinear ?? 0.6,
    // systemMaxPerPage:1 means every system is "last on its page." Verovio
    // only justifies a last system if its natural width already reaches
    // minLastJustification (default 0.8 = 80%) of the page width. Force 0
    // so every system stretches to fill the page regardless.
    minLastJustification: 0,
    breaks: "auto",
    adjustPageHeight: false,
    mmOutput: true,
    header: "auto",
    // Rights/copyright is stamped onto the rendered SVG directly by
    // score-overlay.js instead — see that file for why. "none" here
    // just makes sure Verovio doesn't also try (and, on this pinned
    // build, sometimes fail) to draw its own footer underneath ours.
    footer: "none",
  };
}

/**
 * Loads MusicXML (or MEI, ABC, etc. — Verovio auto-detects) text into
 * the toolkit with the given engraving settings, and returns the
 * resulting page count. Throws a plain Error with a user-safe message
 * on failure — callers should not need to inspect internals.
 */
export async function loadScore(musicXmlText, settings) {
  const tk = await getToolkit();
  tk.setOptions(buildVerovioOptions(settings));

  const { xml: patchedXmlText, repeatBlocks: blocks } = preprocessMusicXmlDetailed(musicXmlText);
  repeatBlocks = blocks;

  let loaded;
  try {
    loaded = tk.loadData(patchedXmlText);
  } catch (err) {
    throw new Error("Verovio could not parse this file's musical content.");
  }

  // Verovio's MusicXML importer draws a 2-measure repeat as two separate
  // one-bar signs. Round-trip through MEI to turn those pairs into a real
  // <mRpt2/>. If anything goes wrong, fall back to the plain import.
  if (loaded) {
    loaded = applyTwoBarRepeatsViaMei(tk, patchedXmlText, repeatBlocks);
  }

  if (!loaded) {
    throw new Error(
      "This file doesn't look like valid MusicXML (or another format Verovio understands)."
    );
  }

  const pageCount = tk.getPageCount();
  if (!pageCount || pageCount < 1) {
    throw new Error("The file loaded, but no pages of music were produced.");
  }
  return pageCount;
}

/** Re-applies settings and re-runs layout on the already-loaded score. */
export function updateSettings(settings) {
  if (!toolkit) throw new Error("No score is loaded yet.");
  toolkit.setOptions(buildVerovioOptions(settings));
  toolkit.redoLayout();
  return toolkit.getPageCount();
}

/** Renders a single 1-indexed page to an SVG string. */
export function renderPage(pageNumber) {
  if (!toolkit) throw new Error("No score is loaded yet.");
  return toolkit.renderToSVG(pageNumber);
}

/** 2-/4-measure repeat blocks in the currently loaded score. */
export function getRepeatBlocks() {
  return repeatBlocks;
}


/**
 * Re-loads the toolkit from edited MEI so 2-measure repeats become
 * <mRpt2/>. Returns whether the toolkit ends up with a loaded score.
 * Never throws: on any failure the original MusicXML is loaded again.
 */
function applyTwoBarRepeatsViaMei(tk, musicXmlText, blocks) {
  const twoBar = blocks.filter((b) => b.count === 2);
  repeatReport = `2-bar blocks found: ${twoBar.length}`;
  if (twoBar.length === 0) return true;

  try {
    const mei = tk.getMEI({ removeIds: true });
    const result = applyTwoMeasureRepeats(mei, twoBar);
    repeatReport +=
      `; applied: ${result.applied.length}` +
      result.skipped.map((s) => `\n  skipped ${s.label}: ${s.reason}`).join("");
    if (result.applied.length === 0) return true; // nothing changed; keep as loaded
    if (tk.loadData(result.mei)) return true;
    repeatReport += "\n  edited MEI failed to load; fell back to plain import";
  } catch (err) {
    repeatReport += `\n  MEI step threw (${err.message}); fell back to plain import`;
  }
  return tk.loadData(musicXmlText);
}

/**
 * TEMP DEBUG (remove when the repeat work is done): compact text dump
 * of the MEI staves that hold repeat elements, plus the outcome of the
 * 2-bar MEI pass, for display on the page instead of the console.
 */
export function getRepeatDebugMei() {
  if (!toolkit) return "No score loaded.";
  const mei = toolkit.getMEI({ removeIds: true });
  const measures = mei.match(/<measure\b[\s\S]*?<\/measure>/g) || [];
  const count = (re) => (mei.match(re) || []).length;
  const header =
    `measures: ${measures.length}; ` +
    `mRpt: ${count(/<mRpt\b/g)}, mRpt2: ${count(/<mRpt2\b/g)}, ` +
    `mSpace: ${count(/<mSpace\b/g)}, multiRpt: ${count(/<multiRpt\b/g)}`;

  const repeatEl = /<(mRpt2?|mSpace|multiRpt)\b/;
  const lines = [header, repeatReport];
  measures.forEach((m, i) => {
    if (!repeatEl.test(m)) return;
    const staves = (m.match(/<staff\b[\s\S]*?<\/staff>/g) || []).filter((st) => repeatEl.test(st));
    const n = (/<measure\b[^>]*\bn="([^"]*)"/.exec(m) || [])[1] || String(i + 1);
    lines.push(`m${n} (#${i + 1}): ` + staves.map((st) => st.replace(/\s+/g, " ")).join(" "));
  });
  return lines.join("\n");
}
