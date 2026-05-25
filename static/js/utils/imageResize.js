// @ts-check

/**
 * Client-side image resize utility.
 *
 * Accepts a File/Blob, resizes it to fit within maxSize × maxSize pixels
 * (never upscales), and returns a data URI (WebP preferred, JPEG fallback).
 *
 * Used by the profile page before uploading an avatar image so that
 * data URIs stay well within the 512 KiB backend limit.
 */

/** Accepted MIME types for avatar uploads. */
const ACCEPTED_TYPES = new Set(['image/png', 'image/webp', 'image/jpeg']);

/**
 * Load an image File/Blob as a data URL via FileReader.
 * @param {File | Blob} file
 * @returns {Promise<string>}
 */
function _readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(/** @type {string} */ (reader.result));
        reader.onerror = () => reject(new Error('FileReader failed'));
        reader.readAsDataURL(file);
    });
}

/**
 * Load a data URL into an HTMLImageElement (waits for `onload`).
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
function _loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image failed to load'));
        img.src = src;
    });
}

/**
 * Convert a canvas to a data URI, preferring WebP at quality 0.85.
 * Falls back to JPEG if the browser does not support WebP encoding.
 * @param {HTMLCanvasElement} canvas
 * @returns {string}
 */
function _canvasToDataUri(canvas) {
    const webp = canvas.toDataURL('image/webp', 0.85);
    // toDataURL returns a PNG if the MIME type is not supported — detect by prefix
    if (webp.startsWith('data:image/webp')) return webp;
    return canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * Resize an image File to fit within maxSize × maxSize, then return
 * a data URI (WebP at quality 0.85, or JPEG as fallback).
 *
 * - Images already within maxSize × maxSize are not upscaled.
 * - Only `image/png`, `image/webp`, and `image/jpeg` are accepted;
 *   all other MIME types throw an Error.
 *
 * @param {File} file        Image file to resize
 * @param {number} [maxSize=512]  Maximum width and height in pixels
 * @returns {Promise<string>}  data URI of the (possibly resized) image
 */
export async function resizeImageToDataUrl(file, maxSize = 104) {
    if (!ACCEPTED_TYPES.has(file.type)) {
        throw new Error(`Unsupported image type: ${file.type}. Accepted: PNG, WebP, JPEG.`);
    }

    const dataUrl = await _readAsDataUrl(file);
    const img = await _loadImage(dataUrl);

    const { naturalWidth: w, naturalHeight: h } = img;

    // Compute output dimensions — scale down proportionally if needed, never upscale
    let outW = w;
    let outH = h;
    if (w > maxSize || h > maxSize) {
        const ratio = Math.min(maxSize / w, maxSize / h);
        outW = Math.round(w * ratio);
        outH = Math.round(h * ratio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D canvas context');
    ctx.drawImage(img, 0, 0, outW, outH);

    return _canvasToDataUri(canvas);
}
