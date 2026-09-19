import mongoose from 'mongoose';
import { ValidationError, ForbiddenError } from '../../../../core/auth/errors.js';
import { FoodMenuDiscount } from '../models/menuDiscount.model.js';
import { resolveRestaurantDocument } from '../../shared/restaurantIdentity.util.js';
import {
    MENU_DISCOUNT_MIN_PERCENT,
    MENU_DISCOUNT_MAX_PERCENT,
    MENU_DISCOUNT_MAX_SPAN_DAYS,
    istDateString,
    isValidDateString,
    istDayStart,
    istDayEnd,
    daysBetween,
    serializeMenuDiscount,
    getMenuDiscountState,
} from '../../shared/menuDiscount.util.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const NO_MATCH_ID = '000000000000000000000000';

function oid(value) {
    return new mongoose.Types.ObjectId(String(value));
}

function assertObjectId(id, label = 'id') {
    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) throw new ValidationError(`Invalid ${label}`);
}

/**
 * Normalises + validates the payload. `actor.role` decides who bears the discount:
 * a restaurant always bears 100%; admin chooses the split (must sum to 100).
 */
function normalizePayload(body = {}, actor, existing = null) {
    const percentage = round2(body.percentage ?? existing?.percentage);
    if (!Number.isFinite(percentage) || percentage < MENU_DISCOUNT_MIN_PERCENT || percentage > MENU_DISCOUNT_MAX_PERCENT) {
        throw new ValidationError(
            `Discount percentage must be between ${MENU_DISCOUNT_MIN_PERCENT} and ${MENU_DISCOUNT_MAX_PERCENT}`
        );
    }

    const scheduleType = (body.scheduleType ?? existing?.scheduleType) === 'single_day' ? 'single_day' : 'date_range';
    const startDate = String(body.startDate ?? existing?.startDate ?? '').trim();
    if (!isValidDateString(startDate)) throw new ValidationError('A valid start date is required (YYYY-MM-DD)');

    const endDate = scheduleType === 'single_day'
        ? startDate
        : String(body.endDate ?? existing?.endDate ?? '').trim();
    if (!isValidDateString(endDate)) throw new ValidationError('A valid end date is required (YYYY-MM-DD)');

    const today = istDateString();
    if (endDate < today) throw new ValidationError('End date cannot be in the past');
    if (startDate < today && startDate !== existing?.startDate) {
        throw new ValidationError('Start date cannot be in the past');
    }
    if (endDate < startDate) throw new ValidationError('End date must be on or after start date');
    if (daysBetween(startDate, endDate) + 1 > MENU_DISCOUNT_MAX_SPAN_DAYS) {
        throw new ValidationError(`Discount period cannot exceed ${MENU_DISCOUNT_MAX_SPAN_DAYS} days`);
    }

    let adminBearPercentage = 0;
    let restaurantBearPercentage = 100;
    if (actor.role === 'admin') {
        const adminRaw = body.adminBearPercentage ?? existing?.adminBearPercentage ?? 0;
        adminBearPercentage = round2(adminRaw);
        restaurantBearPercentage = round2(body.restaurantBearPercentage ?? (100 - adminBearPercentage));
        if (
            !Number.isFinite(adminBearPercentage) || !Number.isFinite(restaurantBearPercentage) ||
            adminBearPercentage < 0 || restaurantBearPercentage < 0 ||
            adminBearPercentage > 100 || restaurantBearPercentage > 100
        ) {
            throw new ValidationError('Admin and restaurant share must be between 0 and 100');
        }
        if (Math.abs(adminBearPercentage + restaurantBearPercentage - 100) > 0.01) {
            throw new ValidationError('Admin share + restaurant share must total 100%');
        }
    }

    const note = String(body.note ?? existing?.note ?? '').trim().slice(0, 200);
    return {
        percentage, scheduleType, startDate, endDate,
        startAt: istDayStart(startDate), endAt: istDayEnd(endDate),
        adminBearPercentage, restaurantBearPercentage, note,
    };
}

async function assertNoOverlap(restaurantId, startAt, endAt, excludeId = null) {
    const clash = await FoodMenuDiscount.findOne({
        restaurantId: oid(restaurantId),
        isActive: true,
        startAt: { $lte: endAt },
        endAt: { $gte: startAt },
        ...(excludeId ? { _id: { $ne: oid(excludeId) } } : {}),
    }).lean();
    if (clash) {
        throw new ValidationError(
            `An active ${clash.percentage}% menu discount (${clash.startDate} to ${clash.endDate}, set by ${clash.createdByRole}) ` +
            'already overlaps these dates. Deactivate or edit it first.'
        );
    }
}

export async function createMenuDiscount(actor, body = {}) {
    let restaurant;
    if (actor.role === 'admin') {
        restaurant = await resolveRestaurantDocument(body.restaurantId);
    } else {
        assertObjectId(actor.id, 'restaurant');
        restaurant = await resolveRestaurantDocument(actor.id);
    }
    if (!restaurant) throw new ValidationError('Restaurant not found');
    if (restaurant.status !== 'approved') throw new ValidationError('Restaurant is not approved');

    const data = normalizePayload(body, actor);
    const isActive = body.isActive !== false;
    if (isActive) await assertNoOverlap(restaurant._id, data.startAt, data.endAt);

    const doc = await FoodMenuDiscount.create({
        ...data,
        restaurantId: restaurant._id,
        restaurantName: restaurant.restaurantName || restaurant.name || '',
        createdByRole: actor.role,
        createdById: actor.id && mongoose.Types.ObjectId.isValid(String(actor.id)) ? oid(actor.id) : null,
        isActive,
    });
    return serializeMenuDiscount(doc.toObject());
}

async function loadOwned(actor, id) {
    assertObjectId(id, 'discount id');
    const doc = await FoodMenuDiscount.findById(id);
    if (!doc) throw new ValidationError('Menu discount not found');
    if (actor.role === 'restaurant') {
        if (String(doc.restaurantId) !== String(actor.id)) throw new ForbiddenError('Not allowed');
        if (doc.createdByRole !== 'restaurant') {
            throw new ForbiddenError('This discount was set by admin and can only be changed by admin');
        }
    }
    return doc;
}

export async function updateMenuDiscount(actor, id, body = {}) {
    const doc = await loadOwned(actor, id);
    const data = normalizePayload(body, actor, doc.toObject());
    const isActive = body.isActive === undefined ? doc.isActive : body.isActive !== false;
    if (isActive) await assertNoOverlap(doc.restaurantId, data.startAt, data.endAt, doc._id);
    Object.assign(doc, data, { isActive });
    await doc.save();
    return serializeMenuDiscount(doc.toObject());
}

export async function setMenuDiscountActive(actor, id, isActive) {
    const doc = await loadOwned(actor, id);
    const next = isActive !== false;
    if (next) {
        if (getMenuDiscountState({ ...doc.toObject(), isActive: true }) === 'expired') {
            throw new ValidationError('Expired discount cannot be activated. Edit the dates first.');
        }
        await assertNoOverlap(doc.restaurantId, doc.startAt, doc.endAt, doc._id);
    }
    doc.isActive = next;
    await doc.save();
    return serializeMenuDiscount(doc.toObject());
}

export async function deleteMenuDiscount(actor, id) {
    const doc = await loadOwned(actor, id);
    await doc.deleteOne();
    return { id: String(id) };
}

export async function listMenuDiscounts(actor, query = {}) {
    const page = Math.max(1, parseInt(query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
    const now = new Date();
    const filter = {};

    if (actor.role === 'restaurant') {
        assertObjectId(actor.id, 'restaurant');
        filter.restaurantId = oid(actor.id);
    } else if (query.restaurantId) {
        const rid = await resolveRestaurantDocument(query.restaurantId);
        filter.restaurantId = rid ? rid._id : oid(NO_MATCH_ID);
    }

    const state = String(query.state || '').toLowerCase();
    if (state === 'active') Object.assign(filter, { isActive: true, startAt: { $lte: now }, endAt: { $gte: now } });
    else if (state === 'upcoming') Object.assign(filter, { isActive: true, startAt: { $gt: now } });
    else if (state === 'expired') Object.assign(filter, { endAt: { $lt: now } });
    else if (state === 'inactive') Object.assign(filter, { isActive: false });

    const search = String(query.search || '').trim();
    if (search) filter.restaurantName = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };

    const [rows, total] = await Promise.all([
        FoodMenuDiscount.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        FoodMenuDiscount.countDocuments(filter),
    ]);
    return {
        discounts: rows.map((r) => serializeMenuDiscount(r, now)),
        total, page, limit, totalPages: Math.ceil(total / limit) || 1,
    };
}
