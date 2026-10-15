import {
    listUnder99Banners,
    createUnder99BannersFromFiles,
    deleteUnder99Banner,
    updateUnder99BannerOrder,
    toggleUnder99BannerStatus
} from '../services/under99Banner.service.js';
import { sendResponse } from '../../../../utils/response.js';
import { ValidationError } from '../../../../core/auth/errors.js';

export const listUnder99BannersController = async (req, res, next) => {
    try {
        const data = await listUnder99Banners();
        return sendResponse(res, 200, 'Under 99 banners fetched successfully', { banners: data });
    } catch (error) {
        next(error);
    }
};

export const uploadUnder99BannersController = async (req, res, next) => {
    try {
        if (!req.files || !req.files.length) {
            throw new ValidationError('No files uploaded');
        }

        const meta = {
            title: req.body.title,
            ctaText: req.body.ctaText,
            ctaLink: req.body.ctaLink,
            zoneId: req.body.zoneId,
        };

        const results = await createUnder99BannersFromFiles(req.files, meta);
        return sendResponse(res, 201, 'Under 99 banners uploaded', { banners: results });
    } catch (error) {
        next(error);
    }
};

export const deleteUnder99BannerController = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!id) {
            throw new ValidationError('Banner id is required');
        }
        const result = await deleteUnder99Banner(id);
        return sendResponse(res, 200, result.deleted ? 'Under 99 banner deleted' : 'Under 99 banner not found', result);
    } catch (error) {
        next(error);
    }
};

export const updateUnder99BannerOrderController = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { order } = req.body;
        const sortOrder = Number(order);
        if (!id || Number.isNaN(sortOrder)) {
            throw new ValidationError('id and numeric order are required');
        }
        const updated = await updateUnder99BannerOrder(id, sortOrder);
        return sendResponse(res, 200, 'Under 99 banner order updated', updated);
    } catch (error) {
        next(error);
    }
};

export const toggleUnder99BannerStatusController = async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!id) {
            throw new ValidationError('Banner id is required');
        }
        // Frontend sends empty body, so toggle based on current
        const banner = await listUnder99Banners().then(list => list.find(b => b._id.toString() === id));
        if (!banner) {
            throw new ValidationError('Under 99 banner not found');
        }
        const updated = await toggleUnder99BannerStatus(id, !banner.isActive);
        return sendResponse(res, 200, 'Under 99 banner status updated', updated);
    } catch (error) {
        next(error);
    }
};

