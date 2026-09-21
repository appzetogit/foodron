/**
 * Advertisement billing (admin revenue share on restaurant ads).
 *
 * Rule: for every day a billable ad (Image / Banner / Restaurant Promotion — never
 * Video Promotion) is live, the admin receives `percentage`% of that restaurant's
 * delivered-order earnings (`food_transactions.amounts.restaurantShare`) for that
 * day. A multi-day ad is therefore charged once per active day, each day on its
 * own earnings.
 *
 * - Percentage is set by admin per restaurant (`FoodRestaurant.adCommissionPercentage`)
 *   and snapshotted on the ad's billing window when the ad goes live.
 * - A day is charged only after it has ended (IST). Today's amount is shown as a
 *   live estimate and never persisted.
 * - Charge rows (`food_advertisement_charges`) are idempotent (unique ad + day) and
 *   the admin wallet credit is written in the same Mongo transaction as the row.
 * - Restaurant side: outstanding charges are deducted from the withdrawable balance
 *   (see restaurantFinance.service) and consumed by the next approved withdrawal
 *   (see settleRestaurantSharesForWithdrawal). They can push the net balance below
 *   zero when earnings were already withdrawn — later orders offset it.
 */
import mongoose from 'mongoose';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { FoodAdvertisement, NON_BILLABLE_ADS_TYPES } from '../models/advertisement.model.js';
import { FoodAdvertisementCharge } from '../models/advertisementCharge.model.js';
import { FoodAdminWallet } from '../models/adminWallet.model.js';
import { FoodTransaction } from '../../orders/models/foodTransaction.model.js';
import { FoodRestaurant } from '../../restaurant/models/restaurant.model.js';
import { recordTransactionWithSession } from '../../../../core/payments/transaction.service.js';
import { logger } from '../../../../utils/logger.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const IST = 'Asia/Kolkata';
const MAX_BILLING_DAYS_PER_AD = 366;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const RECONCILE_DAYS = 7;
const RECONCILE_THROTTLE_MS = 5 * 60 * 1000;
const reconcileThrottle = new Map();
let legacyIndexChecked = false;

/** One-time: the pre-adjustment unique index (ad + day) would block adjustment rows. */
async function dropLegacyChargeIndex() {
    if (legacyIndexChecked) return;
    legacyIndexChecked = true;
    try {
        await FoodAdvertisementCharge.collection.dropIndex('advertisementId_1_day_1');
    } catch {
        // index does not exist (fresh DB) — nothing to do
    }
    try {
        await FoodAdvertisementCharge.syncIndexes();
    } catch (err) {
        logger.warn(`[AdBilling] charge index sync failed: ${err?.message || err}`);
    }
}

export function istToday(now = new Date()) {
    return dayjs(now).tz(IST).format('YYYY-MM-DD');
}

function dayBounds(day) {
    const start = dayjs.tz(day, IST).startOf('day');
    return { start: start.toDate(), end: start.add(1, 'day').toDate() };
}

function isDeliveredOrder(orderLike) {
    if (!orderLike || typeof orderLike !== 'object') return false;
    const status = String(orderLike.orderStatus || '').trim().toLowerCase();
    if (status === 'delivered') return true;
    const phase = String(
        orderLike.deliveryState?.currentPhase || orderLike.deliveryState?.status || ''
    )
        .trim()
        .toLowerCase();
    return phase === 'delivered';
}

export function isBillableAdType(adsType) {
    return !NON_BILLABLE_ADS_TYPES.includes(adsType);
}

/** Campaign days (IST, inclusive) from the "YYYY-MM-DD to YYYY-MM-DD" validity. */
export function getAdCampaignDays(ad) {
    const found = String(ad?.validity || '').match(/\d{4}-\d{2}-\d{2}/g) || [];
    let startDay = found[0] || null;
    let endDay = found[1] || found[0] || null;
    if (!startDay && ad?.startDate) startDay = dayjs(ad.startDate).tz(IST).format('YYYY-MM-DD');
    if (!endDay && ad?.endDate) endDay = dayjs(ad.endDate).tz(IST).format('YYYY-MM-DD');
    return { startDay, endDay: endDay || startDay };
}

/** Percentage of the billing window that covered this day (null = ad not live that day). */
function percentageForDay(ad, day) {
    const { start, end } = dayBounds(day);
    let pct = null;
    for (const w of ad.billingWindows || []) {
        const from = new Date(w.from).getTime();
        const to = w.to ? new Date(w.to).getTime() : Number.POSITIVE_INFINITY;
        if (from < end.getTime() && to > start.getTime()) pct = Number(w.percentage) || 0;
    }
    return pct;
}

/** Restaurant's delivered-order earnings (restaurantShare) on one IST day. */
export async function getRestaurantDayEarnings(restaurantId, day) {
    const { start, end } = dayBounds(day);
    const rid = new mongoose.Types.ObjectId(String(restaurantId));
    // Orders can be placed the previous evening and delivered on `day`.
    // pending/authorized are included on purpose: a delivered order is earned even if the
    // ledger row has not been flipped to 'captured' yet (self-heal does that lazily).
    const txs = await FoodTransaction.find({
        restaurantId: rid,
        status: { $in: ['captured', 'pending', 'authorized'] },
        createdAt: { $gte: new Date(start.getTime() - 2 * 86400000), $lt: end }
    })
        .populate('orderId', 'orderStatus deliveryState')
        .select('amounts.restaurantShare createdAt orderId')
        .lean();

    let total = 0;
    let count = 0;
    for (const tx of txs) {
        if (!isDeliveredOrder(tx.orderId)) continue;
        const deliveredAt = tx.orderId?.deliveryState?.deliveredAt || tx.createdAt;
        const t = new Date(deliveredAt).getTime();
        if (t < start.getTime() || t >= end.getTime()) continue;
        total += Number(tx.amounts?.restaurantShare) || 0;
        count += 1;
    }
    return { total: r2(total), count };
}

async function createCharge(ad, day, percentage) {
    const { total, count } = await getRestaurantDayEarnings(ad.restaurantId, day);
    const amount = r2((total * percentage) / 100);

    const doc = {
        entryKey: 'base',
        advertisementId: ad._id,
        adsId: ad.adsId,
        adsTitle: ad.title,
        adsType: ad.adsType,
        restaurantId: ad.restaurantId,
        restaurantName: ad.restaurantName,
        day,
        dayEarnings: total,
        ordersCount: count,
        percentage,
        amount,
        isSettled: !(amount > 0),
        settledAt: amount > 0 ? null : new Date(),
        adminCredited: !(amount > 0)
    };

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const [charge] = await FoodAdvertisementCharge.create([doc], { session });
            if (amount > 0) {
                const { transaction } = await recordTransactionWithSession(
                    {
                        entityType: 'admin',
                        entityId: 'platform',
                        type: 'credit',
                        amount,
                        category: 'commission',
                        description: `Advertisement revenue ${ad.adsId} • ${ad.restaurantName} • ${day} (${percentage}% of ₹${total})`,
                        metadata: {
                            source: 'advertisement',
                            advertisementId: String(ad._id),
                            chargeId: String(charge._id),
                            restaurantId: String(ad.restaurantId),
                            day,
                            percentage,
                            dayEarnings: total
                        }
                    },
                    session
                );
                await FoodAdvertisementCharge.updateOne(
                    { _id: charge._id },
                    {
                        $set: {
                            adminCredited: true,
                            adminTransactionId: transaction?._id ? String(transaction._id) : ''
                        }
                    },
                    { session }
                );
            }
        });
        return true;
    } catch (err) {
        if (err?.code === 11000 || String(err?.message || '').includes('E11000')) return false;
        throw err;
    } finally {
        await session.endSession();
    }
}

/** Insert an adjustment row and move the delta on the admin wallet (same transaction). */
async function createAdjustment({ base, day, percentage, bookedAmount, expectedAmount, delta, earningsDelta, ordersDelta }) {
    const entryKey = `adj:${Math.round(bookedAmount * 100)}>${Math.round(expectedAmount * 100)}`;
    const doc = {
        advertisementId: base.advertisementId,
        adsId: base.adsId,
        adsTitle: base.adsTitle,
        adsType: base.adsType,
        restaurantId: base.restaurantId,
        restaurantName: base.restaurantName,
        day,
        dayEarnings: earningsDelta,
        ordersCount: ordersDelta,
        percentage,
        amount: delta,
        isAdjustment: true,
        entryKey,
        note: delta < 0 ? 'Refund / cancellation adjustment' : 'Late earning adjustment',
        isSettled: false,
        adminCredited: true
    };

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const [row] = await FoodAdvertisementCharge.create([doc], { session });
            const abs = r2(Math.abs(delta));
            const { transaction } = await recordTransactionWithSession(
                {
                    entityType: 'admin',
                    entityId: 'platform',
                    type: delta > 0 ? 'credit' : 'debit',
                    amount: abs,
                    category: 'commission',
                    description: `Advertisement ${delta > 0 ? 'revenue adjustment' : 'revenue reversed (refund/cancel)'} ${base.adsId} • ${base.restaurantName} • ${day}`,
                    metadata: {
                        source: 'advertisement_adjustment',
                        advertisementId: String(base.advertisementId),
                        chargeId: String(row._id),
                        restaurantId: String(base.restaurantId),
                        day,
                        percentage
                    }
                },
                session
            );
            if (delta < 0) {
                // debit path does not touch lifetime revenue — keep it accurate
                await FoodAdminWallet.updateOne({ key: 'platform' }, { $inc: { totalRevenue: -abs } }, { session });
            }
            await FoodAdvertisementCharge.updateOne(
                { _id: row._id },
                { $set: { adminTransactionId: transaction?._id ? String(transaction._id) : '' } },
                { session }
            );
        });
        return true;
    } catch (err) {
        if (err?.code === 11000 || String(err?.message || '').includes('E11000')) return false;
        throw err;
    } finally {
        await session.endSession();
    }
}

/**
 * Re-check recently booked days against the ledger. If a refund / cancellation (or a
 * late delivery) changed that day's earnings, book the difference as an adjustment.
 * Idempotent: once booked total == expected total nothing more is created.
 */
export async function reconcileAdvertisementCharges({ restaurantId = null, adId = null } = {}) {
    const key = `${restaurantId || 'all'}|${adId || ''}`;
    const last = reconcileThrottle.get(key);
    if (last && Date.now() - last < RECONCILE_THROTTLE_MS) return { adjusted: 0 };
    reconcileThrottle.set(key, Date.now());

    const today = istToday();
    const cutoff = dayjs(today).subtract(RECONCILE_DAYS, 'day').format('YYYY-MM-DD');
    const filter = { day: { $gte: cutoff, $lt: today } };
    if (restaurantId) filter.restaurantId = new mongoose.Types.ObjectId(String(restaurantId));
    if (adId) filter.advertisementId = new mongoose.Types.ObjectId(String(adId));

    const rows = await FoodAdvertisementCharge.find(filter).lean();
    const groups = new Map();
    for (const r of rows) {
        const g = groups.get(`${r.advertisementId}|${r.day}`) || { base: null, amount: 0, earnings: 0, orders: 0 };
        if (!r.isAdjustment) g.base = r;
        g.amount += r.amount;
        g.earnings += r.dayEarnings;
        g.orders += r.ordersCount || 0;
        groups.set(`${r.advertisementId}|${r.day}`, g);
    }

    const earningsCache = new Map();
    let adjusted = 0;
    for (const g of groups.values()) {
        const base = g.base;
        if (!base || !(base.percentage > 0)) continue;
        const ek = `${base.restaurantId}|${base.day}`;
        if (!earningsCache.has(ek)) earningsCache.set(ek, await getRestaurantDayEarnings(base.restaurantId, base.day));
        const cur = earningsCache.get(ek);
        const bookedAmount = r2(g.amount);
        const expectedAmount = r2((cur.total * base.percentage) / 100);
        const delta = r2(expectedAmount - bookedAmount);
        if (Math.abs(delta) < 0.01) continue;
        try {
            const created = await createAdjustment({
                base,
                day: base.day,
                percentage: base.percentage,
                bookedAmount,
                expectedAmount,
                delta,
                earningsDelta: r2(cur.total - g.earnings),
                ordersDelta: cur.count - g.orders
            });
            if (created) adjusted += 1;
        } catch (err) {
            logger.error(`[AdBilling] adjustment failed ad=${base.adsId} day=${base.day}: ${err?.message || err}`);
        }
    }
    return { adjusted };
}

let settleInFlight = null;

/**
 * Create charge rows for every completed, not-yet-charged live day.
 * Safe to call repeatedly / concurrently (unique index + single in-flight run).
 */
export async function settleAdvertisementCharges({ restaurantId = null, adId = null } = {}) {
    if (settleInFlight && !restaurantId && !adId) return settleInFlight;

    const run = async () => {
        await dropLegacyChargeIndex();
        const summary = { charged: 0, amount: 0, errors: 0, adjusted: 0 };
        const today = istToday();
        const filter = { 'billingWindows.0': { $exists: true } };
        if (restaurantId) {
            if (!mongoose.Types.ObjectId.isValid(String(restaurantId))) return summary;
            filter.restaurantId = new mongoose.Types.ObjectId(String(restaurantId));
        }
        if (adId) filter._id = new mongoose.Types.ObjectId(String(adId));

        const ads = await FoodAdvertisement.find(filter).lean();
        for (const ad of ads) {
            if (!isBillableAdType(ad.adsType)) continue;
            const { startDay, endDay } = getAdCampaignDays(ad);
            if (!startDay) continue;

            const firstLive = dayjs(ad.billingWindows[0].from).tz(IST).format('YYYY-MM-DD');
            let day = startDay > firstLive ? startDay : firstLive;
            const lastDay = endDay && endDay < today ? endDay : dayjs(today).subtract(1, 'day').format('YYYY-MM-DD');
            if (day > lastDay) continue;

            const existing = new Set(
                (await FoodAdvertisementCharge.find({ advertisementId: ad._id }).select('day').lean()).map(
                    (c) => c.day
                )
            );

            for (let i = 0; i < MAX_BILLING_DAYS_PER_AD && day <= lastDay; i += 1) {
                if (!existing.has(day)) {
                    const pct = percentageForDay(ad, day);
                    if (pct != null && pct > 0) {
                        try {
                            const created = await createCharge(ad, day, pct);
                            if (created) summary.charged += 1;
                        } catch (err) {
                            summary.errors += 1;
                            logger.error(`[AdBilling] charge failed ad=${ad.adsId} day=${day}: ${err?.message || err}`);
                        }
                    }
                }
                day = dayjs(day).add(1, 'day').format('YYYY-MM-DD');
            }
        }
        try {
            const rec = await reconcileAdvertisementCharges({ restaurantId, adId });
            summary.adjusted = rec.adjusted;
        } catch (err) {
            summary.errors += 1;
            logger.error(`[AdBilling] reconcile failed: ${err?.message || err}`);
        }
        return summary;
    };

    if (restaurantId || adId) return run();
    settleInFlight = run().finally(() => {
        settleInFlight = null;
    });
    return settleInFlight;
}

/** Sum of charges the restaurant has not yet paid through a withdrawal. */
export async function getOutstandingAdCharges(restaurantId, { session = null } = {}) {
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) return 0;
    const agg = FoodAdvertisementCharge.aggregate(
        [
            {
                $match: {
                    restaurantId: new mongoose.Types.ObjectId(String(restaurantId)),
                    isSettled: false
                }
            },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ],
        session ? { session } : undefined
    );
    const rows = await agg;
    return r2(rows?.[0]?.total || 0);
}

/**
 * Mark oldest outstanding charges settled (called inside the withdrawal settle txn).
 * Only charges that still fit inside `budget` are consumed; the rest stay outstanding.
 */
export async function consumeOutstandingAdCharges(restaurantId, budget, { session, withdrawalId = null } = {}) {
    const rid = new mongoose.Types.ObjectId(String(restaurantId));
    const charges = await FoodAdvertisementCharge.find({ restaurantId: rid, isSettled: false })
        .sort({ day: 1, createdAt: 1 })
        .session(session);

    // Credits (negative adjustments from refunds/cancels) are always applied — they
    // reduce what the restaurant owes. Positive charges only while they still fit.
    let used = 0;
    const ids = [];
    for (const c of charges) {
        if (c.amount < 0) {
            used = r2(used + c.amount);
            ids.push(c._id);
        }
    }
    for (const c of charges) {
        if (!(c.amount > 0)) continue;
        const next = r2(used + c.amount);
        if (next > budget + 0.009) break;
        used = next;
        ids.push(c._id);
    }
    if (ids.length) {
        await FoodAdvertisementCharge.updateMany(
            { _id: { $in: ids }, isSettled: false },
            { $set: { isSettled: true, settledAt: new Date(), settledWithdrawalId: withdrawalId } },
            { session }
        );
    }
    return { total: used, count: ids.length };
}

async function liveAdsToday(filter) {
    const today = istToday();
    const ads = await FoodAdvertisement.find({
        ...filter,
        isDeleted: false,
        status: 'Approved',
        'billingWindows.0': { $exists: true }
    }).lean();
    return ads.filter((ad) => {
        if (!isBillableAdType(ad.adsType)) return false;
        const { startDay, endDay } = getAdCampaignDays(ad);
        if (!startDay || today < startDay || (endDay && today > endDay)) return false;
        return (percentageForDay(ad, today) || 0) > 0;
    });
}

/** Live (not yet charged) accrual for today, per ad. */
async function todayAccruals(filter) {
    const today = istToday();
    const ads = await liveAdsToday(filter);
    const cache = new Map();
    const rows = [];
    for (const ad of ads) {
        const key = String(ad.restaurantId);
        if (!cache.has(key)) cache.set(key, await getRestaurantDayEarnings(ad.restaurantId, today));
        const earn = cache.get(key);
        const pct = percentageForDay(ad, today) || 0;
        rows.push({
            advertisementId: String(ad._id),
            adsId: ad.adsId,
            adsTitle: ad.title,
            adsType: ad.adsType,
            restaurantId: String(ad.restaurantId),
            restaurantName: ad.restaurantName,
            day: today,
            dayEarnings: earn.total,
            ordersCount: earn.count,
            percentage: pct,
            amount: r2((earn.total * pct) / 100),
            isEstimate: true
        });
    }
    return rows;
}

function chargeView(c) {
    return {
        id: String(c._id),
        advertisementId: String(c.advertisementId),
        adsId: c.adsId,
        adsTitle: c.adsTitle,
        adsType: c.adsType,
        restaurantId: String(c.restaurantId),
        restaurantName: c.restaurantName,
        day: c.day,
        dayEarnings: r2(c.dayEarnings),
        ordersCount: c.ordersCount || 0,
        percentage: c.percentage,
        amount: r2(c.amount),
        isSettled: Boolean(c.isSettled),
        isAdjustment: Boolean(c.isAdjustment),
        note: c.note || '',
        isEstimate: false
    };
}

function buildChargeFilter({ restaurantId, adId, from, to } = {}) {
    const f = {};
    if (restaurantId) f.restaurantId = new mongoose.Types.ObjectId(String(restaurantId));
    if (adId) f.advertisementId = new mongoose.Types.ObjectId(String(adId));
    const dayRe = /^\d{4}-\d{2}-\d{2}$/;
    if (from && dayRe.test(from)) f.day = { ...(f.day || {}), $gte: from };
    if (to && dayRe.test(to)) f.day = { ...(f.day || {}), $lte: to };
    return f;
}

async function sumCharges(match) {
    const rows = await FoodAdvertisementCharge.aggregate([
        { $match: match },
        {
            $group: {
                _id: null,
                total: { $sum: '$amount' },
                outstanding: { $sum: { $cond: [{ $eq: ['$isSettled', false] }, '$amount', 0] } },
                days: { $sum: { $cond: [{ $eq: ['$isAdjustment', true] }, 0, 1] } },
                earnings: { $sum: '$dayEarnings' }
            }
        }
    ]);
    const row = rows[0] || {};
    return {
        totalCharged: r2(row.total),
        outstanding: r2(row.outstanding),
        paidOut: r2((row.total || 0) - (row.outstanding || 0)),
        chargedDays: row.days || 0,
        earningsBase: r2(row.earnings)
    };
}

/** Restaurant-facing ad billing: totals, live accrual and per-day charge rows. */
export async function getRestaurantAdBilling(restaurantId, query = {}) {
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) {
        throw new ValidationError('Invalid restaurant');
    }
    await settleAdvertisementCharges({ restaurantId });

    const rid = new mongoose.Types.ObjectId(String(restaurantId));
    const match = buildChargeFilter({ restaurantId: rid, adId: query.adId, from: query.from, to: query.to });
    const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 60));

    const [restaurant, totals, allTimeTotals, rows, accruals] = await Promise.all([
        FoodRestaurant.findById(rid).select('adCommissionPercentage').lean(),
        sumCharges(match),
        sumCharges({ restaurantId: rid }),
        FoodAdvertisementCharge.find(match).sort({ day: -1, createdAt: -1 }).limit(limit).lean(),
        todayAccruals({ restaurantId: rid, ...(query.adId ? { _id: query.adId } : {}) })
    ]);

    return {
        percentage: Number(restaurant?.adCommissionPercentage) || 0,
        totals,
        allTimeTotals,
        todayAccrual: r2(accruals.reduce((s, a) => s + a.amount, 0)),
        todayAds: accruals,
        charges: rows.map(chargeView)
    };
}

/** Per-ad charge totals keyed by ad id (used to decorate ad lists). */
export async function getAdChargeTotalsByAd(adIds = []) {
    const ids = adIds
        .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
        .map((id) => new mongoose.Types.ObjectId(String(id)));
    if (!ids.length) return new Map();
    const rows = await FoodAdvertisementCharge.aggregate([
        { $match: { advertisementId: { $in: ids } } },
        {
            $group: {
                _id: '$advertisementId',
                total: { $sum: '$amount' },
                outstanding: { $sum: { $cond: [{ $eq: ['$isSettled', false] }, '$amount', 0] } },
                days: { $sum: { $cond: [{ $eq: ['$isAdjustment', true] }, 0, 1] } }
            }
        }
    ]);
    return new Map(
        rows.map((r) => [
            String(r._id),
            { totalCharged: r2(r.total), outstanding: r2(r.outstanding), chargedDays: r.days }
        ])
    );
}

/** Admin-facing ad revenue: totals, per-restaurant breakdown and charge rows. */
export async function getAdminAdBilling(query = {}) {
    await settleAdvertisementCharges();

    const restaurantId =
        query.restaurantId && mongoose.Types.ObjectId.isValid(String(query.restaurantId))
            ? String(query.restaurantId)
            : null;
    const match = buildChargeFilter({ restaurantId, adId: query.adId, from: query.from, to: query.to });
    const limit = Math.min(500, Math.max(1, parseInt(query.limit, 10) || 100));
    const today = istToday();
    const accrualFilter = restaurantId ? { restaurantId: new mongoose.Types.ObjectId(restaurantId) } : {};

    const [totals, todayTotals, byRestaurant, rows, accruals] = await Promise.all([
        sumCharges(match),
        sumCharges({ ...buildChargeFilter({ restaurantId }), day: today }),
        FoodAdvertisementCharge.aggregate([
            { $match: match },
            {
                $group: {
                    _id: '$restaurantId',
                    restaurantName: { $last: '$restaurantName' },
                    total: { $sum: '$amount' },
                    outstanding: { $sum: { $cond: [{ $eq: ['$isSettled', false] }, '$amount', 0] } },
                    days: { $sum: { $cond: [{ $eq: ['$isAdjustment', true] }, 0, 1] } },
                    ads: { $addToSet: '$advertisementId' }
                }
            },
            { $sort: { total: -1 } },
            { $limit: 200 }
        ]),
        FoodAdvertisementCharge.find(match).sort({ day: -1, createdAt: -1 }).limit(limit).lean(),
        todayAccruals(accrualFilter)
    ]);

    return {
        totals: {
            ...totals,
            todayAccrual: r2(accruals.reduce((s, a) => s + a.amount, 0))
        },
        byRestaurant: byRestaurant.map((r) => ({
            restaurantId: String(r._id),
            restaurantName: r.restaurantName,
            totalCharged: r2(r.total),
            outstanding: r2(r.outstanding),
            paidOut: r2(r.total - r.outstanding),
            chargedDays: r.days,
            adsCount: r.ads.length
        })),
        todayAds: accruals,
        charges: rows.map(chargeView)
    };
}

/** Lightweight lifetime/period number for the admin dashboard tile. */
export async function getAdRevenueForDashboard(range = null) {
    const match = {};
    if (range?.start && range?.end) {
        match.day = {
            $gte: dayjs(range.start).tz(IST).format('YYYY-MM-DD'),
            $lte: dayjs(range.end).tz(IST).format('YYYY-MM-DD')
        };
    }
    const totals = await sumCharges(match);
    return { total: totals.totalCharged, days: totals.chargedDays };
}

/** Admin: per-restaurant ad percentage list. */
export async function listRestaurantAdSettings(query = {}) {
    const filter = { isDeleted: { $ne: true } };
    const search = String(query.search || '').trim();
    if (search) {
        filter.restaurantName = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }
    const restaurants = await FoodRestaurant.find(filter)
        .select('restaurantName ownerPhone adCommissionPercentage status')
        .sort({ restaurantName: 1 })
        .limit(Math.min(500, parseInt(query.limit, 10) || 200))
        .lean();
    return restaurants.map((r) => ({
        restaurantId: String(r._id),
        restaurantName: r.restaurantName || 'Restaurant',
        ownerPhone: r.ownerPhone || '',
        status: r.status || '',
        adCommissionPercentage: Number(r.adCommissionPercentage) || 0
    }));
}

export async function setRestaurantAdPercentage(restaurantId, value) {
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) {
        throw new ValidationError('Invalid restaurant');
    }
    const pct = Number(value);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        throw new ValidationError('Percentage must be between 0 and 100');
    }
    const updated = await FoodRestaurant.findByIdAndUpdate(
        restaurantId,
        { $set: { adCommissionPercentage: r2(pct) } },
        { new: true }
    )
        .select('restaurantName adCommissionPercentage')
        .lean();
    if (!updated) throw new ValidationError('Restaurant not found');
    return {
        restaurantId: String(updated._id),
        restaurantName: updated.restaurantName,
        adCommissionPercentage: updated.adCommissionPercentage
    };
}

export async function getRestaurantAdPercentage(restaurantId) {
    const r = await FoodRestaurant.findById(restaurantId).select('adCommissionPercentage').lean();
    return Number(r?.adCommissionPercentage) || 0;
}
