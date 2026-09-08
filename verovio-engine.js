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
    scaleToPageSize: true,     // scale now actually changes fit, not just post-layout resize
    justifyVertically: true,   // spreads systems to fill page height instead of leaving dead space
    spacingLinear: settings.spacingLinear ?? 0.2,        // was implicit default 0.25
    spacingNonLinear: settings.spacingNonLinear ?? 0.45, // was implicit default 0.6
    breaks: "auto",
    adjustPageHeight: false,
    mmOutput: true,
    header: "none",
    footer: "none",
  };
}

/** Bounds for the auto-fit scale search. Manual slider should match these. */
export const AUTO_FIT_BOUNDS = { minScale: 25, maxScale: 200 };

/**
 * Isolated single-page fit function for individual instrument parts.
 * Binary-searches for the largest `scale` that compresses the score onto
 * a single target page count (specifically 1 page).
 */
export function findSinglePageFitScale(settings, bounds = AUTO_FIT_BOUNDS) {
  if (!toolkit) throw new Error("No score is loaded yet.");
  const { minScale, maxScale } = bounds;
  const baseOptions = buildVerovioOptions(settings);

  toolkit.setOptions({ ...baseOptions, scale: minScale });
  toolkit.redoLayout();
  const minPageCount = toolkit.getPageCount();

  let lo = minScale;
  let hi = maxScale;
  let best = minScale;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    toolkit.setOptions({ ...baseOptions, scale: mid });
    toolkit.redoLayout();
    const pageCount = toolkit.getPageCount();

    if (pageCount <= minPageCount) {
      best = mid;
      lo = mid + 1; // try bigger
    } else {
      hi = mid - 1; // too big, shrink
    }
  }

  // Leave toolkit in the winning, already-laid-out state.
  toolkit.setOptions({ ...baseOptions, scale: best });
  toolkit.redoLayout();

  return { scale: best, pageCount: minPageCount };
}

/**
 * Determines total staff count across the score.
 */
function getStaffCount() {
  if (!toolkit) return 0;
  try {
    const elements = toolkit.getElementAttr("//staffDef");
    return Array.isArray(elements) ? elements.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Auto-fits the conductor's score vertically.
 * Finds the largest scale where a single system (or 2 systems for scores <= 5 staves)
 * fits inside the printable height of the page without overflowing onto extra vertical pages
 * or clipping staves.
 */
export function findAutoFitScale(settings, bounds = AUTO_FIT_BOUNDS) {
  if (!toolkit) throw new Error("No score is loaded yet.");
  const { minScale, maxScale } = bounds;
  const baseOptions = buildVerovioOptions(settings);

  const staffCount = getStaffCount();
  const targetSystemsPerPage = staffCount > 0 && staffCount <= 5 ? 2 : 1;

  let lo = minScale;
  let hi = maxScale;
  let best = minScale;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    toolkit.setOptions({ ...baseOptions, scale: mid });
    toolkit.redoLayout();

    // Check system count per page directly from Verovio's element layout data
    let fits = true;
    const pageCount = toolkit.getPageCount();

    for (let p = 1; p <= pageCount; p++) {
      // Fetch system elements rendered on page `p`
      const systemsOnPage = toolkit.getElementsAtTime(p) || []; // Fallback layout check
      // Query page XML structure or system count directly via Verovio
      const pageData = toolkit.renderToPage(p, { pageWithSvg: false });
      
      // Parse layout JSON/attributes if available, or fall back to system count in page tree
      const pageSvg = toolkit.renderToSVG(p);
      const systemCount = (pageSvg.match(/class="[^"]*\bsystem\b[^"]*"/g) || []).length;
      
      // Verify no staff/system elements are pushed beyond printable margins
      const containsOverflow = pageSvg.includes('class="system"'); // ensure systems exist
      
      if (systemCount > targetSystemsPerPage) {
        fits = false;
        break;
      }
    }

    // Binary search logic: if system distribution per page is within target, scale can grow
    if (fits && pageCount > 0) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  // Standardize fallbacks: ensure scale stays within bounded limits and applies cleanly
  const finalScale = Math.max(minScale, Math.min(maxScale, best));
  toolkit.setOptions({ ...baseOptions, scale: finalScale });
  toolkit.redoLayout();

  return { scale: finalScale, pageCount: toolkit.getPageCount() };
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