import { sendResponse, sendError } from '../../../../utils/response.js';
import { createRestaurantFood, updateRestaurantFood, listFoodNamesForCategory } from '../services/restaurantFood.service.js';
import { invalidateCache } from '../../../../middleware/cache.js';

export const getFoodNamesController = async (req, res, next) => {
    try {
        const data = await listFoodNamesForCategory(req.query?.categoryId, req.query?.search);
        return sendResponse(res, 200, 'Food names fetched successfully', data);
    } catch (error) {
        next(error);
    }
};

export const createRestaurantFoodController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const food = await createRestaurantFood(restaurantId, req.body || {});
        await Promise.all([
            invalidateCache('restaurants*'),
            invalidateCache('food_search*'),
            invalidateCache(`restaurant_detail*`),
        ]).catch(console.error);
        return sendResponse(res, 201, 'Food created successfully', { food });
    } catch (error) {
        next(error);
    }
};

export const updateRestaurantFoodController = async (req, res, next) => {
    try {
        const restaurantId = req.user?.userId;
        const food = await updateRestaurantFood(restaurantId, req.params.id, req.body || {});
        if (!food) return sendError(res, 404, 'Food not found');
        return sendResponse(res, 200, 'Food updated successfully', { food });
    } catch (error) {
        next(error);
    }
};

