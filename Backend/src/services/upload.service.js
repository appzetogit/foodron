import { config } from '../config/env.js';
import * as cloudinaryService from './cloudinary.service.js';
import * as localStorageService from './localStorage.service.js';

// Single switch for the whole app's upload flow. Cloudinary's implementation
// is kept intact in cloudinary.service.js (not deleted) so it can be
// re-enabled by setting UPLOAD_PROVIDER=cloudinary — but by default every
// module in this codebase now goes through local disk storage.
export const isLocalUploadProvider = config.uploadProvider !== 'cloudinary';

const activeService = isLocalUploadProvider ? localStorageService : cloudinaryService;

export const uploadImageBuffer = activeService.uploadImageBuffer;
export const uploadImageBufferDetailed = activeService.uploadImageBufferDetailed;
export const uploadBufferDetailed = activeService.uploadBufferDetailed;
export const getOptimizedImageUrl = isLocalUploadProvider
    ? localStorageService.getOptimizedLocalImageUrl
    : cloudinaryService.getOptimizedCloudinaryImageUrl;

/**
 * Delete a previously uploaded asset by its publicId, on whichever provider
 * is currently active. Mirrors cloudinary.uploader.destroy's fire-and-forget,
 * error-swallowing behavior so existing callers don't need try/catch.
 */
export const destroyAsset = async (publicId, resourceType = 'image') => {
    if (!publicId) return;

    if (isLocalUploadProvider) {
        await localStorageService.deleteLocalAsset(publicId);
        return;
    }

    try {
        const { v2: cloudinary } = await import('cloudinary');
        await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
    } catch {
        // ignore cleanup failures
    }
};
