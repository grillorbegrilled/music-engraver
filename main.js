// main.js
import { loadScore, updateSettings, renderPage, PAGE_SIZE_MM } from "./verovio-engine.js";
import { extractScoreMetadata, preprocessMusicXml } from "./musicxml-fixups.js";
import { stampScoreMetadata, stampPartName, getPageGeometry } from "./score-overlay.js";
import { extractParts } from "./part-extraction.js";
import { renderPartsToSvg, PART_LAYOUT_MM } from "./part-renderer.js";

// -- element references ----------------------------------------------------

const fileInput = document.getElementById("file-input");
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
// The first version of this sandbox used a plain `div.innerHTML =
// svgString` appended straight into `document.body`. That's what broke the
// stamp: unlike part-renderer-test.html (a bare page with no other
// stylesheet), this app loads styles.css, which sizes the on-screen
// `.page svg` for the phone screen — and a bare `<div>` under
// `document.body` is still inside that cascade, so the sandboxed SVG
// picked up the same responsive sizing instead of its native mm-based
// geometry. getPageGeometry()'s width/height came back wrong, throwing off
// both stamps: font-size and position derive directly from it (too-big,
// mispositioned part name; composer/rights sized/placed somewhere
// invisible). A shadow root keeps styles.css out of this subtree
// entirely — real layout still happens, nothing from the outer page's CSS
// cascades in — which is the one thing this sandbox needs that the test
// page's bare div never had to worry about. Parsing with DOMParser's XML
// parser (not innerHTML's HTML/foreign-content parser) matches
// part-renderer-test.html's `stampAndCheckPage()` exactly, which the user
// confirmed renders correctly.
const stampSandboxHost = document.createElement("div");
stampSandboxHost.style.cssText = "position:absolute; left:-99999px; top:-99999px;";
document.body.appendChild(stampSandboxHost);
const stampSandbox = stampSandboxHost.attachShadow({ mode: "open" });

/**
 * Attaches an SVG string to the live document (in the isolated shadow
 * sandbox above) just long enough for stampScoreMetadata/stampPartName to
 * measure real layout, stamps it, and returns the result serialized back
 * to a string. Passed to renderPartsToSvg as its `stampPage` hook (plan
 * §4.4, §5).
 */
function stampPartPage(svgString, { part, pageNumber }) {
  const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
  const svgEl = doc.documentElement;
  if (!svgEl || doc.getElementsByTagName("parsererror").length) {
    console.warn(`Couldn't parse rendered SVG for part "${part.name}", page ${pageNumber} — left unstamped.`);
    return svgString;
  }
  stampSandbox.appendChild(svgEl);
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
    stampSandbox.removeChild(svgEl);
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

// -- PDF Export Handler (Fixed 1:1 Page Mapping) --------------------------

async function exportPdf() {
  if (!scoreIsLoaded || totalPages < 1) return;

  setStatus("Generating PDF…");
  exportPdfBtn.disabled = true;

  const sharedCanvas = document.createElement("canvas");

  try {
    const settings = currentSettings();
    let widthMm = PAGE_SIZE_MM.width;
    let heightMm = PAGE_SIZE_MM.height;

    if (settings.orientation === "landscape") {
      [widthMm, heightMm] = [heightMm, widthMm];
    }

    if (typeof window.jspdf?.jsPDF !== "function") {
      throw new Error("jsPDF library is not loaded.");
    }

    // Target ONLY direct page containers to avoid capturing hidden defs/font SVGs
    const pageContainers = scoreArea.querySelectorAll(".page");
    const validSvgElements = [];

    pageContainers.forEach((pageEl) => {
      const svg = pageEl.querySelector("svg");
      if (svg) validSvgElements.push(svg);
    });

    if (validSvgElements.length === 0) {
      throw new Error("No rendered score pages found.");
    }

    // Set resolution (2x resolution ~200 DPI)
    const scaleFactor = 2;
    const canvasWidthPx = Math.round((widthMm * 96) / 25.4) * scaleFactor;
    const canvasHeightPx = Math.round((heightMm * 96) / 25.4) * scaleFactor;

    sharedCanvas.width = canvasWidthPx;
    sharedCanvas.height = canvasHeightPx;

    const { jsPDF } = window.jspdf;
    
    // Initialize jsPDF — starts with 1 blank page automatically
    const pdf = new jsPDF({
      orientation: settings.orientation,
      unit: "mm",
      format: [widthMm, heightMm],
      compress: true,
    });

    for (let i = 0; i < validSvgElements.length; i++) {
      const pageIndex = i + 1;

      // Add a new page ONLY after page 1
      if (i > 0) {
        pdf.addPage([widthMm, heightMm], settings.orientation);
      }

      setStatus(`Processing page ${pageIndex} of ${validSvgElements.length}…`);
      await yieldToMainThread();

      const svgElement = validSvgElements[i];

      // Paint SVG onto shared canvas
      await renderSvgToCanvas(svgElement, sharedCanvas, canvasWidthPx, canvasHeightPx);

      const imgData = sharedCanvas.toDataURL("image/jpeg", 0.92);

      // Explicitly set focus to current page index before adding image
      pdf.setPage(pageIndex);
      pdf.addImage(imgData, "JPEG", 0, 0, widthMm, heightMm, undefined, "FAST");

      await yieldToMainThread();
    }

    setStatus("Saving PDF file…");
    await yieldToMainThread();

    pdf.save(`${loadedFileName}.pdf`);
    setStatus(`${loadedFileName}.pdf downloaded successfully.`);
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
