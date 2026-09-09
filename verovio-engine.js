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
    scaleToPageSize: false,
    systemMaxPerPage: 1,
    shrinkToFit: false,
    justifyVertically: false,
    spacingLinear: settings.spacingLinear ?? 0.2,
    spacingNonLinear: settings.spacingNonLinear ?? 0.45,
    breaks: "auto",
    adjustPageHeight: false,
    mmOutput: true,
    header: "none",
    footer: "none",
  };
}

/**
 * Calculates the exact notation scale required for a single vertical system 
 * to fit within printable page bounds BEFORE line breaks are generated.
 *
 * Requires a score to already be loaded (loadScore must run first).
 */
export function findAutoFitScale(settings) {
  if (!toolkit) throw new Error("No score is loaded yet.");

  const baseOptions = buildVerovioOptions(settings);
  const printableHeight = baseOptions.pageHeight - baseOptions.pageMarginTop - baseOptions.pageMarginBottom;

  // 1. Measure the natural height of the system at 100% scale without page constraints
  const testOptions = {
    ...baseOptions,
    scale: 100,
    pageHeight: 60000,
    adjustPageHeight: true,
    shrinkToFit: false,
  };

  toolkit.setOptions(testOptions);
  toolkit.redoLayout();

  const svg = toolkit.renderToSVG(1);
  let targetScale = Math.round(settings.notationScalePercent);

  const viewBoxMatch = svg.match(/viewBox="[\d\.\s\-]+ [\d\.\s\-]+ [\d\.\s\-]+ ([\d\.]+)"/);

  if (viewBoxMatch && viewBoxMatch[1]) {
    const unscaledSystemHeight = parseFloat(viewBoxMatch[1]);

    // 2. Determine maximum scale factor that guarantees vertical fit
    if (unscaledSystemHeight > printableHeight) {
      const maxVertScale = Math.floor((printableHeight / unscaledSystemHeight) * 100);
      targetScale = Math.min(targetScale, maxVertScale);
    }
  }

  // 3. Perform layout pass at target scale so breaks optimize to full horizontal width
  const finalSettings = { ...settings, notationScalePercent: targetScale };
  toolkit.setOptions(buildVerovioOptions(finalSettings));
  toolkit.redoLayout();

  return {
    scale: targetScale,
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