/**
 * Verovio engraving engine wrapper.
 *
 * Loads Verovio WASM from jsDelivr and provides the application with a
 * small, stable API for loading MusicXML, updating engraving settings,
 * rendering pages, and determining an appropriate notation scale.
 */

const VEROVIO_VERSION = "5.2.0";
const VEROVIO_URL =
  `https://cdn.jsdelivr.net/npm/verovio@${VEROVIO_VERSION}/` +
  "dist/verovio-toolkit-wasm.js";

let verovioModule = null;
let toolkit = null;

const PAGE_SIZES_MM = {
  letter: { width: 215.9, height: 279.4 },
  a4: { width: 210, height: 297 },
  legal: { width: 215.9, height: 355.6 },
};

function mmToVerovio(mm) {
  return Math.round(mm * 10);
}

function getPageSize(settings) {
  const size = PAGE_SIZES_MM[settings.pageSize] || PAGE_SIZES_MM.letter;
  return {
    width: size.width,
    height: size.height,
  };
}

export async function initializeVerovio() {
  if (toolkit) return toolkit;

  if (!verovioModule) {
    const module = await import(VEROVIO_URL);
    verovioModule = await module.default();
  }

  toolkit = new verovioModule.toolkit();
  return toolkit;
}

export function getToolkit() {
  if (!toolkit) {
    throw new Error("Verovio has not been initialized.");
  }

  return toolkit;
}

function buildVerovioOptions(settings) {
  const page = getPageSize(settings);

  const marginTop = settings.marginTop ?? 10;
  const marginBottom = settings.marginBottom ?? 10;
  const marginLeft = settings.marginLeft ?? 10;
  const marginRight = settings.marginRight ?? 10;

  return {
    pageWidth: mmToVerovio(page.width),
    pageHeight: mmToVerovio(page.height),

    pageMarginTop: mmToVerovio(marginTop),
    pageMarginBottom: mmToVerovio(marginBottom),
    pageMarginLeft: mmToVerovio(marginLeft),
    pageMarginRight: mmToVerovio(marginRight),

    scale: Math.round(settings.notationScalePercent ?? 100),

    // We determine the notation scale ourselves. Verovio should not
    // subsequently shrink the finished page to make it fit.
    scaleToPageSize: false,

    // One musical system per page.
    systemMaxPerPage: 1,

    shrinkToFit: false,

    // Keep horizontal and vertical spacing predictable.
    spacingLinear: settings.spacingLinear ?? 0.25,
    spacingNonLinear: settings.spacingNonLinear ?? 0.6,

    // Allow Verovio to use the available system width rather than forcing
    // additional justification on the final system.
    minLastJustification: 0,

    // Let Verovio determine automatic system/page breaks.
    breaks: "auto",

    // Keep the requested page height rather than expanding it.
    adjustPageHeight: false,

    // SVG output in millimeters.
    mmOutput: true,

    // The application does not currently use Verovio-generated headers or
    // footers.
    header: "none",
    footer: "none",
  };
}

export async function loadMusicXML(musicXml, settings) {
  if (!toolkit) {
    await initializeVerovio();
  }

  toolkit.loadData(musicXml);
  toolkit.setOptions(buildVerovioOptions(settings));
  toolkit.redoLayout();

  return {
    pageCount: toolkit.getPageCount(),
  };
}

export function updateSettings(settings) {
  if (!toolkit) {
    throw new Error("No score is loaded yet.");
  }

  toolkit.setOptions(buildVerovioOptions(settings));
  toolkit.redoLayout();

  return {
    pageCount: toolkit.getPageCount(),
  };
}

export function renderPage(pageNumber) {
  if (!toolkit) {
    throw new Error("No score is loaded yet.");
  }

  return toolkit.renderToSVG(pageNumber);
}

export function getPageCount() {
  if (!toolkit) {
    throw new Error("No score is loaded yet.");
  }

  return toolkit.getPageCount();
}

export function findAutoFitScale(settings) {
  if (!toolkit) throw new Error("No score is loaded yet.");

  const baseOptions = buildVerovioOptions(settings);
  const targetHeight =
    baseOptions.pageHeight -
    baseOptions.pageMarginTop -
    baseOptions.pageMarginBottom;

  const viewBoxPattern =
    /viewBox="[\d\.\s\-]+ [\d\.\s\-]+ [\d\.\s\-]+ ([\d\.]+)"/;

  // The scale must be chosen before Verovio decides where to put system
  // breaks. A normal layout cannot answer that question: changing scale
  // changes horizontal measure widths, which changes the measures assigned to
  // each system, which changes the resulting pages.
  //
  // Instead, the fitting pass deliberately asks Verovio for ONE system
  // containing the entire score. With breaks="none", Verovio lays the music
  // out as one continuous system and automatically makes the page wide enough
  // for it. The system's vertical height is therefore determined by the
  // number of staves (and their vertical content), rather than by an arbitrary
  // set of measures that happened to be cast off onto a page first.
  //
  // Once the largest scale that fits vertically has been found, the final
  // layout is run normally with breaks="auto" and systemMaxPerPage: 1. At
  // that point Verovio can use the full page width to pack as many measures as
  // possible into each system at the already-established notation size.
  function fitsAtScale(candidateScale) {
    const options = {
      ...baseOptions,
      scale: Math.round(candidateScale),

      // Temporarily suppress system/page breaking. Verovio produces a single
      // system and expands the page width as necessary, letting us measure the
      // vertical cost of the complete staff stack before cast-off.
      //
      // Use a very tall temporary page and adjustPageHeight so the SVG height
      // becomes the actual content height rather than the configured page
      // height. Remove the page's vertical margins during this measurement;
      // they are accounted for in targetHeight above and are restored for the
      // final render.
      breaks: "none",
      pageHeight: 60000,
      pageMarginTop: 0,
      pageMarginBottom: 0,
      adjustPageHeight: true,
    };

    toolkit.setOptions(options);
    toolkit.redoLayout();

    const svg = toolkit.renderToSVG(1);
    const match = svg.match(viewBoxPattern);
    const height = match && match[1] ? parseFloat(match[1]) : 0;

    if (!height) return false;

    // Small safety margin against floating-point rounding at the edge.
    return height <= targetHeight * 0.995;
  }

  // Binary search the largest integer scale (1–200%) whose single-system
  // layout fits vertically inside the usable page area. This is deliberately
  // independent of the eventual horizontal system/page breaks.
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

  // Final real render at the verified-fitting scale. Restore normal
  // automatic system breaking so Verovio can pack the maximum number of
  // measures horizontally at this scale. shrinkToFit remains off: it should
  // never be needed because the scale was selected from the complete staff
  // stack before the cast-off was performed.
  const finalSettings = {
    ...settings,
    notationScalePercent: best,
  };

  toolkit.setOptions(buildVerovioOptions(finalSettings));
  toolkit.redoLayout();

  return {
    scale: best,
    pageCount: toolkit.getPageCount(),
  };
}
