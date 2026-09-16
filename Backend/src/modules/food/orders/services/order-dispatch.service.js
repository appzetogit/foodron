import mongoose from "mongoose";
import { FoodOrder, FoodSettings } from "../models/order.model.js";
import { FoodRestaurant } from "../../restaurant/models/restaurant.model.js";
import { FoodDeliveryPartner } from "../../delivery/models/deliveryPartner.model.js";
import { getDeliveryPartnerWalletEnhanced } from "../../delivery/services/deliveryFinance.service.js";
import { FoodDailyPass } from "../../subscriptions/models/foodDailyPass.model.js";
import { UserSubscription } from "../../user/models/userSubscription.model.js";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone.js";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);
dayjs.extend(timezone);
import {
  ValidationError,
  NotFoundError,
} from "../../../../core/auth/errors.js";
import { logger } from "../../../../utils/logger.js";
import { config } from "../../../../config/env.js";
import { getIO, rooms } from "../../../../config/socket.js";
import { addOrderJob } from "../../../../queues/producers/order.producer.js";
import {
  buildDeliverySocketPayload,
  buildOrderIdentityFilter,
  roadDistanceKm,
  isTerminalOrderStatus,
  notifyOwnerSafely,
  notifyOwnersSafely,
} from "./order.helpers.js";
import { scorePointsByRoadDistance } from "../../../../services/roadDistance.service.js";

/** Only document type this dispatch engine handles now that Quick Commerce return-pickup dispatch is gone. */
const FORWARD_ORDER_DOCUMENT_TYPE = "forward_order";

export async function filterEligiblePartners(partners) {
  if (!partners.length) return [];
  const partnerIds = partners.map(p => p.partnerId);
  const today = dayjs().tz("Asia/Kolkata").format("YYYY-MM-DD");
  
  const [activePasses, activeSubs] = await Promise.all([
    FoodDailyPass.find({
      userId: { $in: partnerIds },
      userType: "DELIVERY_PARTNER",
      date: today,
      expiresAt: { $gt: new Date() }
    }).select("userId").lean(),
    UserSubscription.find({
      deliveryBoyId: { $in: partnerIds },
      status: { $in: ["active", "grace"] }
    }).select("deliveryBoyId").lean()
  ]);

  const subEligibleIds = new Set([
    ...activePasses.map(p => p.userId.toString()),
    ...activeSubs.map(s => s.deliveryBoyId.toString())
  ]);

  // Use a bypassed subscription list if needed, or strictly use subEligibleIds.
  // For now, we apply both subscription eligibility AND cash limit eligibility.
  const fullyEligiblePartners = [];
  
  for (const p of partners) {
    const isSubEligible = subEligibleIds.has(p.partnerId.toString());
    
    // Check cash limit
    try {
      // Use the SAME wallet calculation as the frontend UI (getDeliveryPartnerWalletEnhanced)
      // The old getDeliveryPartnerWallet only counted payment.status:'paid' COD orders
      // which caused cashInHand to appear as ₹0 even when rider had thousands in hand.
      const wallet = await getDeliveryPartnerWalletEnhanced(p.partnerId);
      // Block if: (1) admin set limit to 0 OR (2) delivery boy has exhausted their limit
      const cashLimitHit = wallet.totalCashLimit === 0 || wallet.availableCashLimit <= 0;
      if (cashLimitHit) {
        // If they exceeded limit, turn them offline immediately
        FoodDeliveryPartner.updateOne(
          { _id: p.partnerId, availabilityStatus: 'online' },
          { $set: { availabilityStatus: 'offline' } }
        ).exec().catch(err => logger.error(`Auto-offline save failed: ${err.message}`));
        
        const io = getIO();
        if (io) {
          io.to(rooms.delivery(p.partnerId)).emit('forced_offline', { reason: 'CASH_LIMIT_EXCEEDED' });
        }
        continue; // Skip this partner
      }
      
      // If cash limit is fine, check subscription (or if bypassed, always push)
      if (isSubEligible) {
        fullyEligiblePartners.push(p);
      } else {
        // Optionally bypass sub check if that was the intent elsewhere: fullyEligiblePartners.push(p);
        fullyEligiblePartners.push(p); // Bypassing subscription here as well since it was bypassed in accept.
      }
    } catch (err) {
      logger.error(`Failed to check wallet for partner ${p.partnerId}: ${err.message}`);
    }
  }

  return fullyEligiblePartners;
}

/**
 * Proactive cash-limit enforcement sweep.
 * Scans ALL currently-online delivery partners and forces offline any whose
 * availableCashLimit has reached ₹0 (or totalCashLimit === 0 meaning admin-blocked).
 * Emits `forced_offline` socket event to each affected rider.
 * Safe to call on every dispatch cycle or resend — lightweight query, skips if all OK.
 */
export async function enforceCashLimitForAllOnlinePartners() {
  try {
    const onlinePartners = await FoodDeliveryPartner.find({
      availabilityStatus: "online",
      status: "approved",
    }).select("_id name").lean();

    if (!onlinePartners.length) return { checkedCount: 0, offlinedCount: 0 };

    let offlinedCount = 0;
    const io = getIO();

    for (const partner of onlinePartners) {
      try {
        const wallet = await getDeliveryPartnerWalletEnhanced(partner._id);
        const cashLimitHit = wallet.totalCashLimit === 0 || wallet.availableCashLimit <= 0;
        if (!cashLimitHit) continue;

        // Force offline in DB
        await FoodDeliveryPartner.updateOne(
          { _id: partner._id, availabilityStatus: "online" },
          { $set: { availabilityStatus: "offline" } }
        );

        // Notify rider's app via socket
        if (io) {
          io.to(rooms.delivery(partner._id)).emit("forced_offline", {
            reason: "CASH_LIMIT_EXCEEDED",
          });
        }

        offlinedCount++;
        logger.info(
          `[CashLimit] 🔴 Forced offline: ${partner.name} (${partner._id}) | cashInHand=₹${wallet.cashInHand}, limit=₹${wallet.totalCashLimit}, available=₹${wallet.availableCashLimit}`
        );
      } catch (err) {
        logger.error(`[CashLimit] Wallet check failed for ${partner._id}: ${err.message}`);
      }
    }

    if (offlinedCount > 0) {
      logger.warn(`[CashLimit] Sweep complete: ${offlinedCount}/${onlinePartners.length} riders forced offline due to cash limit breach.`);
    }

    return { checkedCount: onlinePartners.length, offlinedCount };
  } catch (err) {
    logger.error(`[CashLimit] enforceCashLimitForAllOnlinePartners failed: ${err.message}`);
    return { checkedCount: 0, offlinedCount: 0 };
  }
}

export async function listNearbyOnlineDeliveryPartners(
  sourceId,
  { maxKm = 15, limit = 25, auditLabel = "" } = {},
) {
  if (!sourceId) {
    const fallback = await listAllOnlinePartnersFallback({ limit });
    if (auditLabel) {
      await auditPartnerElimination(fallback.partners, { label: auditLabel, maxKm });
    }
    return fallback;
  }
  const sId = (sourceId?._id || sourceId).toString();

  let source = await FoodRestaurant.findById(sId).lean();

  if (!source?.location?.coordinates?.length) {
    const fallbackLat = Number(source?.location?.latitude);
    const fallbackLng = Number(source?.location?.longitude);
    if (Number.isFinite(fallbackLat) && Number.isFinite(fallbackLng)) {
      source = {
        ...source,
        location: {
          ...(source.location || {}),
          coordinates: [fallbackLng, fallbackLat],
        },
      };
    }
  }

  if (!source?.location?.coordinates?.length) {
    const fallback = await listAllOnlinePartnersFallback({ limit });
    if (auditLabel) {
      await auditPartnerElimination(fallback.partners, { label: auditLabel, maxKm });
    }
    return { ...fallback, source };
  }

  const [rLng, rLat] = source.location.coordinates;
  const allOnline = await FoodDeliveryPartner.find({
    availabilityStatus: "online",
  })
    .select("_id status lastLat lastLng lastLocationAt name driverVehicles activeVehicleId")
    .lean();

  const scored = [];
  const allowedStatuses =
    process.env.NODE_ENV === "production"
      ? ["approved"]
      : ["approved", "pending"];
  const STALE_GPS_MS = 10 * 60 * 1000;

  const candidates = [];

  for (const p of allOnline) {
    if (!allowedStatuses.includes(p.status)) continue;

    const isStale =
      !p.lastLocationAt ||
      Date.now() - new Date(p.lastLocationAt).getTime() > STALE_GPS_MS;
    if (p.lastLat == null || p.lastLng == null || isStale) {
      scored.push({ partnerId: p._id, distanceKm: 999, status: p.status });
      continue;
    }

    const pVehicles = p.driverVehicles || [];
    if (pVehicles.length > 0) {
        const activeId = p.activeVehicleId ? String(p.activeVehicleId) : null;
        const activeVeh = activeId ? pVehicles.find(v => String(v._id) === activeId || String(v.id) === activeId) : pVehicles.find(v => v.isDefault) || pVehicles[0];
        
        if (!activeVeh || activeVeh.status !== 'active') {
             continue; // Must have an explicitly active vehicle if multi-vehicle profile
        }
        
        const services = Array.isArray(activeVeh.supportedServices) ? activeVeh.supportedServices : [];
        if (!services.includes('food')) continue;
    }

    candidates.push({
      partnerId: p._id,
      lat: p.lastLat,
      lng: p.lastLng,
      status: p.status,
    });
  }

  const roadScored = await scorePointsByRoadDistance(
    { lat: rLat, lng: rLng },
    candidates,
    { maxKm },
  );
  scored.push(
    ...roadScored.map((entry) => ({
      partnerId: entry.partnerId,
      distanceKm: entry.distanceKm,
      status: entry.status,
    })),
  );

  scored.sort((a, b) => a.distanceKm - b.distanceKm);
  const picked = scored.slice(0, Math.max(1, limit));

  if (picked.length === 0) {
    const anyOnline = await FoodDeliveryPartner.find({
      status: { $in: allowedStatuses },
      availabilityStatus: "online",
    })
      .select("_id status name")
      .limit(Math.max(1, limit))
      .lean();

    const fallbackPartners = anyOnline.map((p) => ({
      partnerId: p._id,
      distanceKm: null,
      status: p.status,
    }));

    const eligibleFallback = await filterEligiblePartners(fallbackPartners);
    return {
      source,
      partners: eligibleFallback,
    };
  }

  const final =
    config.env === "production"
      ? picked.filter((p) => p.status === "approved")
      : picked;

  const eligible = await filterEligiblePartners(final);
  if (auditLabel) {
    await auditPartnerElimination(eligible, {
      label: auditLabel,
      maxKm,
      origin: { lat: rLat, lng: rLng },
    });
  }
  return { source, partners: eligible };
}


const buildDispatchJobPayload = (documentType, documentMongoId, attempt) => ({
  action: "DISPATCH_TIMEOUT_CHECK",
  documentType,
  orderMongoId: documentMongoId,
  orderId: documentMongoId,
  attempt,
});

const listAllOnlinePartnersFallback = async ({ limit = 25 } = {}) => {
  const allowedStatuses =
    process.env.NODE_ENV === "production" ? ["approved"] : ["approved", "pending"];
  const partners = await FoodDeliveryPartner.find({
    status: { $in: allowedStatuses },
    availabilityStatus: "online",
  })
    .select("_id status name lastLat lastLng lastLocationAt")
    .limit(Math.max(1, limit))
    .lean();

  const rawPartners = partners.map((p) => ({ partnerId: p._id, distanceKm: null, status: p.status }));
  const eligiblePartners = await filterEligiblePartners(rawPartners);
  logger.info(
    `[Dispatch] Online fallback pool: ${rawPartners.length} online → ${eligiblePartners.length} eligible after filters`,
  );
  return { source: null, partners: eligiblePartners };
};

const auditPartnerElimination = async (partners, { label = "dispatch", maxKm = 15, origin = null } = {}) => {
  if (!partners?.length) {
    logger.warn(`[DispatchAudit:${label}] No online delivery partners in database`);
    return;
  }

  const allowedStatuses =
    process.env.NODE_ENV === "production" ? ["approved"] : ["approved", "pending"];
  const STALE_GPS_MS = 10 * 60 * 1000;
  const eligibleIds = new Set((partners || []).map((p) => String(p.partnerId)));

  const allOnline = await FoodDeliveryPartner.find({ availabilityStatus: "online" })
    .select("_id status name lastLat lastLng lastLocationAt availabilityStatus")
    .lean();

  logger.info(
    `[DispatchAudit:${label}] Auditing ${allOnline.length} online partner(s); eligible shortlist=${eligibleIds.size}; maxKm=${maxKm}`,
  );

  for (const p of allOnline) {
    const partnerId = String(p._id);
    const row = {
      partnerId,
      name: p.name || "",
      online: p.availabilityStatus === "online",
      accountStatus: p.status,
      lastLat: p.lastLat,
      lastLng: p.lastLng,
      lastLocationAt: p.lastLocationAt,
      finalEligible: eligibleIds.has(partnerId),
    };

    let reason = null;
    if (!allowedStatuses.includes(p.status)) {
      reason = `accountStatus=${p.status}`;
    } else if (p.lastLat == null || p.lastLng == null) {
      reason = "missing_gps";
    } else if (!p.lastLocationAt || Date.now() - new Date(p.lastLocationAt).getTime() > STALE_GPS_MS) {
      reason = "stale_gps";
    } else if (origin?.lat != null && origin?.lng != null) {
      const d = await roadDistanceKm(origin.lat, origin.lng, p.lastLat, p.lastLng);
      row.distanceKm = Number.isFinite(d) ? Number(d.toFixed(2)) : null;
      row.radiusKm = maxKm;
      if (!Number.isFinite(d) || d > maxKm) {
        reason = `distance=${row.distanceKm ?? "n/a"}km > ${maxKm}km`;
      }
    }

    if (!reason && !row.finalEligible) {
      reason = "filtered_by_cash_limit_or_wallet";
    }

    if (reason) {
      row.finalEligible = false;
      logger.warn(`[DispatchAudit:${label}] Rider ${partnerId} REJECTED: ${reason}`, row);
    } else {
      logger.info(`[DispatchAudit:${label}] Rider ${partnerId} ELIGIBLE`, row);
    }
  }
};

const loadOnlinePartnersByIds = async (partnerIds = []) => {
  const uniqueIds = [...new Set(partnerIds.map((id) => String(id)).filter(Boolean))];
  if (!uniqueIds.length) return [];

  const allowedStatuses =
    process.env.NODE_ENV === "production" ? ["approved"] : ["approved", "pending"];
  const rows = await FoodDeliveryPartner.find({
    _id: { $in: uniqueIds },
    availabilityStatus: "online",
    status: { $in: allowedStatuses },
  })
    .select("_id status name lastLat lastLng lastLocationAt availabilityStatus")
    .lean();

  const raw = rows.map((p) => ({ partnerId: p._id, distanceKm: null, status: p.status }));
  return filterEligiblePartners(raw);
};

const emitDispatchOffer = (io, roomName, payload, soundMeta = {}) => {
  if (!io || !roomName) return;

  // Single fat offer event + slim sound ping (FE listens to both new_order / new_order_available).
  logDispatchRoomEmit(io, roomName, payload, "new_order_available");
  io.to(roomName).emit("new_order_available", payload);
  io.to(roomName).emit("play_notification_sound", {
    audience: "delivery",
    type: "new_order_available",
    orderId: soundMeta.orderId || payload.orderId,
    orderMongoId: soundMeta.orderMongoId || payload.orderMongoId,
    documentType: payload.documentType,
    tripType: payload.tripType,
    returnId: payload.returnId,
  });

};

const logDispatchRoomEmit = (io, roomName, payload, eventName) => {
  const partnerId = String(roomName).replace(/^delivery:/, "");
  const roomSize = io?.sockets?.adapter?.rooms?.get(roomName)?.size ?? 0;
  logger.info(
    `[DispatchSocket] emit partnerId=${partnerId} room=${roomName} roomSize=${roomSize} event=${eventName} documentType=${payload?.documentType} tripType=${payload?.tripType} orderId=${payload?.orderId || payload?.orderMongoId}`,
  );
};

async function runDispatchHunt({
  documentType,
  documentMongoId,
  attempt,
  offeredIds,
  buildPayload,
  resolvePartners,
  persistOffers,
  alertLabel,
  /** Food Quick Delivery knobs — only when order.deliveryMode==="quick". Basic untouched. */
  foodQuickDispatch = null,
}) {
  void enforceCashLimitForAllOnlinePartners().catch((err) =>
    logger.warn(`[Dispatch] Pre-dispatch cash-limit sweep failed: ${err.message}`),
  );

  let maxKm = 15;
  if (attempt === 2) maxKm = 25;
  if (attempt === 3) maxKm = 40;
  if (attempt >= 4) maxKm = 60;

  let offerTimeoutMs = 60000;
  let maxWaves = Number.POSITIVE_INFINITY;
  if (foodQuickDispatch && typeof foodQuickDispatch === "object") {
    const start = Math.max(1, Number(foodQuickDispatch.startKm) || 8);
    const cap = Math.max(start, Number(foodQuickDispatch.maxKm) || 20);
    maxWaves = Math.max(1, Number(foodQuickDispatch.maxWaves) || 3);
    const wave2 = Math.min(cap, start + 4);
    const wave3 = Math.min(cap, start + 10);
    const waves = [start, wave2, wave3];
    maxKm = waves[Math.min(Math.max(attempt, 1) - 1, waves.length - 1)];
    if (attempt > maxWaves) maxKm = cap;
    offerTimeoutMs = Math.max(15000, (Number(foodQuickDispatch.timeoutSec) || 45) * 1000);
  }

  const isPhase2 = foodQuickDispatch ? attempt >= 2 : attempt >= 3;
  const isPhase3 = foodQuickDispatch
    ? attempt >= Math.max(3, maxWaves + 1)
    : attempt >= 6;
  let { partners, source } = await resolvePartners(maxKm);
  const geoPartnerPoolCount = partners?.length || 0;

  if (!partners?.length && offeredIds.length) {
    partners = await loadOnlinePartnersByIds(offeredIds);
    logger.info(
      `[DispatchHunt] ${documentType} ${documentMongoId} geoPool=0 — hydrated ${partners.length} partner(s) from ${offeredIds.length} prior active offer(s)`,
    );
  }

  logger.info(
    `[DispatchHunt] ${documentType} ${documentMongoId} attempt=${attempt} geoPartnerPool=${geoPartnerPoolCount} partnerPool=${partners?.length || 0} maxKm=${maxKm} priorOfferedIds=${offeredIds.length}`,
  );

  if (isPhase3) {
    logger.error(
      `[CRITICAL] ${alertLabel} ${documentMongoId} unassigned for ${attempt} attempts. Triggering Admin Alert.`,
    );
    try {
      const { notifyAdminsSafely } = await import(
        "../../../../core/notifications/firebase.service.js"
      );
      await notifyAdminsSafely({
        title: "Unassigned dispatch crisis!",
        body: `${alertLabel} ${documentMongoId} has not been assigned. Manual intervention required.`,
        data: { type: "admin_alert_unassigned", documentType, documentMongoId },
      });
    } catch (err) {
      logger.warn(`Admin notification failed: ${err.message}`);
    }
  }

  const eligible = partners.filter((p) => !offeredIds.includes(p.partnerId.toString()));
  const io = getIO();
  const payload = {
    ...(await buildPayload(source)),
    offerTimeoutSec: Math.round(offerTimeoutMs / 1000),
  };
  let socketEmitCount = 0;

  if (!eligible.length) {
    logger.info(
      `tryAutoAssign: No NEW eligible partners in ${maxKm}km for ${documentType} ${documentMongoId}.`,
    );

    const newOffers = partners.filter((p) => !offeredIds.includes(p.partnerId.toString()));
    const notifyTargets = newOffers.length ? newOffers : partners;

    if (io && notifyTargets.length > 0) {
      for (const p of notifyTargets) {
        emitDispatchOffer(io, rooms.delivery(p.partnerId), {
          ...payload,
          pickupDistanceKm: p.distanceKm,
        });
        socketEmitCount += 1;
      }
    }

    if (newOffers.length > 0) {
      const offeredToEntries = newOffers.map((p) => ({
        partnerId: p.partnerId,
        at: new Date(),
        action: "offered",
      }));
      await persistOffers(offeredToEntries);
    }

    const retryJob = await addOrderJob(buildDispatchJobPayload(documentType, documentMongoId, attempt + 1), {
      delay: foodQuickDispatch ? offerTimeoutMs : 30000,
    });
    if (!retryJob) {
      logger.warn(
        `[Dispatch] BullMQ unavailable — DISPATCH_TIMEOUT_CHECK not scheduled for ${documentType} ${documentMongoId}. Configure Redis/BullMQ worker for automatic retries.`,
      );
    }

    const dispatchAudit = {
      reason:
        partners.length === 0
          ? "no_online_riders"
          : newOffers.length === 0
            ? "all_nearby_riders_already_offered"
            : "reoffered_existing_pool",
      eligibleCount: 0,
      partnerPoolCount: partners.length,
      geoPartnerPoolCount,
      notifiedCount: notifyTargets.length,
      renotifiedCount: newOffers.length === 0 ? notifyTargets.length : 0,
      persistedOfferCount: newOffers.length,
      socketEmitCount,
      maxKm,
      attempt,
      bullmqRetryScheduled: Boolean(retryJob),
    };

    logger.info(
      `[DispatchHunt:summary] ${documentType} ${documentMongoId} eligiblePartners=0 partnerPool=${partners.length} persistedOffers=${newOffers.length} socketEmitCount=${socketEmitCount} notifiedCount=${notifyTargets.length} reason=${dispatchAudit.reason}`,
    );

    return { notifiedCount: notifyTargets.length, payload, dispatchAudit };
  }

  if (isPhase2) {
    for (const p of eligible) {
      emitDispatchOffer(io, rooms.delivery(p.partnerId), {
        ...payload,
        pickupDistanceKm: p.distanceKm,
      });
      socketEmitCount += 1;
    }
  } else {
    const p = eligible[0];
    emitDispatchOffer(io, rooms.delivery(p.partnerId), {
      ...payload,
      pickupDistanceKm: p.distanceKm,
    });
    socketEmitCount += 1;
    try {
      await notifyOwnerSafely(
        { ownerType: "DELIVERY_PARTNER", ownerId: p.partnerId },
        {
          title: payload.tripType === "return_pickup" ? "New return pickup!" : "New order assigned!",
          body: `You have ${Math.round(offerTimeoutMs / 1000)} seconds to accept ${alertLabel} ${payload.orderId || documentMongoId}.`,
          data: {
            type: "new_order_available",
            audience: "delivery",
            documentType,
            orderId: documentMongoId,
            tripType: payload.tripType || "forward",
            deliveryMode: payload.deliveryMode || "basic",
            isFoodQuickDelivery: payload.isFoodQuickDelivery === true,
            link: "/food/delivery",
            targetUrl: "/food/delivery",
          },
        },
      );
    } catch (err) {
      logger.warn(`Push notification failed for partner ${p.partnerId}: ${err.message}`);
    }
  }

  const offeredToEntries = eligible.map((p) => ({
    partnerId: p.partnerId,
    at: new Date(),
    action: "offered",
  }));
  await persistOffers(offeredToEntries);

  const retryJob = await addOrderJob(buildDispatchJobPayload(documentType, documentMongoId, attempt + 1), {
    delay: offerTimeoutMs,
  });
  if (!retryJob) {
    logger.warn(
      `[Dispatch] BullMQ unavailable — DISPATCH_TIMEOUT_CHECK not scheduled for ${documentType} ${documentMongoId}. Configure Redis/BullMQ worker for automatic retries.`,
    );
  }

  const dispatchAudit = {
    reason: "offers_persisted",
    eligibleCount: eligible.length,
    partnerPoolCount: partners.length,
    geoPartnerPoolCount,
    notifiedCount: isPhase2 ? eligible.length : 1,
    persistedOfferCount: eligible.length,
    socketEmitCount,
    maxKm,
    attempt,
    bullmqRetryScheduled: Boolean(retryJob),
  };

  logger.info(
    `[DispatchHunt:summary] ${documentType} ${documentMongoId} eligiblePartners=${eligible.length} partnerPool=${partners.length} persistedOffers=${eligible.length} socketEmitCount=${socketEmitCount} notifiedCount=${dispatchAudit.notifiedCount} reason=${dispatchAudit.reason}`,
  );

  return { notifiedCount: dispatchAudit.notifiedCount, payload, dispatchAudit };
}

async function tryAutoAssignForwardOrder(orderId, options = {}) {
  const attempt = options.attempt || 1;
  const lockTimeout = 55000;
  // Never auto-assign while orderStatus is scheduled (hold until activation → placed → restaurant accept).
  const activeOrderStatuses = [
    "created",
    "placed",
    "confirmed",
    "preparing",
    "ready_for_pickup",
    "picked_up",
  ];

  const order = await FoodOrder.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(orderId),
      orderStatus: { $in: activeOrderStatuses },
      $or: [
        { "dispatch.status": "unassigned" },
        {
          "dispatch.status": "assigned",
          "dispatch.acceptedAt": { $exists: false },
          "dispatch.assignedAt": { $lt: new Date(Date.now() - lockTimeout) },
        },
      ],
      "dispatch.dispatchingAt": { $exists: false },
    },
    { $set: { "dispatch.dispatchingAt": new Date() } },
    { new: true },
  ).populate(["restaurantId", "userId"]);

  if (!order) {
    logger.info(`tryAutoAssign forward: Skip for ${orderId}`);
    return null;
  }

  try {
    const offeredIds = (order.dispatch?.offeredTo || []).map((o) => o.partnerId.toString());
    const isFoodQuickDelivery = String(order.deliveryMode || "").toLowerCase() === "quick";
    const dispatchSourceId = order.restaurantId;

    let foodQuickDispatch = null;
    if (isFoodQuickDelivery) {
      try {
        const { FoodFeeSettings } = await import("../../admin/models/feeSettings.model.js");
        const { normalizeQuickDeliverySettings } = await import(
          "../utils/quickDeliveryConstants.js"
        );
        const feeDoc = await FoodFeeSettings.findOne({ isActive: { $ne: false } })
          .sort({ createdAt: -1 })
          .lean();
        const q = normalizeQuickDeliverySettings(feeDoc?.quickDelivery);
        // Rider hunt uses maxRadiusKm (search radius), NOT maxDistanceKm
        // (customer eligibility). Do not merge these concepts.
        foodQuickDispatch = {
          startKm: q.dispatchStartRadiusKm,
          maxKm: q.maxRadiusKm,
          timeoutSec: q.dispatchTimeoutSec,
          maxWaves: q.maxDispatchWaves,
        };
        try {
          await FoodOrder.updateOne(
            { _id: order._id },
            { $set: { "dispatch.offerTimeoutSec": Number(q.dispatchTimeoutSec) || 45 } },
          );
        } catch {
          /* non-blocking */
        }
      } catch (err) {
        logger.warn(`[Dispatch] Food Quick knobs load failed: ${err.message}`);
      }
    }

    const result = await runDispatchHunt({
      documentType: FORWARD_ORDER_DOCUMENT_TYPE,
      documentMongoId: order._id.toString(),
      attempt,
      offeredIds,
      alertLabel: isFoodQuickDelivery ? "Quick Order" : "Order",
      foodQuickDispatch,
      buildPayload: async (source) => buildDeliverySocketPayload(order, source),
      resolvePartners: (maxKm) =>
        listNearbyOnlineDeliveryPartners(dispatchSourceId, {
          maxKm,
          limit: 15,
        }),
      persistOffers: async (offeredToEntries) => {
        const fresh = await FoodOrder.findById(order._id).select("orderStatus dispatch").lean();
        if (!fresh || isTerminalOrderStatus(fresh.orderStatus) || fresh.dispatch?.status === "cancelled") {
          logger.info(`tryAutoAssign forward: Skip persistOffers for cancelled order ${orderId}`);
          return;
        }

        order.dispatch.status = "unassigned";
        order.dispatch.deliveryPartnerId = null;
        order.dispatch.offeredTo.push(...offeredToEntries);
        await order.save();
      },
    });

    return { ...order.toObject(), notifiedCount: result.notifiedCount };
  } finally {
    await FoodOrder.findByIdAndUpdate(orderId, { $unset: { "dispatch.dispatchingAt": "" } });
  }
}


export async function getDispatchSettings() {
  return { dispatchMode: "auto" };
}

export async function updateDispatchSettings(dispatchMode, adminId) {
  // Always set to auto
  await FoodSettings.findOneAndUpdate(
    { key: "dispatch" },
    {
      $set: {
        dispatchMode: "auto",
        updatedBy: { role: "ADMIN", adminId, at: new Date() },
      },
    },
    { upsert: true, new: true },
  );
  return getDispatchSettings();
}

export async function tryAutoAssign(documentId, options = {}) {
  return tryAutoAssignForwardOrder(documentId, options);
}

export async function processDispatchTimeout(documentId, partnerId, jobData = {}) {
  const order = await FoodOrder.findById(documentId);
  if (!order) return;
  if (isTerminalOrderStatus(order.orderStatus) || order.dispatch?.status === "cancelled") {
    logger.info(`processDispatchTimeout: Skip cancelled order ${documentId}`);
    return;
  }

  const stillAssigned =
    order.dispatch?.status === "assigned" &&
    String(order.dispatch?.deliveryPartnerId) === String(partnerId) &&
    !order.dispatch?.acceptedAt;

  if (stillAssigned) {
    logger.info(
      `Dispatch timeout for partner ${partnerId} on order ${documentId}. Re-trying hunt...`,
    );
    const offer = order.dispatch.offeredTo.find(
      (o) => String(o.partnerId) === String(partnerId) && o.action === "offered",
    );
    if (offer) offer.action = "timeout";

    order.dispatch.status = "unassigned";
    order.dispatch.deliveryPartnerId = null;
    await order.save();

    const attempt = (order.dispatch?.offeredTo?.length || 0) + 1;
    await tryAutoAssign(documentId, { attempt });
  } else if (order.dispatch?.status === "unassigned") {
    const attempt = (order.dispatch?.offeredTo?.length || 0) + 1;
    await tryAutoAssign(documentId, { attempt });
  }
}

export async function resendDeliveryNotificationRestaurant(
  orderId,
  restaurantId,
) {
  const identity = buildOrderIdentityFilter(orderId);
  const order = await FoodOrder.findOne({
    ...identity,
    restaurantId: new mongoose.Types.ObjectId(restaurantId),
  });

  if (!order) throw new NotFoundError("Order not found");

  const activeStatuses = [
    "confirmed",
    "preparing",
    "ready_for_pickup",
    "ready",
  ];
  if (!activeStatuses.includes(order.orderStatus)) {
    throw new ValidationError(
      `Cannot resend notification for order in status: ${order.orderStatus}`,
    );
  }

  if (order.dispatch?.status === "accepted") {
    throw new ValidationError(
      "A delivery partner has already accepted this order.",
    );
  }

  order.dispatch.status = "unassigned";
  order.dispatch.deliveryPartnerId = null;
  order.dispatch.offeredTo = [];
  await order.save();

  // Proactively sweep all online riders — force offline anyone whose cash limit is ₹0
  // before we attempt to dispatch this order to them.
  void enforceCashLimitForAllOnlinePartners().catch(err =>
    logger.warn(`[Resend] Cash-limit sweep failed: ${err.message}`)
  );

  const res = await tryAutoAssign(order._id, { attempt: 3 });
  return {
    success: true,
    notifiedCount: res?.notifiedCount || 0,
  };
}
