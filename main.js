// main.js
import { loadScore, updateSettings, renderPage, PAGE_SIZE_MM } from "./verovio-engine.js";

// -- element references ----------------------------------------------------

const fileInput = document.getElementById("file-input");
const exportPdfBtn = document.getElementById("export-pdf-btn");
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
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const svgMarkup = renderPage(pageNumber);
    const pageEl = document.createElement("div");
    pageEl.className = "page";
    pageEl.innerHTML = svgMarkup;
    scoreArea.appendChild(pageEl);
  }
}

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
    totalPages = await loadScore(text, currentSettings());
    renderAllPages(totalPages);
    scoreIsLoaded = true;
    loadedFileName = file.name.replace(/\.[^/.]+$/, "");
    exportPdfBtn.disabled = false;
    setStatus(`${file.name} — ${totalPages} page${totalPages === 1 ? "" : "s"}`);
  } catch (err) {
    scoreIsLoaded = false;
    exportPdfBtn.disabled = true;
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
  const clone = svgElement.cloneNode(true);

  // Ensure standard SVG XML namespace attributes exist
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");

  // Get current width/height or viewBox
  const viewBox = clone.getAttribute("viewBox");
  let nativeWidth = parseFloat(clone.getAttribute("width"));
  let nativeHeight = parseFloat(clone.getAttribute("height"));

  if ((!nativeWidth || !nativeHeight) && viewBox) {
    const parts = viewBox.split(/\s+/).map(Number);
    if (parts.length === 4) {
      nativeWidth = parts[2];
      nativeHeight = parts[3];
    }
  }

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

// Drag and drop onto the score area.
scoreArea.addEventListener("dragover", (event) => {
  event.preventDefault();
  scoreArea.classList.add("drag-over");
});

scoreArea.addEventListener("dragleave", () => {
  scoreArea.classList.remove("drag-over");
});

scoreArea.addEventListener("drop", (event) => {
  event.preventDefault();
  scoreArea.classList.remove("drag-over");
  const file = event.dataTransfer.files[0];
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
    renderAllPages(totalPages);
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
