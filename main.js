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

// -- SVG Pre-processing for Vector PDF Export -----------------------------

/**
 * Flattens inner nested <svg> elements into standard <g> nodes.
 * Converts viewBox definitions into explicit CSS transforms to prevent
 * recursion crashes in svg2pdf.js.
 */
function flattenNestedSvg(rootSvg, widthMm, heightMm) {
  const nestedSvgs = Array.from(rootSvg.querySelectorAll("svg"));

  nestedSvgs.forEach((innerSvg) => {
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");

    // Copy all attributes (classes, IDs, data attributes) from inner <svg> to <g>
    Array.from(innerSvg.attributes).forEach((attr) => {
      if (!["viewBox", "width", "height", "x", "y"].includes(attr.name)) {
        group.setAttribute(attr.name, attr.value);
      }
    });

    // Handle viewBox scaling if present
    const viewBoxAttr = innerSvg.getAttribute("viewBox");
    if (viewBoxAttr) {
      const viewBox = viewBoxAttr.split(/[\s,]+/).map(Number);
      if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
        const scaleX = widthMm / viewBox[2];
        const scaleY = heightMm / viewBox[3];
        const translateX = -viewBox[0];
        const translateY = -viewBox[1];

        group.setAttribute(
          "transform",
          `scale(${scaleX}, ${scaleY}) translate(${translateX}, ${translateY})`
        );
      }
    }

    // Move all children into the replacement <g> node
    while (innerSvg.firstChild) {
      group.appendChild(innerSvg.firstChild);
    }

    // Replace nested <svg> in parent
    innerSvg.parentNode.replaceChild(group, innerSvg);
  });
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

    if (typeof window.jspdf?.jsPDF !== "function") {
      throw new Error("jsPDF library is not loaded.");
    }

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      orientation: settings.orientation,
      unit: "mm",
      format: [widthMm, heightMm],
      compress: true,
    });

    if (typeof pdf.svg !== "function") {
      throw new Error("svg2pdf.js is not loaded or is incompatible with jsPDF.");
    }

    const pageSvgs = scoreArea.querySelectorAll(".page svg");

    for (let i = 0; i < pageSvgs.length; i++) {
      if (i > 0) {
        pdf.addPage([widthMm, heightMm], settings.orientation);
      }

      // Clone SVG node to manipulate without affecting live view
      const svgClone = pageSvgs[i].cloneNode(true);

      // Verovio outputs SVGs using viewBox; ensure explicit physical dimensions exist for svg2pdf
      svgClone.setAttribute("width", `${widthMm}mm`);
      svgClone.setAttribute("height", `${heightMm}mm`);

      // Flatten inner <svg> elements into <g> containers to bypass svg2pdf limitations
      flattenNestedSvg(svgClone, widthMm, heightMm);

      // svg2pdf needs the element attached to the DOM to resolve <use>
      // refs, gradients, and computed styles — a detached clone fails.
      svgClone.style.position = "fixed";
      svgClone.style.top = "-10000px";
      svgClone.style.left = "-10000px";
      document.body.appendChild(svgClone);

      try {
        // Render vector SVG into PDF context
        await pdf.svg(svgClone, {
          x: 0,
          y: 0,
          width: widthMm,
          height: heightMm,
        });
      } finally {
        document.body.removeChild(svgClone);
      }
    }

    pdf.save(`${loadedFileName}.pdf`);
    setStatus(`${loadedFileName}.pdf downloaded successfully.`);
  } catch (err) {
    showError(err, "Failed to generate vector PDF:");
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
    showError(err, "Couldn't apply that setting:");
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
