'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const config = require('../config');

// Filenames we generate are always this shape. Anything else reaching the
// serving route is a traversal attempt, not a typo.
const FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/i;

function ensurePhotoDir() {
  fs.mkdirSync(config.photoDir, { recursive: true });
}

/**
 * Normalizes an uploaded image to a capped-size JPEG and writes it under a UUID name.
 * sharp drops EXIF by default, which is what we want — visitor photos should not
 * carry GPS coordinates or device identifiers into the archive.
 * Returns the stored filename (that is what goes in the DB).
 */
async function storePhoto(buffer) {
  ensurePhotoDir();
  const filename = `${crypto.randomUUID()}.jpg`;
  const target = path.join(config.photoDir, filename);

  await sharp(buffer)
    .rotate() // honour the EXIF orientation before it is stripped, or phone photos land sideways
    .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .toFile(target);

  return filename;
}

function isValidPhotoName(name) {
  return typeof name === 'string' && FILENAME_RE.test(name);
}

function photoPath(name) {
  return path.join(config.photoDir, name);
}

/** Best-effort cleanup for photos written before a later step in the same request failed. */
async function deletePhotos(names) {
  await Promise.all(
    (names || []).filter(isValidPhotoName).map((name) =>
      fs.promises.unlink(photoPath(name)).catch(() => {})
    )
  );
}

module.exports = { storePhoto, isValidPhotoName, photoPath, deletePhotos, ensurePhotoDir };
