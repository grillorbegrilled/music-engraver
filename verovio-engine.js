// verovio-engine.js
//
// Thin wrapper around the Verovio WASM toolkit. Nothing in this file
// knows about the DOM or about app UI state — it only knows how to
// turn (MusicXML text + engraving settings) into SVG pages.
//
// Verovio is loaded from jsDelivr at runtime (not bundled), because this
// project has no build step. See README-spike.md for why.

const VEROVIO_SCRIPT_URL =
  "https://cdn.jsdelivr.net/npm/verovio@5.2.0/dist/verovio-toolkit-wasm.js";

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

// --- Option translation --------------------------------------------------
// The app UI works in millimeters and plain percentages. Verovio's
// toolkit options are integers in "tenths of a millimeter" (its
// internal abstract unit — confirmed against the Verovio reference book:
// default pageHeight 2970 / pageWidth 2100 == A4 in tenths-of-mm).

const MM_TO_VRV_UNIT = 10;

export const PAGE_SIZES_MM = {
  letter: { width: 215.9, height: 279.4 },
  a4: { width: 210, height: 297 },
  legal: { width: 215.9, height: 355.6 },
};

/**
 * @param {object} settings
 * @param {"letter"|"a4"|"legal"} settings.pageSize
 * @param {"portrait"|"landscape"} settings.orientation
 * @param {number} settings.marginTopMm
 * @param {number} settings.marginBottomMm
 * @param {number} settings.marginLeftMm
 * @param {number} settings.marginRightMm
 * @param {number} settings.notationScalePercent  e.g. 100 = default size
 */
export function buildVerovioOptions(settings) {
  const size = PAGE_SIZES_MM[settings.pageSize] || PAGE_SIZES_MM.a4;
  let widthMm = size.width;
  let heightMm = size.height;
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
    // Do not use scaleToPageSize here. It can shrink the entire score to
    // minimize the number of pages, which is the opposite of the engraver
    // behavior we want. The score should keep its chosen notation size and
    // let Verovio create as many systems/pages as the page dimensions require.
    scaleToPageSize: false,
    // Keep each page to one system. Verovio's automatic system layout will
    // fit the system horizontally rather than truncating its staves.
    systemMaxPerPage: 1,
    // Never let Verovio's internal shrink-to-fit run. It rescales an
    // overflowing system's width along with its height, *after*
    // justification already stretched that system to fill the page — the
    // exact mechanism that was leaving ragged/empty margins. We derive the
    // right scale ourselves in findAutoFitScale, with real layouts, before
    // committing to a production render, so this is never needed as a
    // fallback and must stay off so it can't quietly override our result.
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
    header: "none",
    footer: "none",
  };
}

/**
 * Applies the automatic one-system-per-page layout and auto-calculates 
 * the maximum scale that fits the vertical page limits.
 *
 * Requires a score to already be loaded (loadScore must run first).
 */
export function findAutoFitScale(settings) {
  if (!toolkit) throw new Error("No score is loaded yet.");

  const targetHeight = buildVerovioOptions(settings).pageHeight;
  const viewBoxPattern = /viewBox="[\d\.\s\-]+ [\d\.\s\-]+ [\d\.\s\-]+ ([\d\.]+)"/;

  // Renders the WHOLE score at a candidate scale, using the real target
  // page height and shrinkToFit OFF, and checks whether every system
  // actually fits. This is the true final cast-off at that exact scale —
  // not an estimate borrowed from a different scale's layout — because
  // which measures land on which system shifts depending on scale, so a
  // number extrapolated from one layout doesn't reliably predict another.
  // Checking the real thing is the only way to be sure Verovio's internal
  // shrinkToFit (which quietly squashes width too, after justification
  // already ran) never has a reason to kick in later.
  function fitsAtScale(candidateScale) {
    const options = buildVerovioOptions({ ...settings, notationScalePercent: candidateScale });
    toolkit.setOptions(options);
    toolkit.redoLayout();
    const pageCount = toolkit.getPageCount();
    for (let page = 1; page <= pageCount; page++) {
      const svg = toolkit.renderToSVG(page);
      const match = svg.match(viewBoxPattern);
      const height = match && match[1] ? parseFloat(match[1]) : 0;
      // Small safety margin against floating-point rounding at the edge.
      if (height > targetHeight * 0.995) return false;
    }
    return true;
  }

  // Binary search the largest integer scale (1–200%) whose real layout
  // fits every page without needing any internal shrink.
  let lo = 1;
  let hi = 200;
  let best = 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fitsAtScale(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // Final real render at the verified-fitting scale. shrinkToFit is off
  // (see buildVerovioOptions) so nothing can silently override this result.
  const finalSettings = { ...settings, notationScalePercent: best };
  toolkit.setOptions(buildVerovioOptions(finalSettings));
  toolkit.redoLayout();

  return {
    scale: best,
    pageCount: toolkit.getPageCount(),
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

  let loaded;
  try {
    loaded = tk.loadData(musicXmlText);
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