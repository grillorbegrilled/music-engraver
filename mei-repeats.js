// mei-repeats.js
//
// Post-import MEI step for 2-measure repeats.
//
// Verovio's MusicXML importer turns a <measure-repeat> block into one
// <mRpt/> per measure and discards the block length, so a 2-bar repeat
// comes out as two separate one-bar signs. musicxml-fixups.js records
// each block it creates ({ staffIndex, measureIndex, count }); this file
// takes the MEI Verovio exported after import and, for every 2-bar
// block, replaces the pair of <mRpt/> with one <mRpt2/> plus an empty
// <mSpace/> in the other measure. The caller then reloads the edited MEI.
//
// Blocks whose measures don't look as expected (no <mRpt/> where one
// should be) are left untouched and reported back, never guessed at.
// 4-bar blocks are ignored: MEI has no proper 4-bar repeat element.

// Which measure of the pair gets the <mRpt2/>; the other gets <mSpace/>.
// "first" is the MEI convention as best documented; if Verovio draws the
// sign in the wrong place, flip this to "second".
const PLACE_MRPT2_IN = "first";

/**
 * @param {string} meiText MEI exported by Verovio after MusicXML import
 * @param {Array<{staffIndex:number, measureIndex:number, count:number}>} blocks
 * @returns {{mei: string, applied: Array, skipped: Array<{label:string, reason:string}>}}
 */
export function applyTwoMeasureRepeats(meiText, blocks) {
  const twoBar = blocks.filter((b) => b.count === 2);
  const result = { mei: meiText, applied: [], skipped: [] };
  if (twoBar.length === 0) return result;

  const doc = new DOMParser().parseFromString(meiText, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    for (const b of twoBar) result.skipped.push({ label: label(b), reason: "MEI did not parse" });
    return result;
  }

  const measures = Array.from(doc.getElementsByTagName("measure"));

  for (const block of twoBar) {
    const first = measures[block.measureIndex];
    const second = measures[block.measureIndex + 1];
    if (!first || !second) {
      result.skipped.push({
        label: label(block),
        reason: `measure out of range (MEI has ${measures.length})`,
      });
      continue;
    }

    const staffN = String(block.staffIndex + 1);
    const firstRpt = findMRpt(first, staffN);
    const secondRpt = findMRpt(second, staffN);
    if (!firstRpt || !secondRpt) {
      result.skipped.push({
        label: label(block),
        reason: `no <mRpt/> in staff ${staffN} of ${!firstRpt ? "first" : "second"} bar`,
      });
      continue;
    }

    const [rpt2Target, spaceTarget] =
      PLACE_MRPT2_IN === "second" ? [secondRpt, firstRpt] : [firstRpt, secondRpt];
    replaceElement(doc, rpt2Target, "mRpt2");
    replaceElement(doc, spaceTarget, "mSpace");
    result.applied.push(block);
  }

  if (result.applied.length > 0) {
    result.mei = new XMLSerializer().serializeToString(doc);
  }
  return result;
}

function label(b) {
  return `staff ${b.staffIndex + 1} bars ${b.measureIndex + 1}-${b.measureIndex + 2}`;
}

/** The first <mRpt/> inside <staff n="staffN"> directly under `measure`. */
function findMRpt(measure, staffN) {
  const staff = Array.from(measure.children).find(
    (c) => c.localName === "staff" && c.getAttribute("n") === staffN
  );
  return staff ? staff.getElementsByTagName("mRpt")[0] || null : null;
}

/** Swaps `oldEl` for a new element named `name`, carrying attributes over. */
function replaceElement(doc, oldEl, name) {
  const fresh = doc.createElementNS(oldEl.namespaceURI, name);
  for (const attr of Array.from(oldEl.attributes)) {
    fresh.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
  }
  oldEl.parentNode.replaceChild(fresh, oldEl);
}
