// score-overlay.js
//
// Draws composer and rights/copyright text directly onto a rendered
// score page's SVG. Exists because the pinned Verovio build this app
// loads (5.2.0 — see verovio-engine.js) doesn't reliably convert
// MusicXML's composer credit into its own "auto" header: Verovio's
// changelog lists "Fix pgHead conversion in MusicXML importer" landing
// in 5.6.0, after the version pinned here. Rather than keep fighting
// the MusicXML encoding to work around an importer bug on an old
// build, this stamps the text onto the SVG Verovio already produced.
// `footer` is set to "none" in verovio-engine.js so this module owns
// the copyright line outright instead of racing Verovio's own
// (also-unreliable) footer rendering.
//
// Call this after a page's SVG markup has been inserted into the DOM
// (see main.js renderAllPages) — it mutates that live <svg> element in
// place, so the stamped text rides along automatically wherever that
// element goes next, including into main.js's PDF export path, which
// clones the same DOM nodes.

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Reads an SVG element's own drawing coordinate space (viewBox,
 * falling back to width/height attributes) so placement is computed
 * in whatever units Verovio actually drew the page in.
 */
function getViewBoxSize(svgElement) {
  const viewBox = svgElement.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const width = parseFloat(svgElement.getAttribute("width"));
  const height = parseFloat(svgElement.getAttribute("height"));
  return { width: width || null, height: height || null };
}

function addText(svgElement, { text, x, y, anchor, fontSize }) {
  const textEl = document.createElementNS(SVG_NS, "text");
  textEl.setAttribute("x", String(x));
  textEl.setAttribute("y", String(y));
  textEl.setAttribute("text-anchor", anchor);
  textEl.setAttribute("font-family", "Times New Roman, Georgia, serif");
  textEl.setAttribute("font-size", String(fontSize));
  textEl.setAttribute("fill", "#000000");
  textEl.textContent = text;
  svgElement.appendChild(textEl);
}

/**
 * Stamps composer (top-right, roughly where a working "auto" header
 * would put it) and rights/copyright (bottom-center, small print —
 * conventional placement for engraved scores) onto one rendered page.
 * Both are title-page style: only meant for page 1. Call this once
 * per rendered page and let `isFirstPage` do the gating, rather than
 * calling it only for page 1 — keeps the call site in main.js simple.
 *
 * Positions are computed from the page's real margin settings (in mm,
 * the same ones passed into Verovio's own layout options) scaled into
 * the SVG's own coordinate space, so the text lines up with whatever
 * margins are currently configured instead of a guessed position.
 *
 * @param {SVGElement|null} svgElement
 * @param {{composer: string|null, rights: string|null}} metadata
 * @param {{
 *   isFirstPage: boolean,
 *   pageWidthMm: number,
 *   pageHeightMm: number,
 *   marginTopMm: number,
 *   marginRightMm: number,
 *   marginBottomMm: number,
 *   marginLeftMm: number,
 * }} layout
 */
export function stampScoreMetadata(svgElement, metadata, layout) {
  if (!svgElement || !layout || !layout.isFirstPage) return;
  if (!metadata || (!metadata.composer && !metadata.rights)) return;

  const { width, height } = getViewBoxSize(svgElement);
  if (!width || !height) return; // no coordinate space to place text in safely

  // Scale factors from real millimeters into this SVG's own drawing
  // units, so a marginRightMm of e.g. 12.7mm lands at the actual right
  // margin regardless of what internal unit scale Verovio drew in.
  const scaleX = width / layout.pageWidthMm;
  const scaleY = height / layout.pageHeightMm;

  if (metadata.composer) {
    addText(svgElement, {
      text: metadata.composer,
      x: width - layout.marginRightMm * scaleX,
      y: layout.marginTopMm * scaleY * 0.7,
      anchor: "end",
      fontSize: 4 * scaleY, // ~4mm cap height — in line with a composer credit
    });
  }

  if (metadata.rights) {
    addText(svgElement, {
      text: metadata.rights,
      x: width / 2,
      y: height - layout.marginBottomMm * scaleY * 0.4,
      anchor: "middle",
      fontSize: 2.5 * scaleY, // small print, conventional for a copyright line
    });
  }
}
