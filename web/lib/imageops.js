// Browser-only image helpers (canvas): format normalization and baking crops into pictures.
import { imageInfo } from "./png.js";

function canvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

async function toBytes(cv, type, quality) {
  const blob = cv.convertToBlob ? await cv.convertToBlob({ type, quality })
    : await new Promise((r) => cv.toBlob(r, type, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

// PNG/JPEG/GIF pass through; anything else (WebP, HEIC, …) becomes PNG.
export async function normalizeImage(bytes) {
  if (!bytes || imageInfo(bytes)) return bytes;
  try {
    const bmp = await createImageBitmap(new Blob([bytes]));
    const cv = canvas(bmp.width, bmp.height);
    cv.getContext("2d").drawImage(bmp, 0, 0);
    return toBytes(cv, "image/png");
  } catch {
    return bytes;
  }
}

// job: {data, crop: {l,t,r,b}, boxW, boxH, ext}
export async function cropImage(job) {
  const bmp = await createImageBitmap(new Blob([job.data]));
  const iw = bmp.width, ih = bmp.height, { l, t, r, b } = job.crop;
  const sx = l * iw, sy = t * ih, sw = (1 - l - r) * iw, sh = (1 - t - b) * ih;
  const aspect = job.boxW / job.boxH;
  // Keep the source pixel density, capped at 4096 px per side.
  let outW = Math.max(1, Math.round(Math.max(sw, sh * aspect)));
  let outH = Math.max(1, Math.round(outW / aspect));
  const k = Math.min(1, 4096 / Math.max(outW, outH));
  outW = Math.max(1, Math.round(outW * k)); outH = Math.max(1, Math.round(outH * k));
  const cv = canvas(outW, outH);
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, outW, outH);
  return toBytes(cv, job.ext === "jpeg" ? "image/jpeg" : "image/png", 0.92);
}
