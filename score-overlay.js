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
// IMPORTANT: call this AFTER the page's <svg> is attached to the live
// document (main.js does this right after scoreArea.appendChild(pageEl),
// not before). Positioning composer relative to the title, and
// shrinking the rights text to fit, both need getBBox()/getCTM()/
// getComputedTextLength() — browsers only compute real layout for
// elements that are actually connected to the document.

const SVG_NS = "http://www.w3.org/2000/svg";

/** Parses a length attribute that should be a plain real-world
 * millimeter value (thanks to mmOutput:true) — e.g. "215.9mm" or
 * "215.9". Returns null for anything that isn't a physical unit
 * (e.g. a percentage), since that can't be used to derive a scale. */
function parseMmAttribute(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) return null;
  const n = parseFloat(trimmed);
  return isNaN(n) || n <= 0 ? null : n;
}

/**
 * Reads the page's drawing coordinate space (viewBox) AND the
 * viewBox-units-per-real-millimeter scale, both from the live <svg>
 * itself rather than from any assumption about what page size this
 * app *thinks* it configured Verovio to produce.
 *
 * With mmOutput:true, Verovio's <svg> carries both a viewBox (its own
 * internal drawing units — whatever those actually turn out to be, in
 * case scaleToPageSize/adjustPageHeight adjust the final output from
 * the raw page-size options) and width/height attributes in real mm.
 * Dividing one by the other gives the true scale empirically, self-
 * consistently, no matter what that internal unit convention is.
 */
function getPageGeometry(svgElement) {
  const viewBox = svgElement.getAttribute("viewBox");
  let vbWidth = null;
  let vbHeight = null;
  if (viewBox) {
    const parts = viewBox.trim().split(/\s+/).map(Number);
    if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
      vbWidth = parts[2];
      vbHeight = parts[3];
    }
  }

  const widthMm = parseMmAttribute(svgElement.getAttribute("width"));
  const heightMm = parseMmAttribute(svgElement.getAttribute("height"));

  if (vbWidth === null || vbHeight === null) {
    // No viewBox at all: treat width/height attributes as the
    // drawing space directly (1 unit == 1mm).
    return { width: widthMm, height: heightMm, scaleX: 1, scaleY: 1 };
  }

  return {
    width: vbWidth,
    height: vbHeight,
    scaleX: widthMm ? vbWidth / widthMm : 1,
    scaleY: heightMm ? vbHeight / heightMm : 1,
  };
}

/**
 * Bounding box of `el`, transformed into the coordinate space of the
 * outermost <svg> — i.e. the same space `getPageGeometry` describes.
 * Needed because Verovio wraps header content in <g> elements that
 * may carry their own transforms; a raw getBBox() is only correct in
 * that <g>'s local space, not the page's. Returns null if `el` isn't
 * really laid out (e.g. disconnected from the document).
 */
function getBBoxInRootSpace(el) {
  let bbox;
  try {
    bbox = el.getBBox();
  } catch {
    return null;
  }
  if (!bbox || (bbox.width === 0 && bbox.height === 0)) return null;

  const ctm = el.getCTM();
  if (!ctm) return null;

  const corners = [
    { x: bbox.x, y: bbox.y },
    { x: bbox.x + bbox.width, y: bbox.y },
    { x: bbox.x, y: bbox.y + bbox.height },
    { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
  ].map((p) => new DOMPoint(p.x, p.y).matrixTransform(ctm));

  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * Finds the title line Verovio's "auto" header drew, so composer can
 * be positioned and sized relative to it. Verovio mirrors MEI element
 * names as SVG @class values (documented in the Verovio reference
 * book's "CSS and SVG" page), so a generated MEI <pgHead> becomes
 * <g class="pgHead">; its first text run is the title, since title is
 * always the first line Verovio draws there. Returns the root-space
 * bbox, or null if it can't be found — callers should fall back to a
 * fixed position rather than fail outright.
 */
function getTitleBBox(svgElement) {
  const pgHead = svgElement.querySelector(".pgHead");
  if (!pgHead) return null;
  const titleTextEl = pgHead.querySelector("text, tspan") || pgHead;
  return getBBoxInRootSpace(titleTextEl);
}

function addText(svgElement, { text, x, y, anchor, fontSize, dominantBaseline }) {
  const textEl = document.createElementNS(SVG_NS, "text");
  textEl.setAttribute("x", String(x));
  textEl.setAttribute("y", String(y));
  textEl.setAttribute("text-anchor", anchor);
  if (dominantBaseline) textEl.setAttribute("dominant-baseline", dominantBaseline);
  textEl.setAttribute("font-family", "Times New Roman, Georgia, serif");
  textEl.setAttribute("font-size", String(fontSize));
  textEl.setAttribute("fill", "#000000");
  textEl.textContent = text;
  svgElement.appendChild(textEl);
  return textEl;
}

/**
 * Shrinks `textEl`'s font-size, if needed, so its rendered width fits
 * within `maxWidth` (in the same coordinate units as the SVG it's
 * in). `textEl` must already be attached to the live document —
 * getComputedTextLength() needs real layout to measure against. Text
 * length scales linearly with font-size for a fixed font, so a single
 * proportional adjustment is enough — no need to iterate.
 */
function shrinkToFit(textEl, maxWidth) {
  const currentSize = parseFloat(textEl.getAttribute("font-size"));
  if (!currentSize || currentSize <= 0 || !maxWidth || maxWidth <= 0) return;

  let measured;
  try {
    measured = textEl.getComputedTextLength();
  } catch {
    return; // can't measure — leave the requested size as-is
  }
  if (measured > maxWidth) {
    textEl.setAttribute("font-size", String(currentSize * (maxWidth / measured)));
  }
}

/**
 * Stamps composer and rights/copyright onto one rendered page.
 * Title-page style: only meant for page 1 — call this once per
 * rendered page and let `isFirstPage` gate it, so the call site in
 * main.js doesn't need its own branch.
 *
 * Composer: right-anchored to the right margin — fixed regardless of
 * notation scale, since it's derived from the physical margin
 * setting rather than anything that changes with scale — vertically
 * centered on the bottom edge of the title Verovio actually drew. Its
 * font size is half the title's rendered height, so both position and
 * size re-derive correctly any time this runs again after a
 * rescale/redraw.
 *
 * Rights/copyright: horizontally centered on the page, baseline
 * sitting on the bottom margin. Capped at a small font size, and
 * shrunk further if needed so the whole line fits between the left
 * and right margins.
 *
 * @param {SVGElement|null} svgElement — must already be attached to
 *   the live document (main.js calls this right after appendChild,
 *   not before) — the bbox/text-measurement APIs need real layout.
 * @param {{composer: string|null, rights: string|null}} metadata
 * @param {{
 *   isFirstPage: boolean,
 *   marginTopMm: number,
 *   marginRightMm: number,
 *   marginBottomMm: number,
 *   marginLeftMm: number,
 * }} layout
 */
export function stampScoreMetadata(svgElement, metadata, layout) {
  if (!svgElement || !layout || !layout.isFirstPage) return;
  if (!metadata || (!metadata.composer && !metadata.rights)) return;

  const { width, height, scaleX, scaleY } = getPageGeometry(svgElement);
  if (!width || !height) return; // no coordinate space to place text in safely

  if (metadata.composer) {
    const titleBBox = getTitleBBox(svgElement);
    // Fall back to a fixed size/position if the title line couldn't
    // be found (e.g. Verovio's class naming changes in some future
    // version) so composer still shows up somewhere reasonable rather
    // than not at all.
    const fontSize = titleBBox ? titleBBox.height / 2 : 4 * scaleY;
    const centerY = titleBBox
      ? titleBBox.y + titleBBox.height
      : layout.marginTopMm * scaleY * 0.7;

    addText(svgElement, {
      text: metadata.composer,
      x: width - layout.marginRightMm * scaleX, // fixed to the right margin, independent of scale
      y: centerY,
      anchor: "end",
      dominantBaseline: "central", // makes `y` the text's vertical center, not its baseline
      fontSize,
    });
  }

  if (metadata.rights) {
    const maxFontSize = 2.5 * scaleY; // "always small" cap
    const rightsEl = addText(svgElement, {
      text: metadata.rights,
      x: width / 2,
      y: height - layout.marginBottomMm * scaleY, // baseline sits on the bottom margin
      anchor: "middle",
      fontSize: maxFontSize,
    });

    const usableWidth = width - (layout.marginLeftMm + layout.marginRightMm) * scaleX;
    shrinkToFit(rightsEl, usableWidth);
  }
}
