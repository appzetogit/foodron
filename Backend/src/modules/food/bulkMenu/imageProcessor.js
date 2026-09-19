import fsp from 'fs/promises';
import sharp from 'sharp';
import { uploadImageBuffer } from '../../../services/upload.service.js';
import { ALLOWED_IMAGE_FORMATS, ERROR, IMPORT_CONCURRENCY, LIMITS } from './constants.js';

/** Tiny concurrency gate (no extra dependency). */
export const createLimiter = (max) => {
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= max || queue.length === 0) return;
        active += 1;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
                active -= 1;
                next();
            });
    };
    return (fn) =>
        new Promise((resolve, reject) => {
            queue.push({ fn, resolve, reject });
            next();
        });
};

const IMAGE_MESSAGES = {
    [ERROR.IMAGE_NOT_FOUND]: (name) => `Image not found: ${name}`,
    [ERROR.INVALID_IMAGE_TYPE]: (name) => `Image "${name}" has an unsupported type (allowed: .webp, .jpg, .jpeg, .png).`,
    [ERROR.IMAGE_TOO_LARGE]: (name) => `Image "${name}" is larger than ${Math.round(LIMITS.maxImageBytes / 1024 / 1024)}MB.`,
    [ERROR.IMAGE_UNREADABLE]: (name) => `Image "${name}" could not be read as a valid image.`,
    [ERROR.UNSAFE_IMAGE_PATH]: (name) => `Image "${name}" has an unsafe file name.`
};

export const imageErrorMessage = (code, name) => (IMAGE_MESSAGES[code] || (() => `Image "${name}" is invalid.`))(name);

/**
 * Checks every distinct referenced file once: present in images/, allowed extension and size
 * (decided during extraction), and actually decodable as webp/jpeg/png by sharp.
 * @returns {Promise<Map<string, {ok: boolean, code?: string}>>}
 */
export async function inspectReferencedImages(fileNames, { images, rejectedImages }) {
    const limit = createLimiter(8);
    const results = new Map();

    await Promise.all(
        [...new Set(fileNames)].map((name) =>
            limit(async () => {
                if (rejectedImages.has(name)) {
                    results.set(name, { ok: false, code: rejectedImages.get(name) });
                    return;
                }
                const entry = images.get(name);
                if (!entry) {
                    results.set(name, { ok: false, code: ERROR.IMAGE_NOT_FOUND });
                    return;
                }
                try {
                    // Read into memory first: sharp/libvips would otherwise keep the file handle open
                    // (Windows then cannot delete the staging directory).
                    const meta = await sharp(await fsp.readFile(entry.path), { failOn: 'error' }).metadata();
                    if (!ALLOWED_IMAGE_FORMATS.includes(meta.format) || !meta.width || !meta.height) {
                        results.set(name, { ok: false, code: ERROR.IMAGE_UNREADABLE });
                        return;
                    }
                    results.set(name, { ok: true });
                } catch (err) {
                    results.set(name, { ok: false, code: ERROR.IMAGE_UNREADABLE });
                }
            })
        )
    );
    return results;
}

/**
 * Uploads package images through the EXISTING upload service (sharp -> webp -> local storage
 * or Cloudinary, whichever provider is active). Each distinct file is uploaded once per job
 * even if several rows reference it; concurrency is bounded.
 */
export function createImageUploader(images) {
    const limit = createLimiter(IMPORT_CONCURRENCY.images);
    const cache = new Map();

    return (fileName, folder) => {
        const key = `${folder}::${fileName}`;
        if (!cache.has(key)) {
            const entry = images.get(fileName);
            const promise = limit(async () => {
                if (!entry) throw new Error(`Image not found: ${fileName}`);
                const buffer = await fsp.readFile(entry.path);
                return uploadImageBuffer(buffer, folder);
            });
            // A failed upload must not poison sibling rows forever, but the same job should not
            // hammer the same broken file: cache the (rejected) promise for the job's lifetime.
            cache.set(key, promise);
        }
        return cache.get(key);
    };
}
