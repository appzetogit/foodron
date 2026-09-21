import mongoose from 'mongoose';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { FoodAdvertisement, ADS_TYPE_OPTIONS } from '../../admin/models/advertisement.model.js';
import {
    settleAdvertisementCharges,
    getAdChargeTotalsByAd,
    getAdCampaignDays,
    istToday,
    isBillableAdType
} from '../../admin/services/advertisementBilling.service.js';
import { FoodRestaurant } from '../models/restaurant.model.js';
import {
    uploadImageBufferDetailed,
    destroyAsset
} from '../../../../services/upload.service.js';

dayjs.extend(utc);
dayjs.extend(timezone);
const IST = 'Asia/Kolkata';

function generateAdsId() {
    const suffix = Date.now().toString(36).toUpperCase().slice(-6);
    const rand = Math.random().toString(36).toUpperCase().slice(2, 5);
    return `AD-${suffix}${rand}`;
}

function parseValidity(validity, { allowPastStart = false } = {}) {
    const raw = String(validity || '').trim();
    if (!raw) return { validity: '', startDate: null, endDate: null };

    // Preferred path: "YYYY-MM-DD" or "YYYY-MM-DD to YYYY-MM-DD" as IST calendar days,
    // so display/expiry/public visibility line up exactly with the daily billing days.
    const days = raw.match(/\d{4}-\d{2}-\d{2}/g);
    if (days && days.length) {
        const first = days[0];
        const last = days[1] || days[0];
        if (last < first) {
            throw new ValidationError('Validity end date must be on or after start date');
        }
        if (!allowPastStart && first < istToday()) {
            throw new ValidationError('Start date cannot be in the past');
        }
        return {
            validity: raw,
            startDate: dayjs.tz(first, IST).startOf('day').toDate(),
            endDate: dayjs.tz(last, IST).endOf('day').toDate()
        };
    }

    // Legacy free-form input
    const parts = raw.split(/\s+to\s+|\s+-\s+/i).map((p) => p.trim()).filter(Boolean);
    const start = parts[0] ? new Date(parts[0]) : null;
    const end = parts[1] ? new Date(parts[1]) : start ? new Date(parts[0]) : null;

    const startDate = start && !Number.isNaN(start.getTime()) ? start : null;
    let endDate = end && !Number.isNaN(end.getTime()) ? end : null;
    if (startDate && endDate && endDate < startDate) {
        throw new ValidationError('Validity end date must be on or after start date');
    }
    if (startDate && !allowPastStart) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const startDay = new Date(startDate);
        startDay.setHours(0, 0, 0, 0);
        if (startDay < today) {
            throw new ValidationError('Start date cannot be in the past');
        }
    }
    if (endDate) {
        endDate = new Date(endDate);
        endDate.setHours(23, 59, 59, 999);
    }

    return { validity: raw, startDate, endDate };
}

function displayStatus(ad) {
    if (!ad) return 'Pending';
    if (ad.status === 'Pending') return 'Pending';
    if (ad.status === 'Rejected') return 'Rejected';
    if (ad.status === 'Paused') return 'Paused';
    if (ad.status === 'Approved') {
        const now = Date.now();
        const end = ad.endDate ? new Date(ad.endDate).getTime() : Number.POSITIVE_INFINITY;
        if (now > end) return 'Expired';
        return 'Approved';
    }
    return ad.status;
}

function formatDate(value) {
    if (!value) return 'N/A';
    try {
        return new Date(value).toLocaleDateString('en-IN', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        });
    } catch {
        return 'N/A';
    }
}

/**
 * Billing block shown on every ad row. `restaurantPct` is the admin-set rate for the
 * restaurant (used while the ad is not live yet); once live the snapshotted rate wins.
 */
function buildBillingView(obj, totals, restaurantPct = 0) {
    const billable = isBillableAdType(obj.adsType);
    const live = Array.isArray(obj.billingWindows) && obj.billingWindows.length > 0;
    const percentage = billable ? (live ? Number(obj.adCommissionPercentage) || 0 : Number(restaurantPct) || 0) : 0;
    const chargedTotal = Number(totals?.totalCharged) || 0;
    const outstanding = Number(totals?.outstanding) || 0;

    // Payment label mirrors the ad lifecycle so it never claims "accruing" for an ad
    // that is not running (pending / rejected / paused / expired).
    const lifecycle = displayStatus(obj);
    let paymentStatus;
    if (!billable || percentage <= 0) paymentStatus = chargedTotal > 0 ? 'Charged' : 'Free';
    else if (lifecycle === 'Pending') paymentStatus = 'Starts after approval';
    else if (lifecycle === 'Rejected') paymentStatus = chargedTotal > 0 ? 'Charged' : 'Not charged';
    else if (lifecycle === 'Paused') paymentStatus = chargedTotal > 0 ? 'Charged (paused)' : 'Paused - not charged';
    else if (lifecycle === 'Expired') paymentStatus = chargedTotal > 0 ? 'Charged' : 'Not charged';
    else paymentStatus = chargedTotal > 0 ? 'Charged' : 'Accruing';
    return {
        billable,
        adCommissionPercentage: percentage,
        chargedTotal,
        chargedOutstanding: outstanding,
        chargedPaidOut: Math.round((chargedTotal - outstanding) * 100) / 100,
        chargedDays: Number(totals?.chargedDays) || 0,
        paymentStatus
    };
}

async function loadBillingContext(ads) {
    const totalsMap = await getAdChargeTotalsByAd(ads.map((a) => a._id));
    const restaurantIds = [...new Set(ads.map((a) => String(a.restaurantId)))];
    const restaurants = restaurantIds.length
        ? await FoodRestaurant.find({ _id: { $in: restaurantIds } })
              .select('adCommissionPercentage')
              .lean()
        : [];
    const pctMap = new Map(restaurants.map((r) => [String(r._id), Number(r.adCommissionPercentage) || 0]));
    return { totalsMap, pctMap };
}

function billingFor(obj, ctx) {
    return buildBillingView(obj, ctx.totalsMap.get(String(obj._id)), ctx.pctMap.get(String(obj.restaurantId)));
}

function toRestaurantView(ad, billing = null) {
    const obj = ad?.toObject ? ad.toObject() : { ...ad };
    const id = String(obj._id);
    return {
        ...obj,
        id,
        _id: obj._id,
        adsId: obj.adsId,
        type: obj.adsType,
        status: displayStatus(obj),
        lifecycleStatus: obj.status,
        adsPlaced: formatDate(obj.createdAt),
        adsCreated: formatDate(obj.createdAt),
        adsDetails: obj.adsType,
        ...(billing || buildBillingView(obj, null, 0)),
        pauseNote: obj.status === 'Paused' ? 'Paused by restaurant' : '—',
        billingWindows: undefined,
        duration: {
            start: formatDate(obj.startDate) !== 'N/A' ? formatDate(obj.startDate) : (obj.validity || 'N/A'),
            end: formatDate(obj.endDate) !== 'N/A' ? formatDate(obj.endDate) : (obj.validity || 'N/A')
        }
    };
}

function toAdminListView(ad, index = 0, billing = null) {
    const obj = ad?.toObject ? ad.toObject() : { ...ad };
    return {
        ...(billing || buildBillingView(obj, null, 0)),
        restaurantId: obj.restaurantId,
        sl: index + 1,
        _id: obj._id,
        adsId: obj.adsId,
        adsTitle: obj.title,
        restaurantName: obj.restaurantName,
        restaurantEmail: obj.restaurantEmail || '',
        adsType: obj.adsType,
        duration: obj.validity || (
            obj.endDate
                ? new Date(obj.endDate).toISOString().slice(0, 10)
                : 'N/A'
        ),
        status: displayStatus(obj),
        lifecycleStatus: obj.status,
        priority: obj.priority || '2',
        imageUrl: obj.imageUrl || '',
        description: obj.description || '',
        createdAt: obj.createdAt
    };
}

function toAdminRequestView(ad, index = 0, billing = null) {
    const obj = ad?.toObject ? ad.toObject() : { ...ad };
    let requestStatus = 'new';
    if (obj.status === 'Rejected') requestStatus = 'denied';
    else if (obj.status === 'Approved' || obj.status === 'Paused') requestStatus = 'approved';
    else if (obj.requestType === 'update') requestStatus = 'update';
    else requestStatus = 'new';

    return {
        ...(billing || buildBillingView(obj, null, 0)),
        restaurantId: obj.restaurantId,
        sl: index + 1,
        _id: obj._id,
        adsId: obj.adsId,
        adsTitle: obj.title,
        restaurantName: obj.restaurantName,
        restaurantEmail: obj.restaurantEmail || '',
        adsType: obj.adsType,
        duration: obj.validity || 'N/A',
        status: requestStatus,
        lifecycleStatus: obj.status,
        requestType: obj.requestType,
        priority: obj.priority || '2',
        imageUrl: obj.imageUrl || '',
        description: obj.description || '',
        createdAt: obj.createdAt
    };
}

async function destroyCloudinary(publicId, resourceType = 'image') {
    await destroyAsset(publicId, resourceType);
}

async function uploadMediaFromFiles(files = {}) {
    const result = {};
    const imageFile = Array.isArray(files.image) ? files.image[0] : files.image;

    try {
        if (imageFile?.buffer) {
            const uploaded = await uploadImageBufferDetailed(imageFile.buffer, 'food/advertisements');
            result.imageUrl = uploaded.secure_url;
            result.imagePublicId = uploaded.public_id;
        }
    } catch (error) {
        const message = String(error?.message || '').trim();
        throw new ValidationError(
            message
                ? `Failed to upload advertisement media: ${message}`
                : 'Failed to upload advertisement media. Please try again.'
        );
    }

    return result;
}

function normalizePayload(body = {}, { allowPastStart = false } = {}) {
    const title = String(body.title || '').trim();
    if (!title) throw new ValidationError('Title is required');

    const adsType = String(body.adsType || body.category || '').trim();
    if (!ADS_TYPE_OPTIONS.includes(adsType)) {
        throw new ValidationError(`Invalid ads type. Allowed: ${ADS_TYPE_OPTIONS.join(', ')}`);
    }

    const { validity, startDate, endDate } = parseValidity(body.validity, { allowPastStart });
    if (!validity) {
        throw new ValidationError('Validity is required');
    }

    return {
        title,
        description: String(body.description || '').trim(),
        adsType,
        fileDescription: String(body.fileDescription || '').trim(),
        validity,
        startDate,
        endDate
    };
}

export async function listRestaurantAdvertisements(restaurantId) {
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) {
        throw new ValidationError('Invalid restaurant');
    }

    // Book any completed ad days first so charged totals are current.
    await settleAdvertisementCharges({ restaurantId }).catch(() => null);

    const ads = await FoodAdvertisement.find({
        restaurantId,
        isDeleted: false
    })
        .sort({ createdAt: -1 })
        .lean();

    const ctx = await loadBillingContext(ads);
    return ads.map((ad) => toRestaurantView(ad, billingFor(ad, ctx)));
}

export async function getRestaurantAdvertisement(restaurantId, adId) {
    if (!mongoose.Types.ObjectId.isValid(String(adId))) {
        throw new ValidationError('Invalid advertisement id');
    }

    const ad = await FoodAdvertisement.findOne({
        _id: adId,
        restaurantId,
        isDeleted: false
    }).lean();

    if (!ad) throw new ValidationError('Advertisement not found');
    await settleAdvertisementCharges({ restaurantId, adId: ad._id }).catch(() => null);
    const ctx = await loadBillingContext([ad]);
    return toRestaurantView(ad, billingFor(ad, ctx));
}

export async function createRestaurantAdvertisement(restaurantId, body, files = {}) {
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) {
        throw new ValidationError('Invalid restaurant');
    }

    const restaurant = await FoodRestaurant.findById(restaurantId)
        .select('restaurantName ownerEmail')
        .lean();
    if (!restaurant) throw new ValidationError('Restaurant not found');

    const payload = normalizePayload(body);
    const media = await uploadMediaFromFiles(files);

    if (!media.imageUrl) {
        throw new ValidationError('Image file is required for this advertisement type');
    }

    let adsId = generateAdsId();
    for (let i = 0; i < 3; i += 1) {
        const exists = await FoodAdvertisement.exists({ adsId });
        if (!exists) break;
        adsId = generateAdsId();
    }

    const created = await FoodAdvertisement.create({
        restaurantId,
        restaurantName: restaurant.restaurantName || 'Restaurant',
        restaurantEmail: restaurant.ownerEmail || '',
        adsId,
        ...payload,
        ...media,
        priority: '2',
        status: 'Pending',
        requestType: 'new'
    });

    return toRestaurantView(created);
}

export async function updateRestaurantAdvertisement(restaurantId, adId, body, files = {}) {
    if (!mongoose.Types.ObjectId.isValid(String(adId))) {
        throw new ValidationError('Invalid advertisement id');
    }

    const existing = await FoodAdvertisement.findOne({
        _id: adId,
        restaurantId,
        isDeleted: false
    });
    if (!existing) throw new ValidationError('Advertisement not found');

    const payload = normalizePayload({
        title: body.title ?? existing.title,
        description: body.description ?? existing.description,
        adsType: body.adsType || body.category || existing.adsType,
        validity: body.validity ?? existing.validity,
        fileDescription: body.fileDescription ?? existing.fileDescription
    }, { allowPastStart: true });

    const media = await uploadMediaFromFiles(files);
    if (!media.imageUrl && !existing.imageUrl) {
        throw new ValidationError('Image file is required for this advertisement type');
    }

    if (media.imageUrl && existing.imagePublicId) {
        await destroyCloudinary(existing.imagePublicId, 'image');
    }
    // Legacy video ads: drop the old video asset once the ad is converted to an image ad.
    if (existing.videoPublicId) {
        await destroyCloudinary(existing.videoPublicId, 'video');
        existing.videoUrl = '';
        existing.videoPublicId = '';
    }

    Object.assign(existing, payload, media, {
        status: 'Pending',
        requestType: 'update'
    });

    await existing.save();
    return toRestaurantView(existing);
}

export async function deleteRestaurantAdvertisement(restaurantId, adId) {
    if (!mongoose.Types.ObjectId.isValid(String(adId))) {
        throw new ValidationError('Invalid advertisement id');
    }

    const existing = await FoodAdvertisement.findOne({
        _id: adId,
        restaurantId,
        isDeleted: false
    });
    if (!existing) throw new ValidationError('Advertisement not found');

    existing.isDeleted = true;
    existing.status = 'Paused';
    await existing.save();
    return { deleted: true, id: String(existing._id) };
}

export async function pauseRestaurantAdvertisement(restaurantId, adId) {
    if (!mongoose.Types.ObjectId.isValid(String(adId))) {
        throw new ValidationError('Invalid advertisement id');
    }

    const existing = await FoodAdvertisement.findOne({
        _id: adId,
        restaurantId,
        isDeleted: false
    });
    if (!existing) throw new ValidationError('Advertisement not found');
    if (existing.status !== 'Approved' && existing.status !== 'Paused') {
        throw new ValidationError('Only approved advertisements can be paused');
    }

    existing.status = existing.status === 'Paused' ? 'Approved' : 'Paused';
    await existing.save();
    return toRestaurantView(existing);
}

export async function listAdminAdvertisements() {
    await settleAdvertisementCharges().catch(() => null);
    const ads = await FoodAdvertisement.find({ isDeleted: false })
        .sort({ createdAt: -1 })
        .lean();
    const ctx = await loadBillingContext(ads);
    return ads.map((ad, idx) => toAdminListView(ad, idx, billingFor(ad, ctx)));
}

export async function createAdminAdvertisement(body = {}, files = {}) {
    const restaurantId = body.restaurantId;
    if (!restaurantId || !mongoose.Types.ObjectId.isValid(String(restaurantId))) {
        throw new ValidationError('Restaurant is required');
    }

    const restaurant = await FoodRestaurant.findById(restaurantId)
        .select('restaurantName ownerEmail')
        .lean();
    if (!restaurant) throw new ValidationError('Restaurant not found');

    const payload = normalizePayload(body);
    const media = await uploadMediaFromFiles(files);

    if (!media.imageUrl) {
        throw new ValidationError('Image file is required for this advertisement type');
    }

    const priority = ['1', '2', '3'].includes(String(body.priority)) ? String(body.priority) : '2';
    const autoApprove = body.autoApprove !== false && body.autoApprove !== 'false';

    let adsId = generateAdsId();
    for (let i = 0; i < 3; i += 1) {
        const exists = await FoodAdvertisement.exists({ adsId });
        if (!exists) break;
        adsId = generateAdsId();
    }

    const created = await FoodAdvertisement.create({
        restaurantId,
        restaurantName: restaurant.restaurantName || 'Restaurant',
        restaurantEmail: restaurant.ownerEmail || '',
        adsId,
        ...payload,
        ...media,
        priority,
        status: autoApprove ? 'Approved' : 'Pending',
        requestType: 'new'
    });

    return toAdminListView(created.toObject ? created.toObject() : created);
}

export async function listAdminAdvertisementRequests() {
    const all = await FoodAdvertisement.find({ isDeleted: false })
        .sort({ createdAt: -1 })
        .lean();

    const ctx = await loadBillingContext(all);
    return all.map((ad, idx) => toAdminRequestView(ad, idx, billingFor(ad, ctx)));
}

export async function updateAdminAdvertisementStatus(adId, status) {
    if (!mongoose.Types.ObjectId.isValid(String(adId))) {
        throw new ValidationError('Invalid advertisement id');
    }

    const normalized =
        status === 'approved' || status === 'Approved'
            ? 'Approved'
            : status === 'denied' || status === 'Rejected'
              ? 'Rejected'
              : null;

    if (!normalized) {
        throw new ValidationError('Status must be Approved or Rejected');
    }

    // save() (not findOneAndUpdate) so the billing-window hook opens/closes the window.
    const ad = await FoodAdvertisement.findOne({ _id: adId, isDeleted: false });
    if (!ad) throw new ValidationError('Advertisement not found');

    if (normalized === 'Approved' && ad.status !== 'Approved') {
        // Billing starts at approval, so never "approve" something that cannot run.
        if (ad.status === 'Paused') {
            throw new ValidationError('This advertisement is paused by the restaurant. They must resume it.');
        }
        const { endDay } = getAdCampaignDays(ad);
        if (endDay && endDay < istToday()) {
            throw new ValidationError('Advertisement validity has already ended');
        }
    }
    ad.status = normalized;
    await ad.save();

    const updated = ad.toObject();
    const ctx = await loadBillingContext([updated]);
    return toAdminRequestView(updated, 0, billingFor(updated, ctx));
}

export async function updateAdminAdvertisementPriority(adId, priority) {
    if (!mongoose.Types.ObjectId.isValid(String(adId))) {
        throw new ValidationError('Invalid advertisement id');
    }
    const p = String(priority);
    if (!['1', '2', '3'].includes(p)) {
        throw new ValidationError('Priority must be 1, 2, or 3');
    }

    const updated = await FoodAdvertisement.findOneAndUpdate(
        { _id: adId, isDeleted: false },
        { $set: { priority: p } },
        { new: true }
    ).lean();

    if (!updated) throw new ValidationError('Advertisement not found');
    return toAdminListView(updated);
}

export async function deleteAdminAdvertisement(adId) {
    if (!mongoose.Types.ObjectId.isValid(String(adId))) {
        throw new ValidationError('Invalid advertisement id');
    }

    // Book completed live days before the ad disappears from billing queries.
    await settleAdvertisementCharges({ adId }).catch(() => null);

    const ad = await FoodAdvertisement.findOne({ _id: adId, isDeleted: false });
    if (!ad) throw new ValidationError('Advertisement not found');
    ad.isDeleted = true;
    ad.status = 'Paused';
    await ad.save();
    return { deleted: true, id: String(ad._id) };
}

export async function updateAdminAdvertisement(adId, body, files = {}) {
    if (!mongoose.Types.ObjectId.isValid(String(adId))) {
        throw new ValidationError('Invalid advertisement id');
    }

    const existing = await FoodAdvertisement.findOne({
        _id: adId,
        isDeleted: false
    });
    if (!existing) throw new ValidationError('Advertisement not found');

    const payload = normalizePayload({
        title: body.title ?? existing.title,
        description: body.description ?? existing.description,
        adsType: body.adsType || body.category || existing.adsType,
        validity: body.validity ?? existing.validity,
        fileDescription: body.fileDescription ?? existing.fileDescription
    }, { allowPastStart: true });

    const media = await uploadMediaFromFiles(files);
    if (!media.imageUrl && !existing.imageUrl) {
        throw new ValidationError('Image file is required for this advertisement type');
    }

    if (media.imageUrl && existing.imagePublicId) {
        await destroyCloudinary(existing.imagePublicId, 'image');
    }
    // Legacy video ads: drop the old video asset once the ad is converted to an image ad.
    if (existing.videoPublicId) {
        await destroyCloudinary(existing.videoPublicId, 'video');
        existing.videoUrl = '';
        existing.videoPublicId = '';
    }

    Object.assign(existing, payload, media);

    await existing.save();
    return toAdminListView(existing);
}

