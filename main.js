// main.js
import { loadScore, updateSettings, renderPage, PAGE_SIZES_MM } from "./verovio-engine.js";

// -- element references ----------------------------------------------------

const fileInput = document.getElementById("file-input");
const exportPdfBtn = document.getElementById("export-pdf-btn");
const scoreArea = document.getElementById("score-area");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");

const pageSizeEl = document.getElementById("page-size");
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
    pageSize: pageSizeEl.value,
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

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
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
    showError(err.message || "Something went wrong while engraving this file.");
    setStatus("");
  }
}

// -- PDF Export Handler ---------------------------------------------------

async function exportPdf() {
  if (!scoreIsLoaded || totalPages < 1) return;

  setStatus("Generating vector PDF…");
  exportPdfBtn.disabled = true;

  try {
    const settings = currentSettings();
    const size = PAGE_SIZES_MM[settings.pageSize] || PAGE_SIZES_MM.a4;
    let widthMm = size.width;
    let heightMm = size.height;

    if (settings.orientation === "landscape") {
      [widthMm, heightMm] = [heightMm, widthMm];
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      orientation: settings.orientation,
      unit: "mm",
      format: [widthMm, heightMm],
      compress: true,
    });

    // Safely resolve the svg2pdf function depending on how the UMD script attached to window
    const svg2pdfFn =
      typeof window.svg2pdf === "function"
        ? window.svg2pdf
        : window.svg2pdf?.svg2pdf || window.svg2pdf?.default;

    if (typeof svg2pdfFn !== "function") {
      throw new Error("svg2pdf library is not loaded properly.");
    }

    const pageDivs = scoreArea.querySelectorAll(".page svg");

    for (let i = 0; i < pageDivs.length; i++) {
      if (i > 0) {
        pdf.addPage([widthMm, heightMm], settings.orientation);
      }
      const svgElement = pageDivs[i];
      await svg2pdfFn(svgElement, pdf, {
        x: 0,
        y: 0,
        width: widthMm,
        height: heightMm,
      });
    }

    pdf.save(`${loadedFileName}.pdf`);
    setStatus(`${loadedFileName}.pdf downloaded successfully.`);
  } catch (err) {
    showError("Failed to generate vector PDF: " + (err.message || err));
  } finally {
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

const applySettingsChange = debounce(() => {
  if (!scoreIsLoaded) return; // nothing to re-render yet; new settings apply on next open
  clearError();
  setStatus("Re-engraving…");
  try {
    totalPages = updateSettings(currentSettings());
    renderAllPages(totalPages);
    setStatus(`${totalPages} page${totalPages === 1 ? "" : "s"}`);
  } catch (err) {
    showError(err.message || "Couldn't apply that setting.");
    setStatus("");
  }
}, 400);

[pageSizeEl, orientationEl, marginTopEl, marginBottomEl, marginLeftEl, marginRightEl].forEach(
  (el) => el.addEventListener("change", applySettingsChange)
);

scaleEl.addEventListener("input", () => {
  scaleValueEl.textContent = `${scaleEl.value}%`;
  applySettingsChange();
});