// src/app/main.js
import { loadScore, updateSettings, renderPage } from "../engraving/verovio-engine.js";

// -- element references ----------------------------------------------------

const fileInput = document.getElementById("file-input");
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
    const pageCount = await loadScore(text, currentSettings());
    renderAllPages(pageCount);
    scoreIsLoaded = true;
    setStatus(`${file.name} — ${pageCount} page${pageCount === 1 ? "" : "s"}`);
  } catch (err) {
    scoreIsLoaded = false;
    showError(err.message || "Something went wrong while engraving this file.");
    setStatus("");
  }
}

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
    const pageCount = updateSettings(currentSettings());
    renderAllPages(pageCount);
    setStatus(`${pageCount} page${pageCount === 1 ? "" : "s"}`);
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
