import mongoose from 'mongoose';
import { FoodMenuDiscount } from '../admin/models/menuDiscount.model.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MENU_DISCOUNT_MIN_PERCENT = 1;
export const MENU_DISCOUNT_MAX_PERCENT = 90;
export const MENU_DISCOUNT_MAX_SPAN_DAYS = 366;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Current calendar day in IST as "YYYY-MM-DD". */
export function istDateString(date = new Date()) {
    return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function isValidDateString(value) {
    if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
    const d = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export const istDayStart = (dateStr) => new Date(`${dateStr}T00:00:00.000+05:30`);
export const istDayEnd = (dateStr) => new Date(`${dateStr}T23:59:59.999+05:30`);

export function daysBetween(startStr, endStr) {
    const a = new Date(`${startStr}T00:00:00.000Z`).getTime();
    const b = new Date(`${endStr}T00:00:00.000Z`).getTime();
    return Math.round((b - a) / 86400000);
}

/**
 * Pure calculation shared by checkout, previews and tests (mirrored in the frontend helper).
 * discount = subtotal * pct%, split into admin / restaurant shares that always sum to discount.
 */
export function computeMenuDiscountAmounts(subtotal, discountDoc) {
    const safeSubtotal = Math.max(0, Number(subtotal) || 0);
    const pct = Number(discountDoc?.percentage) || 0;
    if (safeSubtotal <= 0 || pct <= 0) {
        return { discountAmount: 0, adminShare: 0, restaurantShare: 0 };
    }
    const discountAmount = Math.min(safeSubtotal, round2((safeSubtotal * pct) / 100));

    const adminPct = Number(discountDoc?.adminBearPercentage);
    const restPct = Number(discountDoc?.restaurantBearPercentage);
    const total = (Number.isFinite(adminPct) ? adminPct : 0) + (Number.isFinite(restPct) ? restPct : 0);
    const restaurantFraction = total > 0 ? restPct / total : 1;

    const restaurantShare = round2(discountAmount * restaurantFraction);
    const adminShare = round2(discountAmount - restaurantShare);
    return { discountAmount, adminShare, restaurantShare };
}

export function getMenuDiscountState(doc, now = new Date()) {
    if (!doc) return 'inactive';
    if (doc.isActive === false) return 'inactive';
    const t = now.getTime();
    if (t < new Date(doc.startAt).getTime()) return 'upcoming';
    if (t > new Date(doc.endAt).getTime()) return 'expired';
    return 'active';
}

export function serializeMenuDiscount(doc, now = new Date()) {
    if (!doc) return null;
    return {
        id: String(doc._id),
        restaurantId: String(doc.restaurantId?._id || doc.restaurantId),
        restaurantName: doc.restaurantName || doc.restaurantId?.restaurantName || '',
        createdByRole: doc.createdByRole,
        percentage: doc.percentage,
        scheduleType: doc.scheduleType,
        startDate: doc.startDate,
        endDate: doc.endDate,
        adminBearPercentage: doc.adminBearPercentage,
        restaurantBearPercentage: doc.restaurantBearPercentage,
        isActive: doc.isActive !== false,
        state: getMenuDiscountState(doc, now),
        note: doc.note || '',
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

/** Slim public shape (no internal bear split) shown to customers. */
export function serializePublicMenuDiscount(doc) {
    if (!doc) return null;
    return {
        id: String(doc._id),
        restaurantId: String(doc.restaurantId),
        percentage: doc.percentage,
        scheduleType: doc.scheduleType,
        startDate: doc.startDate,
        endDate: doc.endDate,
    };
}

/** The discount in effect right now for a restaurant (highest %, admin-created wins ties). */
export async function findActiveMenuDiscount(restaurantObjectId, now = new Date()) {
    if (!restaurantObjectId || !mongoose.Types.ObjectId.isValid(String(restaurantObjectId))) return null;
    const rows = await FoodMenuDiscount.find({
        restaurantId: new mongoose.Types.ObjectId(String(restaurantObjectId)),
        isActive: true,
        startAt: { $lte: now },
        endAt: { $gte: now },
    })
        .sort({ percentage: -1 })
        .limit(5)
        .lean();
    if (!rows.length) return null;
    return rows.find((r) => r.createdByRole === 'admin' && r.percentage === rows[0].percentage) || rows[0];
}

/** Checkout helper: resolves the active discount and computes amounts + snapshot for the order. */
export async function resolveMenuDiscountForOrder({ restaurantObjectId, itemSubtotal, now = new Date() }) {
    const empty = { menuDiscount: 0, menuDiscountInfo: null };
    const discountDoc = await findActiveMenuDiscount(restaurantObjectId, now);
    if (!discountDoc) return empty;
    const { discountAmount, adminShare, restaurantShare } = computeMenuDiscountAmounts(itemSubtotal, discountDoc);
    if (discountAmount <= 0) return empty;
    return {
        menuDiscount: discountAmount,
        menuDiscountInfo: {
            discountId: discountDoc._id,
            percentage: discountDoc.percentage,
            source: discountDoc.createdByRole,
            scheduleType: discountDoc.scheduleType,
            startDate: discountDoc.startDate,
            endDate: discountDoc.endDate,
            adminBearPercentage: discountDoc.adminBearPercentage,
            restaurantBearPercentage: discountDoc.restaurantBearPercentage,
            discountAmount,
            adminShare,
            restaurantShare,
        },
    };
}
