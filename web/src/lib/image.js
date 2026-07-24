/**
 * Client-side photo compression.
 *
 * Gate networks are slow, so a 4MB phone photo is resized to a 1024px JPEG
 * (~150-200KB) before it ever leaves the device. The server re-normalizes and
 * strips EXIF regardless — this is purely about upload time.
 */

const MAX_EDGE = 1024;
const QUALITY = 0.8;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image.'));
    };
    img.src = url;
  });
}

export async function compressImage(file) {
  // createImageBitmap applies EXIF orientation on modern mobile browsers; the
  // <img> fallback covers older Android WebViews.
  let source;
  let width;
  let height;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    width = source.width;
    height = source.height;
  } catch (err) {
    source = await loadImage(file);
    width = source.naturalWidth;
    height = source.naturalHeight;
  }

  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (source.close) source.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('Could not process that photo.');

  return {
    blob,
    // Object URL for the on-screen preview; callers revoke it when done.
    previewUrl: URL.createObjectURL(blob),
  };
}
