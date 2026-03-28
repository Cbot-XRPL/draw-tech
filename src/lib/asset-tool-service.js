import sharp from "sharp";
import imageSize from "image-size";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { cleanText } from "./utils.js";

export function createAssetToolService() {
  return {
    inspectAttachmentBuffer,
    inspectPngBuffer,
    comparePngBuffers
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
