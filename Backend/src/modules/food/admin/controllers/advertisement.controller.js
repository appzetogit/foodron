import {
    listAdminAdvertisements,
    listAdminAdvertisementRequests,
    createAdminAdvertisement,
    updateAdminAdvertisementStatus,
    updateAdminAdvertisementPriority,
    deleteAdminAdvertisement,
    updateAdminAdvertisement
} from '../../restaurant/services/advertisement.service.js';
import {
    getAdminAdBilling,
    listRestaurantAdSettings,
    setRestaurantAdPercentage
} from '../services/advertisementBilling.service.js';
import { sendResponse } from '../../../../utils/response.js';
import { invalidateCache } from '../../../../middleware/cache.js';

export const listAdminAdvertisementsController = async (req, res, next) => {
    try {
        const ads = await listAdminAdvertisements();
        return sendResponse(res, 200, 'Advertisements fetched successfully', ads);
    } catch (error) {
        next(error);
    }
};

export const createAdminAdvertisementController = async (req, res, next) => {
    try {
        const ad = await createAdminAdvertisement(req.body || {}, req.files || {});
        invalidateCache('landing_advertisements*');
        return sendResponse(res, 201, 'Advertisement created successfully', ad);
    } catch (error) {
        next(error);
    }
};

export const listAdminAdvertisementRequestsController = async (req, res, next) => {
    try {
        const requests = await listAdminAdvertisementRequests();
        return sendResponse(res, 200, 'Advertisement requests fetched successfully', requests);
    } catch (error) {
        next(error);
    }
};

export const updateAdminAdvertisementStatusController = async (req, res, next) => {
    try {
        const updated = await updateAdminAdvertisementStatus(req.params.id, req.body?.status);
        invalidateCache('landing_advertisements*');
        return sendResponse(res, 200, 'Advertisement status updated', updated);
    } catch (error) {
        next(error);
    }
};

export const updateAdminAdvertisementPriorityController = async (req, res, next) => {
    try {
        const updated = await updateAdminAdvertisementPriority(req.params.id, req.body?.priority);
        invalidateCache('landing_advertisements*');
        return sendResponse(res, 200, 'Advertisement priority updated', updated);
    } catch (error) {
        next(error);
    }
};

export const deleteAdminAdvertisementController = async (req, res, next) => {
    try {
        const result = await deleteAdminAdvertisement(req.params.id);
        invalidateCache('landing_advertisements*');
        return sendResponse(res, 200, 'Advertisement deleted successfully', result);
    } catch (error) {
        next(error);
    }
};

export const updateAdminAdvertisementController = async (req, res, next) => {
    try {
        const adId = req.params.id;
        const updated = await updateAdminAdvertisement(adId, req.body || {}, req.files || {});
        invalidateCache('landing_advertisements*');
        return sendResponse(res, 200, 'Advertisement updated successfully', updated);
    } catch (error) {
        next(error);
    }
};

// ----- Advertisement billing (admin revenue share) -----

export const getAdminAdvertisementBillingController = async (req, res, next) => {
    try {
        const data = await getAdminAdBilling(req.query || {});
        return sendResponse(res, 200, 'Advertisement billing fetched successfully', data);
    } catch (error) {
        next(error);
    }
};

export const listRestaurantAdSettingsController = async (req, res, next) => {
    try {
        const data = await listRestaurantAdSettings(req.query || {});
        return sendResponse(res, 200, 'Restaurant ad percentages fetched successfully', data);
    } catch (error) {
        next(error);
    }
};

export const setRestaurantAdPercentageController = async (req, res, next) => {
    try {
        const data = await setRestaurantAdPercentage(
            req.params.restaurantId,
            req.body?.percentage ?? req.body?.adCommissionPercentage
        );
        return sendResponse(res, 200, 'Advertisement percentage updated', data);
    } catch (error) {
        next(error);
    }
};
