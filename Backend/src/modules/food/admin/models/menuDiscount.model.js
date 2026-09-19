import mongoose from 'mongoose';

/**
 * Restaurant-wide menu discount (auto-applied at checkout, no coupon code).
 * Dates are IST calendar days ("YYYY-MM-DD"); startAt/endAt are the matching IST instants
 * used for indexed "active now" lookups.
 */
const menuDiscountSchema = new mongoose.Schema(
    {
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', required: true, index: true },
        restaurantName: { type: String, default: '', trim: true },
        createdByRole: { type: String, enum: ['admin', 'restaurant'], required: true },
        createdById: { type: mongoose.Schema.Types.ObjectId, default: null },
        percentage: { type: Number, required: true, min: 0.01, max: 100 },
        scheduleType: { type: String, enum: ['single_day', 'date_range'], default: 'date_range' },
        startDate: { type: String, required: true },
        endDate: { type: String, required: true },
        startAt: { type: Date, required: true },
        endAt: { type: Date, required: true },
        /** Share of the discount funded from admin earning / restaurant earning (sum = 100). */
        adminBearPercentage: { type: Number, default: 0, min: 0, max: 100 },
        restaurantBearPercentage: { type: Number, default: 100, min: 0, max: 100 },
        isActive: { type: Boolean, default: true },
        note: { type: String, default: '', trim: true, maxlength: 200 },
    },
    { collection: 'food_menu_discounts', timestamps: true }
);

menuDiscountSchema.index({ restaurantId: 1, isActive: 1, startAt: 1, endAt: 1 });
menuDiscountSchema.index({ isActive: 1, startAt: 1, endAt: 1 });

export const FoodMenuDiscount =
    mongoose.models.FoodMenuDiscount ||
    mongoose.model('FoodMenuDiscount', menuDiscountSchema, 'food_menu_discounts');
