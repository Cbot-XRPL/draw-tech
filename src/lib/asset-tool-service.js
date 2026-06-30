import sharp from "sharp";
import imageSize from "image-size";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { cleanText } from "./utils.js";

export function createAssetToolService() {
  return {
    inspectAttachmentBuffer,
    inspectPngBuffer,
    comparePngBuffers,
    analyzeAnchorGeometry
  };
}

async function inspectAttachmentBuffer(buffer) {
  const dimensions = imageSize(buffer);
  return {
    width: Number(dimensions?.width || 0),
    height: Number(dimensions?.height || 0),
    type: cleanText(dimensions?.type)
  };
}

async function inspectPngBuffer(buffer) {
  const normalized = await sharp(buffer).ensureAlpha().png().toBuffer();
  const metadata = await sharp(normalized).metadata();
  const png = PNG.sync.read(normalized);
  const bounds = getOpaqueBounds(png);
  const opaquePixels = bounds.opaquePixels;
  const totalPixels = png.width * png.height || 1;
  const alphaCoverage = Number((opaquePixels / totalPixels).toFixed(4));

  return {
    width: png.width,
    height: png.height,
    format: cleanText(metadata.format),
    channels: Number(metadata.channels || 0),
    alphaCoverage,
    opaquePixels,
    bounds: bounds.opaquePixels
      ? {
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom
        }
      : null,
    touchesEdge: Boolean(
      bounds.opaquePixels &&
        (bounds.left === 0 ||
          bounds.top === 0 ||
          bounds.right === png.width - 1 ||
          bounds.bottom === png.height - 1)
    ),
    emptyAlpha: opaquePixels === 0
  };
}

async function comparePngBuffers(sourceBuffer, targetBuffer) {
  const first = PNG.sync.read(await sharp(sourceBuffer).ensureAlpha().png().toBuffer());
  const second = PNG.sync.read(
    await sharp(targetBuffer)
      .ensureAlpha()
      .resize({ width: first.width, height: first.height, fit: "fill" })
      .png()
      .toBuffer()
  );
  const diff = new PNG({ width: first.width, height: first.height });
  const diffPixels = pixelmatch(first.data, second.data, diff.data, first.width, first.height, {
    threshold: 0.08,
    includeAA: true
  });
  const totalPixels = first.width * first.height || 1;

  return {
    diffPixels,
    similarity: Number((1 - diffPixels / totalPixels).toFixed(4))
  };
}

// D2: derive coarse connection sub-regions (face / neck / hand bands) from the base alpha mask.
// Heuristic and tuned for centered, head-heavy characters; every field is a normalized 0..1 ratio
// of the canvas. Callers fall back to the whole-body box when a band can't be resolved.
async function analyzeAnchorGeometry(buffer) {
  const normalized = await sharp(buffer).ensureAlpha().png().toBuffer();
  const png = PNG.sync.read(normalized);
  const { width, height } = png;
  const bounds = getOpaqueBounds(png);
  if (!bounds.opaquePixels) {
    return { width, height, bounds: null, empty: true };
  }

  // Width of opaque content per row (in px) across the body's vertical span.
  const rowWidth = [];
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    let lo = -1;
    let hi = -1;
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      if (png.data[(width * y + x) * 4 + 3] > 8) {
        if (lo === -1) lo = x;
        hi = x;
      }
    }
    rowWidth.push(hi === -1 ? 0 : hi - lo + 1);
  }

  const bodyTop = bounds.top;
  const bodyH = bounds.bottom - bounds.top + 1;
  const rowAt = (yPx) => rowWidth[Math.max(0, Math.min(rowWidth.length - 1, yPx - bodyTop))] || 0;
  const widestIn = (y0, y1) => {
    let bestY = y0;
    let bestW = -1;
    for (let y = y0; y <= y1; y += 1) {
      const w = rowAt(y);
      if (w > bestW) {
        bestW = w;
        bestY = y;
      }
    }
    return { y: bestY, w: bestW };
  };
  const narrowestIn = (y0, y1) => {
    let bestY = y0;
    let bestW = Infinity;
    for (let y = y0; y <= y1; y += 1) {
      const w = rowAt(y);
      if (w > 0 && w < bestW) {
        bestW = w;
        bestY = y;
      }
    }
    return { y: bestY, w: Number.isFinite(bestW) ? bestW : 0 };
  };

  // Face/cheek line: widest row in the upper portion of the head.
  const face = widestIn(Math.round(bodyTop + bodyH * 0.12), Math.round(bodyTop + bodyH * 0.5));
  // Shoulders/body: widest row in the lower portion.
  const shoulder = widestIn(Math.round(bodyTop + bodyH * 0.5), bounds.bottom);
  // Neck pinch: narrowest row between the face line and the shoulder line (the head→body seam).
  const neckLo = Math.round(face.y + bodyH * 0.04);
  const neckHi = Math.round(shoulder.y - bodyH * 0.02);
  const neck = neckHi > neckLo ? narrowestIn(neckLo, neckHi) : { y: Math.round(bodyTop + bodyH * 0.45), w: face.w };

  const r = (v, dim) => Number((v / dim).toFixed(4));
  return {
    width,
    height,
    empty: false,
    bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
    boundsRatio: {
      x0: r(bounds.left, width),
      x1: r(bounds.right, width),
      y0: r(bounds.top, height),
      y1: r(bounds.bottom, height)
    },
    face: { centerYRatio: r(face.y, height), widthRatio: r(face.w, width) },
    neck: { centerYRatio: r(neck.y, height), widthRatio: r(neck.w, width) },
    shoulder: { centerYRatio: r(shoulder.y, height), widthRatio: r(shoulder.w, width) },
    // Paws/hands sit low and to the sides for a seated character.
    hand: { centerYRatio: r(Math.round(bounds.bottom - bodyH * 0.14), height), widthRatio: r(shoulder.w, width) }
  };
}

function getOpaqueBounds(png) {
  let left = png.width;
  let top = png.height;
  let right = -1;
  let bottom = -1;
  let opaquePixels = 0;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const alpha = png.data[(png.width * y + x) * 4 + 3];
      if (alpha <= 8) {
        continue;
      }

      opaquePixels += 1;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  return {
    left: opaquePixels ? left : 0,
    top: opaquePixels ? top : 0,
    right: opaquePixels ? right : 0,
    bottom: opaquePixels ? bottom : 0,
    opaquePixels
  };
}
