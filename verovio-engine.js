// verovio-engine.js
//
// Thin wrapper around the Verovio WASM toolkit. Nothing in this file
// knows about the DOM or about app UI state — it only knows how to
// turn (MusicXML text + engraving settings) into SVG pages.
//
// Verovio is loaded from jsDelivr at runtime (not bundled), because this
// project has no build step. See README-spike.md for why.

import { preprocessMusicXml } from "./musicxml-fixups.js";

const VEROVIO_SCRIPT_URL =
  "https://cdn.jsdelivr.net/npm/verovio@6.3.0/dist/verovio-toolkit-wasm.js";

let scriptLoadPromise = null;
let toolkitReadyPromise = null;
let toolkit = null;

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

/**
 * Creates a brand-new, independent Verovio toolkit instance (its own
 * loaded score, its own options, its own layout). Used by
 * part-renderer.js so rendering parts never disturbs whatever the
 * on-screen preview has loaded in the shared getToolkit() instance.
 *
 * Awaits getToolkit() first, not just the script load: constructing
 * `new verovio.toolkit()` is only safe once the WASM runtime has
 * finished initializing, and getToolkit() is what wires that up. The
 * caller owns the returned instance and should call `.destroy()` on it
 * when done (smoke test: destroying a second instance leaves the main
 * one working).
 */
export async function createToolkitInstance() {
  await getToolkit();
  return new window.verovio.toolkit();
}

// --- Option translation --------------------------------------------------
// The app UI works in millimeters and plain percentages. Verovio's
// toolkit options are integers in "tenths of a millimeter" (its
// internal abstract unit — confirmed against the Verovio reference book:
// default pageHeight 2970 / pageWidth 2100 == A4 in tenths-of-mm).

export const MM_TO_VRV_UNIT = 10;

// Letter is the only page size this app supports. Simpler than a
// dictionary lookup with only one entry.
export const PAGE_SIZE_MM = { width: 215.9, height: 279.4 };

/**
 * Options common to every Verovio layout this app does — the full-score
 * preview and the per-part pages alike (plan §4.2). Anything that
 * differs between the two (systemMaxPerPage, minLastJustification,
 * justifyVertically, shrinkToFit) is deliberately NOT here; each caller
 * adds its own.
 *
 * @param {object} geometry
 * @param {number} geometry.widthMm   physical page width
 * @param {number} geometry.heightMm  physical page height
 * @param {number} geometry.marginTopMm
 * @param {number} geometry.marginBottomMm
 * @param {number} geometry.marginLeftMm
 * @param {number} geometry.marginRightMm
 * @param {number} geometry.scale  notation scale percent, e.g. 100
 * @param {number} [geometry.spacingLinear]
 * @param {number} [geometry.spacingNonLinear]
 */
export function buildSharedVerovioOptions(geometry) {
  return {
    pageWidth: Math.round(geometry.widthMm * MM_TO_VRV_UNIT),
    pageHeight: Math.round(geometry.heightMm * MM_TO_VRV_UNIT),
    pageMarginTop: Math.round(geometry.marginTopMm * MM_TO_VRV_UNIT),
    pageMarginBottom: Math.round(geometry.marginBottomMm * MM_TO_VRV_UNIT),
    pageMarginLeft: Math.round(geometry.marginLeftMm * MM_TO_VRV_UNIT),
    pageMarginRight: Math.round(geometry.marginRightMm * MM_TO_VRV_UNIT),
    scale: Math.round(geometry.scale),
    // Scale the whole rendered output down to fit the fixed physical page
    // size, independent of the "scale" (notation size) factor above. This
    // is what actually keeps staves from running off the bottom of the
    // page now that there's no auto-fit logic computing a safe scale for
    // you — you pick a notation size, and Verovio guarantees it lands on
    // the page rather than truncating.
    scaleToPageSize: true,
    spacingLinear: geometry.spacingLinear ?? 0.25,
    spacingNonLinear: geometry.spacingNonLinear ?? 0.6,
    breaks: "auto",
    adjustPageHeight: false,
    mmOutput: true,
    header: "auto",
    // Rights/copyright is stamped onto the rendered SVG directly by
    // score-overlay.js instead — see that file for why. "none" here
    // just makes sure Verovio doesn't also try (and, on this pinned
    // build, sometimes fail) to draw its own footer underneath ours.
    footer: "none",
    // Verovio's default "auto" only switches to the thick block bar for
    // runs longer than four measures; "block" always does (except for
    // single-measure rests). Plan §4.2.
    multiRestStyle: "block",
    // optional, thicker bar (default 2.0, range 0.5–6.0):
    // multiRestThickness: 3,
  };
}

/**
 * Full-score options (one system per page).
 *
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
    ...buildSharedVerovioOptions({
      widthMm,
      heightMm,
      marginTopMm: settings.marginTopMm,
      marginBottomMm: settings.marginBottomMm,
      marginLeftMm: settings.marginLeftMm,
      marginRightMm: settings.marginRightMm,
      scale: settings.notationScalePercent,
      spacingLinear: settings.spacingLinear,
      spacingNonLinear: settings.spacingNonLinear,
    }),
    // Keep each page to one system. Verovio's automatic system layout will
    // fit the system horizontally rather than truncating its staves.
    systemMaxPerPage: 1,
    shrinkToFit: false,
    justifyVertically: false,
    // systemMaxPerPage:1 means every system is "last on its page." Verovio
    // only justifies a last system if its natural width already reaches
    // minLastJustification (default 0.8 = 80%) of the page width. Force 0
    // so every system stretches to fill the page regardless.
    minLastJustification: 0,
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

  const patchedXmlText = preprocessMusicXml(musicXmlText);

  let loaded;
  try {
    loaded = tk.loadData(patchedXmlText);
  } catch (err) {
    throw new Error("Verovio could not parse this file's musical content.");
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

// Serif font stack for all generated SVG text — matches the stack
// score-overlay.js already uses for its stamped title/composer/credit
// text, so overlay text and Verovio-drawn text (titles, dynamics,
// tempo, lyrics, rehearsal marks, etc.) look consistent. `!important`
// because Verovio's own SVG output carries its own font-family via a
// mix of embedded <style> rules and per-element attributes at varying
// specificity — the only way to guarantee every <text> ends up serif
// is to outrank all of it, rather than assume which one wins.
const SERIF_FONT_STACK = '"Times New Roman", Georgia, serif';

/**
 * Injects a font-family override as the first child of the SVG root so
 * every <text> Verovio draws renders serif. Called on every raw SVG
 * string this app produces (full-score preview here, and part pages in
 * part-renderer.js) so the override lands regardless of which toolkit
 * instance rendered it.
 *
 * @param {string} svgMarkup - raw SVG string from tk.renderToSVG()
 * @returns {string}
 */
export function forceSerifFont(svgMarkup) {
  return svgMarkup.replace(
    /<svg[^>]*>/,
    (openTag) => `${openTag}<style>text{font-family:${SERIF_FONT_STACK} !important;}</style>`
  );
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
  return forceSerifFont(toolkit.renderToSVG(pageNumber));
}
