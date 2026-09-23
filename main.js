// main.js
import { loadScore, updateSettings, renderPage, PAGE_SIZE_MM } from "./verovio-engine.js";
import { extractScoreMetadata, preprocessMusicXml } from "./musicxml-fixups.js";
import { stampScoreMetadata, stampPartName, getPageGeometry } from "./score-overlay.js";
import { extractParts } from "./part-extraction.js";
import { renderPartsToSvg, PART_LAYOUT_MM } from "./part-renderer.js";

// -- element references ----------------------------------------------------

const fileInput = document.getElementById("file-input");
const exportScopeEl = document.getElementById("export-scope");
const exportPdfBtn = document.getElementById("export-pdf-btn");
const viewingSelect = document.getElementById("viewing-select");
const scoreArea = document.getElementById("score-area");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");

const orientationEl = document.getElementById("orientation");
const scaleEl = document.getElementById("scale");
const scaleValueEl = document.getElementById("scale-value");
const marginTopEl = document.getElementById("margin-top");
const marginBottomEl = document.getElementById("margin-bottom");
const marginLeftEl = document.getElementById("margin-left");
const marginRightEl = document.getElementById("margin-right");

// -- state -------------------------------------------------------------

let scoreIsLoaded = false;
let totalPages = 0;
let loadedFileName = "score";
// Composer/rights text pulled from the file at load time and stamped
// onto page 1's SVG by renderAllPages() — see score-overlay.js.
let currentMetadata = { composer: null, arranger: null, rights: null };

// Plan §6.2 state — parts are generated eagerly right after the score
// loads (§6.1), cached here, and read (never re-rendered) by both the
// review picker and exportPdf().
let currentFixedXmlText = null; // preprocessMusicXml() output, reused for extractParts()
let currentParts = []; // [{ id, name, pages: [svg, …], pageCount, scale, fit }, …]
let viewing = { kind: "score" }; // or { kind: "part", index: N }

function currentSettings() {
  return {
    orientation: orientationEl.value,
    notationScalePercent: Number(scaleEl.value),
    marginTopMm: Number(marginTopEl.value),
    marginBottomMm: Number(marginBottomEl.value),
    marginLeftMm: Number(marginLeftEl.value),
    marginRightMm: Number(marginRightEl.value),
  };
}

// -- status / error helpers ---------------------------------------------

function setStatus(text) {
  statusEl.textContent = text;
}

function showError(err, contextPrefix = "") {
  const message = err?.message || (typeof err === "string" ? err : "An unknown error occurred.");
  const stack = err?.stack || "";
  
  const formattedError = contextPrefix 
    ? `${contextPrefix}\n${message}${stack ? `\n\nStack Trace:\n${stack}` : ""}`
    : `${message}${stack ? `\n\nStack Trace:\n${stack}` : ""}`;

  errorEl.style.whiteSpace = "pre-wrap";
  errorEl.style.fontFamily = "monospace";
  errorEl.textContent = formattedError;
  errorEl.hidden = false;
  
  console.error(contextPrefix || "Error details:", err);
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

// -- rendering ------------------------------------------------------------

function renderAllPages(pageCount) {
  scoreArea.innerHTML = "";

  const settings = currentSettings();
  const layoutMm = {
    marginTopMm: settings.marginTopMm,
    marginRightMm: settings.marginRightMm,
    marginBottomMm: settings.marginBottomMm,
    marginLeftMm: settings.marginLeftMm,
  };

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const svgMarkup = renderPage(pageNumber);
    const pageEl = document.createElement("div");
    pageEl.className = "page";
    pageEl.innerHTML = svgMarkup;
    scoreArea.appendChild(pageEl);
    // Stamping needs real layout (getBBox/getCTM/getComputedTextLength),
    // which browsers only compute for elements connected to the
    // document — so this has to happen after appendChild, not before.
    stampScoreMetadata(pageEl.querySelector("svg"), currentMetadata, {
      ...layoutMm,
      isFirstPage: pageNumber === 1,
    });
  }
}

/**
 * Displays one already-rendered, already-stamped part's cached pages.
 * No Verovio work here — that all happened in generateParts(); this
 * just swaps what scoreArea shows (plan §6.3: "no re-render, just
 * display").
 */
function renderPartPages(part) {
  scoreArea.innerHTML = "";
  part.pages.forEach((svgMarkup) => {
    const pageEl = document.createElement("div");
    pageEl.className = "page";
    pageEl.innerHTML = svgMarkup;
    scoreArea.appendChild(pageEl);
  });
}

/** Redraws scoreArea from whatever `viewing` currently points at. */
function renderViewing() {
  if (viewing.kind === "part") {
    const part = currentParts[viewing.index];
    if (part) {
      renderPartPages(part);
      return;
    }
    // Part index no longer valid (e.g. a reload wiped currentParts) —
    // fall back to the score rather than showing a stale/empty area.
    viewing = { kind: "score" };
    viewingSelect.value = "score";
  }
  renderAllPages(totalPages);
}

// -- part generation (plan §6.1, §6.4 step 10) -----------------------------

// -- part-page stamping sandbox -------------------------------------------
//
// stampScoreMetadata/stampPartName both need the SVG connected to the live
// document — getBBox/getCTM/getComputedTextLength only compute real layout
// for connected elements (score-overlay.js's own header comment).
//
// Two things went wrong with the last version of this sandbox, in order:
//
// 1. `div.innerHTML = svgString` appended straight into `document.body`
//    (no `.page` class) sat inside this app's styles.css cascade in some
//    unpredictable way — different CSS treatment than the `.page` divs
//    real pages render in, so getPageGeometry()'s width/height came back
//    off, and every font-size/position derived from it went with it
//    (too-big, mispositioned part name; composer/rights landing somewhere
//    off-page).
// 2. The fix for that swapped to a shadow root + DOMParser's XML parser
//    (matching part-renderer-test.html, a bare page with no other
//    stylesheet, where the same stamp code measured correctly) — that
//    made sizing *worse*, not better, and dropped parts from the picker
//    entirely. Two likely culprits: shadow-isolating removed styles.css
//    from the sandbox's `<svg>` entirely rather than matching real pages'
//    context, so its rect came back at a different (larger, unconstrained)
//    size than a `.page`-classed one does — the fallback math in
//    stampScoreMetadata/stampPartName scales with that rect, so a bigger
//    rect means a bigger (still-wrong) result either way. And
//    `DOMParser(..., "image/svg+xml")` parses in *strict* XML mode: if
//    Verovio's SVG uses `xlink:href` without also declaring
//    `xmlns:xlink` on the root (plausible — prepareStandaloneSvgString()
//    below adds that namespace explicitly before cloning for PDF export,
//    which only makes sense if the original element needs it), that's a
//    well-formedness error under strict XML parsing and DOMParser returns
//    a `<parsererror>` document instead of throwing — silently failing
//    every part, which is exactly "picker only shows Full Score."
//    innerHTML's HTML parser tolerates this (it has a built-in fixup for
//    known prefixed attributes like xlink:href regardless of whether
//    xmlns:xlink was declared), which is why score pages — inserted the
//    same innerHTML way — never showed this problem.
//
// Fix: back to innerHTML (proven — it's exactly how renderAllPages()
// already inserts every score page), but give the sandbox the same
// `page` class real pages render in, as a real (offscreen) child of
// #score-area, so any styles.css rule scoped to `.page`/`#score-area
// .page` treats it identically to a real page instead of guessing at
// what, if anything, needs to be matched or isolated.
// Mounts an SVG string as a real, offscreen `.page`-classed child of
// #score-area — same CSS context real pages get, minus visibility — and
// returns the connected <svg> element plus a cleanup function. Shared by
// stampPartPage() (needs live layout to stamp) and exportPdf() (needs live
// layout to rasterize both score and part pages regardless of which one,
// if either, is currently on screen).
function mountSandboxPage(svgMarkup) {
  const sandbox = document.createElement("div");
  sandbox.className = "page";
  sandbox.style.position = "absolute";
  sandbox.style.left = "-99999px";
  sandbox.style.top = "0";
  sandbox.setAttribute("aria-hidden", "true");
  sandbox.innerHTML = svgMarkup;
  scoreArea.appendChild(sandbox);
  return { svgEl: sandbox.querySelector("svg"), remove: () => sandbox.remove() };
}

function stampPartPage(svgString, { part, pageNumber }) {
  const { svgEl, remove } = mountSandboxPage(svgString);
  if (!svgEl) {
    console.warn(`Couldn't find rendered <svg> for part "${part.name}", page ${pageNumber} — left unstamped.`);
    remove();
    return svgString;
  }
  try {
    stampScoreMetadata(svgEl, currentMetadata, {
      marginTopMm: PART_LAYOUT_MM.marginTopMm,
      marginRightMm: PART_LAYOUT_MM.marginRightMm,
      marginBottomMm: PART_LAYOUT_MM.marginBottomMm,
      marginLeftMm: PART_LAYOUT_MM.marginLeftMm,
      isFirstPage: pageNumber === 1,
    });
    stampPartName(svgEl, part.name, {
      marginTopMm: PART_LAYOUT_MM.marginTopMm,
      marginLeftMm: PART_LAYOUT_MM.marginLeftMm,
    });
    return new XMLSerializer().serializeToString(svgEl);
  } finally {
    remove();
  }
}

/** Rebuilds the "Viewing:" selector — Full Score plus one entry per part, in `<part-list>` order (plan §6.3). */
function populateViewingSelect(parts) {
  viewingSelect.innerHTML = "";
  const scoreOpt = document.createElement("option");
  scoreOpt.value = "score";
  scoreOpt.textContent = "Full Score";
  viewingSelect.appendChild(scoreOpt);
  parts.forEach((part, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = part.name;
    viewingSelect.appendChild(opt);
  });
  viewingSelect.disabled = false;
  viewingSelect.value = "score";
}

/**
 * Eager part generation (plan §6.1): runs right after the score itself
 * is loaded and displayed, so the user can review every part before
 * ever hitting Export PDF. Never blocks or breaks the already-shown
 * score — a failure here is logged and leaves the picker at "Full
 * Score only" rather than surfacing as a page-level error.
 */
async function generateParts(fixedXmlText) {
  currentParts = [];
  viewingSelect.innerHTML = "";
  const preparingOpt = document.createElement("option");
  preparingOpt.textContent = "Preparing parts…";
  viewingSelect.appendChild(preparingOpt);
  viewingSelect.disabled = true;

  try {
    const parts = extractParts(fixedXmlText);
    if (parts.length === 0) {
      populateViewingSelect([]);
      return;
    }

    const rendered = await renderPartsToSvg(parts, {
      onProgress: (done, total, name) => {
        setStatus(`Preparing parts… (${done + 1} of ${total}: ${name})`);
      },
      stampPage: stampPartPage,
    });

    currentParts = rendered;
    populateViewingSelect(currentParts);
    const partCount = currentParts.length;
    setStatus(
      `${loadedFileName} — ${totalPages} page${totalPages === 1 ? "" : "s"}, ` +
        `${partCount} part${partCount === 1 ? "" : "s"} ready`
    );
  } catch (err) {
    console.error("Part generation failed:", err);
    populateViewingSelect([]);
    setStatus(
      `${loadedFileName} — ${totalPages} page${totalPages === 1 ? "" : "s"} ` +
        `(parts unavailable: ${err?.message || err})`
    );
  }
}

viewingSelect.addEventListener("change", () => {
  const value = viewingSelect.value;
  if (value === "score") {
    viewing = { kind: "score" };
  } else {
    viewing = { kind: "part", index: Number(value) };
  }
  renderViewing();
});

// -- file handling ----------------------------------------------------

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Couldn't read that file from disk."));
    reader.readAsText(file);
  });
}

async function handleFile(file) {
  clearError();

  if (/\.mxl$/i.test(file.name)) {
    showError(
      "Compressed MusicXML (.mxl) isn't supported yet in this preview build. " +
        "Export as uncompressed MusicXML (.xml or .musicxml) and try again."
    );
    return;
  }

  setStatus(`Engraving “${file.name}”…`);
  try {
    const text = await readFileAsText(file);
    currentFixedXmlText = preprocessMusicXml(text); // NEW — reused by extractParts()
    currentMetadata = extractScoreMetadata(text);
    totalPages = await loadScore(text, currentSettings());
    // loadScore() re-fixes internally too — harmless no-op per
    // preprocessMusicXml's own idempotency guarantee (plan §6.2).
    viewing = { kind: "score" }; // NEW — reset the picker on every new file
    renderAllPages(totalPages);
    scoreIsLoaded = true;
    loadedFileName = file.name.replace(/\.[^/.]+$/, "");
    exportPdfBtn.disabled = false;
    setStatus(`${file.name} — ${totalPages} page${totalPages === 1 ? "" : "s"}`);

    // NEW — eager part generation (plan §6.1). Score is already
    // displayed above; this runs after, so it never delays first paint.
    await generateParts(currentFixedXmlText);
  } catch (err) {
    scoreIsLoaded = false;
    exportPdfBtn.disabled = true;
    currentParts = [];
    populateViewingSelect([]);
    viewingSelect.disabled = true;
    showError(err, "Something went wrong while engraving this file:");
    setStatus("");
  }
}

// -- Memory & Async Helpers -----------------------------------------------

function yieldToMainThread() {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

/**
 * Creates a fully standalone, valid SVG string with explicit dimensions and namespace
 */
function prepareStandaloneSvgString(svgElement, targetWidthPx, targetHeightPx) {
  // Read the coordinate space off the ORIGINAL, still-connected svgElement,
  // before cloning/detaching it — getPageGeometry (score-overlay.js) needs
  // real layout (getBoundingClientRect) for its no-viewBox fallback, and a
  // detached clone reports a zero-size rect. This app's Verovio output has
  // no viewBox, so its width/height attributes are physical mm print sizes,
  // not the content's coordinate-space size (see getPageGeometry's own
  // comment) — parsing them directly, as this used to do, builds a viewBox
  // that doesn't match the space stampScoreMetadata actually placed the
  // composer/rights text in, so that text renders outside it and vanishes
  // from the exported PDF while the on-screen SVG still shows it fine.
  // Reusing getPageGeometry keeps this in one place instead of two
  // independently-wrong copies of the same coordinate math.
  const { width: nativeWidth, height: nativeHeight } = getPageGeometry(svgElement);

  const clone = svgElement.cloneNode(true);

  // Ensure standard SVG XML namespace attributes exist
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");

  // Explicitly set absolute pixel dimensions on the SVG element
  clone.setAttribute("width", `${targetWidthPx}px`);
  clone.setAttribute("height", `${targetHeightPx}px`);

  if (!clone.getAttribute("viewBox") && nativeWidth && nativeHeight) {
    clone.setAttribute("viewBox", `0 0 ${nativeWidth} ${nativeHeight}`);
  }

  return new XMLSerializer().serializeToString(clone);
}

function renderSvgToCanvas(svgElement, canvas, widthPx, heightPx) {
  return new Promise((resolve, reject) => {
    const ctx = canvas.getContext("2d");
    const svgString = prepareStandaloneSvgString(svgElement, widthPx, heightPx);
    
    // Encode as Base64 Data URI to prevent cross-origin and font resolution issues
    const encodedSvg = unescape(encodeURIComponent(svgString));
    const dataUrl = "data:image/svg+xml;base64," + btoa(encodedSvg);

    const img = new Image();

    img.onload = () => {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, widthPx, heightPx);
      ctx.drawImage(img, 0, 0, widthPx, heightPx);
      resolve();
    };

    img.onerror = (e) => {
      console.error("SVG Render Error:", e);
      reject(new Error("Failed to render standalone SVG onto canvas buffer."));
    };

    img.src = dataUrl;
  });
}

// -- PDF Export Handler -----------------------------------------------------

function scorePageFormat(settings) {
  let widthMm = PAGE_SIZE_MM.width;
  let heightMm = PAGE_SIZE_MM.height;
  if (settings.orientation === "landscape") [widthMm, heightMm] = [heightMm, widthMm];
  return { widthMm, heightMm, orientation: settings.orientation };
}

function partPageFormat() {
  // Parts are always landscape at their own fixed page size (§4.2) —
  // never the sidebar's orientation setting.
  return { widthMm: PART_LAYOUT_MM.widthMm, heightMm: PART_LAYOUT_MM.heightMm, orientation: "landscape" };
}

/**
 * Builds the ordered list of pages exportPdf() will rasterize, one job per
 * PDF page: { format: {widthMm, heightMm, orientation}, mount: () => {svgEl, remove} }.
 * `mount` is deferred (not called here) so exportPdf() can mount, rasterize,
 * and unmount one page at a time instead of holding every page's SVG in the
 * DOM at once.
 *
 * scope "current": whatever's on screen right now — unchanged from before,
 * except the page *format* now correctly follows what's actually showing
 * (a part's fixed landscape layout, if that's what's displayed, rather than
 * always assuming the score's own orientation setting — that mismatch was
 * latent before parts existed to expose it).
 *
 * scope "scoreAndParts" (plan §6.4): the score's own pages, freshly
 * rendered + stamped exactly as renderAllPages() does (so this works
 * whether or not the score is what's currently displayed), followed by
 * every part's already-rendered, already-stamped pages from currentParts —
 * one combined PDF, one save().
 */
function buildExportJobs(scope, settings) {
  const scoreFormat = scorePageFormat(settings);
  const partFormat = partPageFormat();

  if (scope === "scoreAndParts") {
    const jobs = [];
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      jobs.push({
        format: scoreFormat,
        mount: () => {
          const mounted = mountSandboxPage(renderPage(pageNumber));
          if (mounted.svgEl) {
            stampScoreMetadata(mounted.svgEl, currentMetadata, {
              marginTopMm: settings.marginTopMm,
              marginRightMm: settings.marginRightMm,
              marginBottomMm: settings.marginBottomMm,
              marginLeftMm: settings.marginLeftMm,
              isFirstPage: pageNumber === 1,
            });
          }
          return mounted;
        },
      });
    }
    currentParts.forEach((part) => {
      part.pages.forEach((svgMarkup) => {
        // Already stamped in generateParts() — just mount to rasterize.
        jobs.push({ format: partFormat, mount: () => mountSandboxPage(svgMarkup) });
      });
    });
    return jobs;
  }

  // scope === "current"
  const format = viewing.kind === "part" ? partFormat : scoreFormat;
  const svgElements = Array.from(scoreArea.querySelectorAll(".page svg"));
  return svgElements.map((svgEl) => ({ format, mount: () => ({ svgEl, remove: null }) }));
}

function exportFileName(scope) {
  if (scope === "scoreAndParts") return `${loadedFileName} - Score and Parts.pdf`;
  if (viewing.kind === "part") {
    const part = currentParts[viewing.index];
    if (part) return `${loadedFileName} - ${part.name}.pdf`;
  }
  return `${loadedFileName}.pdf`;
}

async function exportPdf() {
  if (!scoreIsLoaded || totalPages < 1) return;

  const scope = exportScopeEl.value; // "current" | "scoreAndParts"
  setStatus("Generating PDF…");
  exportPdfBtn.disabled = true;

  const sharedCanvas = document.createElement("canvas");

  try {
    if (typeof window.jspdf?.jsPDF !== "function") {
      throw new Error("jsPDF library is not loaded.");
    }

    const settings = currentSettings();
    const jobs = buildExportJobs(scope, settings);
    if (jobs.length === 0) {
      throw new Error("No rendered pages found to export.");
    }

    const { jsPDF } = window.jspdf;
    const firstFormat = jobs[0].format;
    const pdf = new jsPDF({
      orientation: firstFormat.orientation,
      unit: "mm",
      format: [firstFormat.widthMm, firstFormat.heightMm],
      compress: true,
    });

    // 2x resolution (~200 DPI); resized per job only when the format
    // actually changes (e.g. the score→parts transition in "scoreAndParts"),
    // not on every single page.
    const scaleFactor = 2;
    let canvasFormatKey = null;

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];

      if (i > 0) {
        pdf.addPage([job.format.widthMm, job.format.heightMm], job.format.orientation);
      }

      setStatus(`Processing page ${i + 1} of ${jobs.length}…`);
      await yieldToMainThread();

      const { svgEl, remove } = job.mount();
      try {
        if (!svgEl) continue; // shouldn't happen; skip rather than abort the whole export

        const canvasWidthPx = Math.round((job.format.widthMm * 96) / 25.4) * scaleFactor;
        const canvasHeightPx = Math.round((job.format.heightMm * 96) / 25.4) * scaleFactor;
        const formatKey = `${canvasWidthPx}x${canvasHeightPx}`;
        if (formatKey !== canvasFormatKey) {
          sharedCanvas.width = canvasWidthPx;
          sharedCanvas.height = canvasHeightPx;
          canvasFormatKey = formatKey;
        }

        await renderSvgToCanvas(svgEl, sharedCanvas, canvasWidthPx, canvasHeightPx);
        const imgData = sharedCanvas.toDataURL("image/jpeg", 0.92);

        pdf.setPage(i + 1);
        pdf.addImage(imgData, "JPEG", 0, 0, job.format.widthMm, job.format.heightMm, undefined, "FAST");
      } finally {
        if (remove) remove();
      }

      await yieldToMainThread();
    }

    setStatus("Saving PDF file…");
    await yieldToMainThread();

    const fileName = exportFileName(scope);
    pdf.save(fileName);
    setStatus(`${fileName} downloaded successfully.`);
  } catch (err) {
    showError(err, "Failed to generate PDF:");
  } finally {
    sharedCanvas.width = 0;
    sharedCanvas.height = 0;
    exportPdfBtn.disabled = false;
  }
}
exportPdfBtn.addEventListener("click", exportPdf);

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) handleFile(file);
});

// -- settings changes -----------------------------------------------------

function debounce(fn, delayMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delayMs);
  };
}

const applySettingsChange = debounce(async () => {
  if (!scoreIsLoaded) return;
  clearError();
  setStatus("Re-engraving…");
  try {
    const settings = currentSettings();
    totalPages = updateSettings(settings);
    // Parts use their own fixed landscape-Letter layout (PART_LAYOUT_MM),
    // not the sidebar controls, so only re-render if the score itself is
    // what's currently on screen.
    if (viewing.kind === "score") renderAllPages(totalPages);
    setStatus(`${totalPages} page${totalPages === 1 ? "" : "s"}`);
  } catch (err) {
    showError(err, "Couldn't apply that setting:");
    setStatus("");
  }
}, 400);

[orientationEl, marginTopEl, marginBottomEl, marginLeftEl, marginRightEl].forEach(
  (el) => el.addEventListener("change", applySettingsChange)
);

scaleEl.addEventListener("input", () => {
  scaleValueEl.textContent = `${scaleEl.value}%`;
  applySettingsChange();
});
