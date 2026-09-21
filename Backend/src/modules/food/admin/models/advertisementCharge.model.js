import mongoose from 'mongoose';

/**
 * FoodAdvertisementCharge — one row per (advertisement, IST calendar day).
 *
 * charge = dayEarnings × percentage / 100, where dayEarnings is the restaurant's
 * delivered-order `restaurantShare` for that day. Rows are created only after the
 * day is over (idempotent via the unique (advertisementId, day) index) and the
 * admin wallet credit happens in the same Mongo transaction as the insert.
 *
 * Restaurant side: outstanding (isSettled=false) charges are deducted from the
 * withdrawable balance and are consumed by the next approved withdrawal.
 *
 * Refund / cancellation: if the day's earnings change after booking, a separate
 * adjustment row (isAdjustment=true, entryKey "adj:<from>><to>") is added with the
 * (usually negative) delta. A negative unsettled row is a credit: it lowers the
 * restaurant's deduction and is debited back from the admin wallet.
 */
const advertisementChargeSchema = new mongoose.Schema(
    {
        advertisementId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'FoodAdvertisement',
            required: true,
            index: true
        },
        adsId: { type: String, default: '' },
        adsTitle: { type: String, default: '' },
        adsType: { type: String, default: '' },
        restaurantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'FoodRestaurant',
            required: true,
            index: true
        },
        restaurantName: { type: String, default: '' },
        /** IST calendar day, YYYY-MM-DD */
        day: { type: String, required: true, index: true },
        /** Adjustment rows carry the (possibly negative) delta of earnings / orders. */
        dayEarnings: { type: Number, required: true },
        ordersCount: { type: Number, default: 0 },
        percentage: { type: Number, required: true, min: 0, max: 100 },
        /** Negative on adjustment rows that reverse part of a charge. */
        amount: { type: Number, required: true },
        isAdjustment: { type: Boolean, default: false },
        /** 'base' for the daily charge; unique per adjustment step otherwise. */
        entryKey: { type: String, default: 'base' },
        note: { type: String, default: '' },
        /** Restaurant already paid this via a withdrawal settlement (or nothing to pay). */
        isSettled: { type: Boolean, default: false, index: true },
        settledAt: { type: Date, default: null },
        settledWithdrawalId: { type: mongoose.Schema.Types.ObjectId, default: null },
        /** Admin wallet credit completed (same txn as the insert). */
        adminCredited: { type: Boolean, default: false },
        adminTransactionId: { type: String, default: '' }
    },
    { collection: 'food_advertisement_charges', timestamps: true }
);

advertisementChargeSchema.index({ advertisementId: 1, day: 1, entryKey: 1 }, { unique: true });
advertisementChargeSchema.index({ restaurantId: 1, isSettled: 1, day: 1 });
advertisementChargeSchema.index({ day: -1 });

export const FoodAdvertisementCharge = mongoose.model(
    'FoodAdvertisementCharge',
    advertisementChargeSchema,
    'food_advertisement_charges'
);
