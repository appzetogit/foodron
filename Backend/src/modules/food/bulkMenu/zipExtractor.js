import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import unzipper from 'unzipper';
import {
    ALLOWED_IMAGE_EXTENSIONS,
    BulkImportError,
    ERROR,
    IMAGES_DIR,
    LIMITS,
    WORKBOOK_NAME
} from './constants.js';

const IGNORED_BASENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const SYMLINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

/** Image file names we accept from Excel/ZIP: a single path segment, no separators. */
export const SAFE_FILENAME = /^[\p{L}\p{N}][\p{L}\p{N}._ ()+\-]*$/u;

export const isSafeImageFileName = (name) =>
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    !name.includes('..') &&
    SAFE_FILENAME.test(name);

class ByteLimit extends Transform {
    constructor(limit) {
        super();
        this.limit = limit;
        this.seen = 0;
    }

    _transform(chunk, _enc, cb) {
        this.seen += chunk.length;
        if (this.seen > this.limit) {
            const err = new Error('size limit exceeded');
            err.code = 'SIZE_LIMIT';
            return cb(err);
        }
        return cb(null, chunk);
    }
}

const unsafe = (entryPath, why) =>
    new BulkImportError(
        ERROR.UNSAFE_ZIP_ENTRY,
        `The ZIP contains an unsafe entry "${String(entryPath).slice(0, 120)}" (${why}). The package was rejected.`
    );

/**
 * Securely unpack a bulk-import package into `destDir`.
 *
 * Nothing in the archive decides where a file lands: we validate every entry name, then
 * write only `menu.xlsx` and `images/<file>` into destDir under names WE generate.
 * Any traversal, absolute path or symlink entry rejects the whole package.
 * Declared sizes are pre-checked and the byte count is enforced again while streaming, so a
 * lying header cannot expand past the limits.
 *
 * @returns {{ workbookPath: string, images: Map<string,{path:string,size:number,ext:string}>,
 *            rejectedImages: Map<string,string>, ignored: string[] }}
 */
export async function extractBulkPackage(zipPath, destDir) {
    let directory;
    try {
        directory = await unzipper.Open.file(zipPath);
    } catch (err) {
        throw new BulkImportError(ERROR.INVALID_ZIP, 'The uploaded file is not a valid ZIP archive.');
    }

    const entries = directory.files || [];
    if (entries.length === 0) {
        throw new BulkImportError(ERROR.INVALID_ZIP, 'The ZIP archive is empty.');
    }
    if (entries.length > LIMITS.maxZipEntries) {
        throw new BulkImportError(ERROR.ZIP_TOO_LARGE, `The ZIP has too many entries (max ${LIMITS.maxZipEntries}).`);
    }

    const root = path.resolve(destDir);
    const imagesRoot = path.join(root, IMAGES_DIR);
    await fsp.mkdir(imagesRoot, { recursive: true });

    // ---- pass 1: classify every entry, reject anything unsafe before writing a byte.
    const workbookEntries = [];
    const imageEntries = [];
    const ignored = [];
    let totalDeclared = 0;
    let nestedWorkbook = false;

    for (const entry of entries) {
        const raw = String(entry.path || '');
        if (raw.includes('\0')) throw unsafe(raw, 'null byte in name');

        const normalized = raw.replace(/\\/g, '/');
        if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw unsafe(raw, 'absolute path');

        const segments = normalized.split('/').filter((segment) => segment !== '');
        if (segments.some((segment) => segment === '..' || segment === '.')) throw unsafe(raw, 'path traversal');

        const attrs = Number(entry.externalFileAttributes);
        if (Number.isFinite(attrs) && ((attrs >>> 16) & FILE_TYPE_MASK) === SYMLINK_MODE) {
            throw unsafe(raw, 'symbolic link');
        }

        if (entry.type === 'Directory' || normalized.endsWith('/')) continue;
        if (segments.length === 0) continue;

        const base = segments[segments.length - 1];
        const lowerBase = base.toLowerCase();
        if (
            segments[0] === '__MACOSX' ||
            IGNORED_BASENAMES.has(lowerBase) ||
            base.startsWith('._')
        ) {
            continue;
        }

        if (segments.length === 1 && lowerBase === WORKBOOK_NAME) {
            workbookEntries.push(entry);
        } else if (segments.length === 2 && segments[0] === IMAGES_DIR) {
            imageEntries.push({ entry, name: base });
        } else {
            if (lowerBase === WORKBOOK_NAME) nestedWorkbook = true;
            if (ignored.length < 50) ignored.push(normalized);
            continue;
        }

        totalDeclared += Number(entry.uncompressedSize) || 0;
    }

    if (totalDeclared > LIMITS.maxTotalUncompressedBytes) {
        throw new BulkImportError(
            ERROR.ZIP_TOO_LARGE,
            `The ZIP expands to more than ${Math.round(LIMITS.maxTotalUncompressedBytes / 1024 / 1024)}MB.`
        );
    }

    if (workbookEntries.length === 0) {
        throw new BulkImportError(
            ERROR.MISSING_WORKBOOK,
            nestedWorkbook
                ? 'menu.xlsx must be at the root of the ZIP, not inside a folder. Select the files (not the folder) when zipping.'
                : 'menu.xlsx was not found at the root of the ZIP.'
        );
    }
    if (workbookEntries.length > 1) {
        throw new BulkImportError(ERROR.MISSING_WORKBOOK, 'The ZIP contains more than one menu.xlsx.');
    }

    // ---- pass 2: extract only what we accepted, under names we generate.
    const workbookEntry = workbookEntries[0];
    if ((Number(workbookEntry.uncompressedSize) || 0) > LIMITS.maxWorkbookBytes) {
        throw new BulkImportError(ERROR.INVALID_WORKBOOK, 'menu.xlsx is too large.');
    }
    const workbookPath = path.join(root, WORKBOOK_NAME);
    try {
        await pipeline(workbookEntry.stream(), new ByteLimit(LIMITS.maxWorkbookBytes), fs.createWriteStream(workbookPath));
    } catch (err) {
        if (err?.code === 'SIZE_LIMIT') throw new BulkImportError(ERROR.INVALID_WORKBOOK, 'menu.xlsx is too large.');
        throw new BulkImportError(ERROR.INVALID_ZIP, 'The ZIP archive is corrupted and could not be extracted.');
    }

    const images = new Map();
    const rejectedImages = new Map();
    let index = 0;

    for (const { entry, name } of imageEntries) {
        const ext = path.extname(name).toLowerCase();
        if (!isSafeImageFileName(name)) {
            rejectedImages.set(name, ERROR.UNSAFE_IMAGE_PATH);
            continue;
        }
        if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
            rejectedImages.set(name, ERROR.INVALID_IMAGE_TYPE);
            continue;
        }
        if ((Number(entry.uncompressedSize) || 0) > LIMITS.maxImageBytes) {
            rejectedImages.set(name, ERROR.IMAGE_TOO_LARGE);
            continue;
        }
        // Stored under a generated name: entry names never touch the filesystem path,
        // and names differing only by case cannot collide on case-insensitive disks.
        const target = path.join(imagesRoot, `${index++}${ext}`);
        if (!path.resolve(target).startsWith(imagesRoot + path.sep)) throw unsafe(name, 'escapes target');
        try {
            await pipeline(entry.stream(), new ByteLimit(LIMITS.maxImageBytes), fs.createWriteStream(target));
        } catch (err) {
            await fsp.rm(target, { force: true });
            if (err?.code === 'SIZE_LIMIT') {
                rejectedImages.set(name, ERROR.IMAGE_TOO_LARGE);
                continue;
            }
            rejectedImages.set(name, ERROR.IMAGE_UNREADABLE);
            continue;
        }
        const { size } = await fsp.stat(target);
        images.set(name, { path: target, size, ext });
    }

    return { workbookPath, images, rejectedImages, ignored };
}
