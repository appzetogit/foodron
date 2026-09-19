import {
    createMenuDiscount,
    updateMenuDiscount,
    setMenuDiscountActive,
    deleteMenuDiscount,
    listMenuDiscounts,
} from '../services/menuDiscount.service.js';
import { findActiveMenuDiscount, serializePublicMenuDiscount } from '../../shared/menuDiscount.util.js';
import { resolveRestaurantObjectId } from '../../shared/restaurantIdentity.util.js';
import { sendResponse } from '../../../../utils/response.js';

const adminActor = (req) => ({ role: 'admin', id: req.user?.userId || req.user?.id || null });
const restaurantActor = (req) => ({ role: 'restaurant', id: req.user?.userId });

const handler = (fn, status, message) => (actorOf) => async (req, res, next) => {
    try {
        const data = await fn(actorOf(req), req);
        return sendResponse(res, status, message, data);
    } catch (error) {
        return next(error);
    }
};

const list = handler((actor, req) => listMenuDiscounts(actor, req.query || {}), 200, 'Menu discounts fetched successfully');
const create = handler((actor, req) => createMenuDiscount(actor, req.body || {}), 201, 'Menu discount created successfully');
const update = handler((actor, req) => updateMenuDiscount(actor, req.params.id, req.body || {}), 200, 'Menu discount updated successfully');
const toggle = handler((actor, req) => setMenuDiscountActive(actor, req.params.id, req.body?.isActive), 200, 'Menu discount status updated');
const remove = handler((actor, req) => deleteMenuDiscount(actor, req.params.id), 200, 'Menu discount deleted successfully');

export const adminMenuDiscountControllers = {
    list: list(adminActor), create: create(adminActor), update: update(adminActor),
    toggle: toggle(adminActor), remove: remove(adminActor),
};

export const restaurantMenuDiscountControllers = {
    list: list(restaurantActor), create: create(restaurantActor), update: update(restaurantActor),
    toggle: toggle(restaurantActor), remove: remove(restaurantActor),
};

/** Public: the discount currently applied to a restaurant's menu (not cached — date sensitive). */
export const getPublicRestaurantMenuDiscountController = async (req, res, next) => {
    try {
        const restaurantObjectId = await resolveRestaurantObjectId(req.params.id);
        const doc = await findActiveMenuDiscount(restaurantObjectId);
        res.set('Cache-Control', 'no-store');
        return sendResponse(res, 200, 'Menu discount fetched successfully', {
            menuDiscount: serializePublicMenuDiscount(doc),
        });
    } catch (error) {
        return next(error);
    }
};
