import mongoose from 'mongoose';

/**
 * Subcategory lives under a Category. It has no zone/image of its own — it inherits zone
 * visibility from its parent category (same approvalStatus lifecycle, approved/rejected
 * together with the category that owns it).
 */
const foodSubCategorySchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, index: true },
        categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodCategory', required: true, index: true },
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', index: true, default: undefined },
        createdByRestaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', index: true, default: undefined },
        approvalStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'approved', index: true },
        isApproved: { type: Boolean, default: true, index: true },
        rejectionReason: { type: String, trim: true, default: '' },
        isActive: { type: Boolean, default: true, index: true },
        sortOrder: { type: Number, default: 1, index: true }
    },
    {
        collection: 'food_subcategories',
        timestamps: true
    }
);

foodSubCategorySchema.index({ categoryId: 1, isActive: 1, sortOrder: 1 });
foodSubCategorySchema.index({ categoryId: 1, name: 1 }, { unique: true });

export const FoodSubCategory = mongoose.model('FoodSubCategory', foodSubCategorySchema, 'food_subcategories');
