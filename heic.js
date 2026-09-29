'use strict';
/**
 * heic.js — HEIC/HEIF detection + conversion to JPEG.
 *
 * iPhones upload photos as HEIC by default. tesseract can't read HEIC,
 * and browsers can't display it either, so we convert to JPEG first:
 * the converted file is what gets saved under public/uploads/ and fed
 * to OCR. Non-HEIC uploads are never touched.
 */

// heic-convert is lazy-loaded so the server still boots (with a friendly
// error for HEIC uploads) if the module is missing.
let convertFn = null;
let convertMissing = false;
function getConverter() {
  if (convertMissing) return null;
  if (!convertFn) {
    try {
      convertFn = require('heic-convert');
    } catch (e) {
      convertMissing = true;
      console.warn('[heic] heic-convert not available — HEIC photos cannot be read:', e.message);
      return null;
    }
  }
  return convertFn;
}

/**
 * True when an upload looks like HEIC/HEIF, by content-type
 * (image/heic, image/heif) or by filename extension (.heic/.heif).
 */
function isHeicUpload(contentType, filename) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (ct === 'image/heic' || ct === 'image/heif') return true;
  const name = String(filename || '').toLowerCase();
  return name.endsWith('.heic') || name.endsWith('.heif');
}

/**
 * Convert a HEIC/HEIF buffer to JPEG.
 * `convert` is injectable for tests; defaults to the real heic-convert.
 * Resolves with a JPEG Buffer, rejects when conversion is unavailable/fails.
 */
async function convertHeicToJpeg(buffer, convert) {
  const doConvert = convert || getConverter();
  if (!doConvert) throw new Error('heic-convert-missing');
  const out = await doConvert({ buffer, format: 'JPEG', quality: 0.92 });
  return Buffer.from(out);
}

/**
 * Prepare an uploaded photo for saving + OCR.
 * HEIC/HEIF → converted to JPEG ({ buffer, ext: '.jpg', converted: true }).
 * Anything else → returned untouched ({ buffer, ext: null, converted: false });
 * the caller keeps its own extension logic. Never throws for non-HEIC.
 */
async function preparePhoto({ buffer, contentType, filename }, convert) {
  if (!isHeicUpload(contentType, filename)) {
    return { buffer, ext: null, converted: false };
  }
  const jpeg = await convertHeicToJpeg(buffer, convert);
  return { buffer: jpeg, ext: '.jpg', converted: true };
}

module.exports = { isHeicUpload, convertHeicToJpeg, preparePhoto };
