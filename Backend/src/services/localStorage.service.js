import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { config } from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Backend/src/services/localStorage.service.js -> Backend/uploads (or UPLOAD_PATH)
export const UPLOADS_ROOT = path.resolve(__dirname, '../../', config.uploadPath || 'uploads');

const MAX_INPUT_PIXELS = 268402689; // ~16384 x 16384, guards decompression bombs

if (!fs.existsSync(UPLOADS_ROOT)) {
    fs.mkdirSync(UPLOADS_ROOT, { recursive: true });
}

const sanitizeFolder = (folder = 'uploads') => {
    const cleaned = String(folder || 'uploads')
        .replace(/\\/g, '/')
        .split('/')
        .map((segment) => segment.replace(/[^a-zA-Z0-9_-]/g, '_'))
        .filter(Boolean)
        .join('/');
    return cleaned || 'uploads';
};

const generateFileName = (ext) => `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;

const writeBufferToDisk = async (buffer, folder, filename) => {
    const safeFolder = sanitizeFolder(folder);
    const dir = path.join(UPLOADS_ROOT, safeFolder);
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    await fsp.writeFile(filePath, buffer);
    const publicId = `${safeFolder}/${filename}`;
    return { publicId, url: `/uploads/${publicId}` };
};

/**
 * Local-disk equivalent of getOptimizedCloudinaryImageUrl — kept as a no-op so
 * callers that pipe every URL through an "optimize" step don't need branching.
 */
export const getOptimizedLocalImageUrl = (url) => url;

export const uploadImageBuffer = async (buffer, folder = 'uploads') => {
    const detailed = await uploadImageBufferDetailed(buffer, folder);
    return detailed.secure_url;
};

export const uploadImageBufferDetailed = async (buffer, folder = 'uploads') => {
    if (!buffer) {
        throw new Error('File buffer is required');
    }

    const optimized = await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .webp({ quality: 82, effort: 4, smartSubsample: true })
        .toBuffer();

    const filename = generateFileName('.webp');
    const { publicId, url } = await writeBufferToDisk(optimized, folder, filename);

    return {
        secure_url: url,
        public_id: publicId,
        format: 'webp',
        resource_type: 'image',
        bytes: optimized.length,
    };
};

const EXT_BY_MIME = {
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
    'video/x-matroska': '.mkv',
    'video/x-msvideo': '.avi',
};

export const uploadBufferDetailed = async (
    buffer,
    { folder = 'uploads', resourceType = 'auto', mimeType = '', originalName = '' } = {}
) => {
    if (!buffer) {
        throw new Error('File buffer is required');
    }

    if (resourceType === 'image') {
        return uploadImageBufferDetailed(buffer, folder);
    }

    const extFromName = originalName ? path.extname(originalName) : '';
    const ext = extFromName || EXT_BY_MIME[String(mimeType).toLowerCase()] || '.bin';
    const filename = generateFileName(ext);
    const { publicId, url } = await writeBufferToDisk(buffer, folder, filename);

    return {
        secure_url: url,
        public_id: publicId,
        format: ext.replace('.', ''),
        resource_type: resourceType,
        bytes: buffer.length,
    };
};

/**
 * Delete a locally stored asset by its publicId (the "<folder>/<filename>" path
 * returned as public_id from uploadImageBufferDetailed/uploadBufferDetailed).
 * Mirrors cloudinary.uploader.destroy's fire-and-forget, error-swallowing behavior.
 */
export const deleteLocalAsset = async (publicId) => {
    if (!publicId || typeof publicId !== 'string') return;

    try {
        const filePath = path.resolve(UPLOADS_ROOT, publicId);
        // Guard against a publicId escaping the uploads root (e.g. "../../etc/passwd").
        if (!filePath.startsWith(UPLOADS_ROOT)) return;
        await fsp.unlink(filePath);
    } catch {
        // ignore missing file / cleanup errors
    }
};
