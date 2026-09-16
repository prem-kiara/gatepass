/**
 * Photo processing for the gate.
 *
 * Two sources, one output: a ~150KB 1024px JPEG. Gate networks are slow, so a
 * phone photo is never uploaded at full size. The server re-normalizes and
 * strips EXIF regardless — this is purely about upload time.
 */

const MAX_EDGE = 1024;
const QUALITY = 0.8;

/** Draws any image source down to MAX_EDGE and encodes it as a JPEG blob. */
async function toJpeg(source, width, height) {
  if (!width || !height) throw new Error('Could not read that image.');
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);

  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('Could not process that photo.');

  return {
    blob,
    // Object URL for the on-screen preview; callers revoke it when done.
    previewUrl: URL.createObjectURL(blob),
  };
}

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

/** A file from the phone's camera app or gallery. */
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

  const result = await toJpeg(source, width, height);
  if (source.close) source.close();
  return result;
}

/**
 * A frame from the in-app camera. Nothing is written to phone storage on this
 * path — the frame goes straight from the live stream to a JPEG in memory,
 * which is the whole point: Android's camera app writes a multi-megabyte temp
 * file first, and that write is what fails when the phone is low on space.
 */
export async function captureFromVideo(video) {
  return toJpeg(video, video.videoWidth, video.videoHeight);
}
