import { FoodUnder99Banner } from '../models/under99Banner.model.js';
import { uploadImageBufferDetailed, destroyAsset } from '../../../../services/upload.service.js';

export const listUnder99Banners = async () => {
    return FoodUnder99Banner.find().sort({ sortOrder: 1, createdAt: -1 }).lean();
};

const getNextSortOrder = async () => {
    const last = await FoodUnder99Banner.findOne().sort({ sortOrder: -1 }).select('sortOrder').lean();
    return (last?.sortOrder ?? -1) + 1;
};

export const createUnder99BannersFromFiles = async (files, meta = {}) => {
    if (!files || !files.length) {
        return [];
    }

    const results = [];
    let currentSortOrder = typeof meta.sortOrder === 'number' ? meta.sortOrder : await getNextSortOrder();

    for (const file of files) {
        try {
            const uploadResult = await uploadImageBufferDetailed(file.buffer, 'food/under-99-banners');

            const banner = await FoodUnder99Banner.create({
                imageUrl: uploadResult.secure_url,
                publicId: uploadResult.public_id,
                title: meta.title,
                ctaText: meta.ctaText,
                ctaLink: meta.ctaLink,
                zoneId: meta.zoneId,
                sortOrder: currentSortOrder++,
                isActive: true,
            });

            results.push({ success: true, banner: banner.toObject() });
        } catch (error) {
            results.push({ success: false, error: error.message });
        }
    }

    return results;
};

export const deleteUnder99Banner = async (id) => {
    const doc = await FoodUnder99Banner.findById(id);
    if (!doc) {
        return { deleted: false };
    }

    if (doc.publicId) {
        await destroyAsset(doc.publicId);
    }

    await doc.deleteOne();
    return { deleted: true };
};

export const updateUnder99BannerOrder = async (id, sortOrder) => {
    const updated = await FoodUnder99Banner.findByIdAndUpdate(
        id,
        { sortOrder },
        { new: true }
    ).lean();
    return updated;
};

export const toggleUnder99BannerStatus = async (id, isActive) => {
    const updated = await FoodUnder99Banner.findByIdAndUpdate(
        id,
        { isActive },
        { new: true }
    ).lean();
    return updated;
};

