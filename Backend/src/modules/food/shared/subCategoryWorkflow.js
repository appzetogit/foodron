import mongoose from 'mongoose';
import { ValidationError } from '../../../core/auth/errors.js';

/** Approval mirrors the parent category exactly — a subcategory is never approved on its own. */
export const applyCategoryApprovalToSubCategories = async (categoryId, { approvalStatus, isApproved, rejectionReason = '' }) => {
    const { FoodSubCategory } = await import('../admin/models/subcategory.model.js');
    await FoodSubCategory.updateMany(
        { categoryId },
        { $set: { approvalStatus, isApproved, rejectionReason } }
    );
};

/**
 * Replace a category's subcategory list with `names` (deduped, trimmed, max 50): keeps existing
 * rows whose name is still present, creates new ones for names not yet present, deletes rows for
 * names that were removed. Runs on category create/update so the list always matches the form.
 */
export const syncCategorySubCategories = async (categoryId, names, { approvalStatus, isApproved, restaurantId, createdByRestaurantId } = {}) => {
    const { FoodSubCategory } = await import('../admin/models/subcategory.model.js');
    if (!Array.isArray(names)) return;

    const cleanNames = Array.from(
        new Set(
            names
                .map((n) => String(n || '').trim())
                .filter(Boolean)
        )
    ).slice(0, 50);

    const existing = await FoodSubCategory.find({ categoryId }).select('_id name').lean();
    const existingByLowerName = new Map(existing.map((s) => [s.name.toLowerCase(), s]));
    const keepLowerNames = new Set(cleanNames.map((n) => n.toLowerCase()));

    const toDelete = existing.filter((s) => !keepLowerNames.has(s.name.toLowerCase())).map((s) => s._id);
    if (toDelete.length) {
        await FoodSubCategory.deleteMany({ _id: { $in: toDelete } });
        // Detach (not delete) any food already using a removed subcategory.
        const { FoodItem } = await import('../admin/models/food.model.js');
        await FoodItem.updateMany(
            { subCategoryId: { $in: toDelete } },
            { $set: { subCategoryId: null, subCategoryName: '' } }
        );
    }

    const toCreate = cleanNames.filter((n) => !existingByLowerName.has(n.toLowerCase()));
    if (toCreate.length) {
        await FoodSubCategory.insertMany(
            toCreate.map((name, idx) => ({
                name,
                categoryId,
                restaurantId,
                createdByRestaurantId,
                approvalStatus,
                isApproved,
                sortOrder: idx + 1
            })),
            { ordered: false }
        );
    }
};

export const listSubCategoriesForCategory = async (categoryId) => {
    if (!categoryId || !mongoose.Types.ObjectId.isValid(String(categoryId))) return [];
    const { FoodSubCategory } = await import('../admin/models/subcategory.model.js');
    return FoodSubCategory.find({ categoryId, isActive: { $ne: false } })
        .sort({ sortOrder: 1, createdAt: 1 })
        .select('name categoryId approvalStatus isApproved sortOrder')
        .lean();
};

export const serializeSubCategoryForResponse = (sub = {}) => ({
    id: sub._id || sub.id,
    _id: sub._id || sub.id,
    name: sub.name,
    categoryId: sub.categoryId,
    isApproved: sub.approvalStatus ? sub.approvalStatus === 'approved' : sub.isApproved !== false,
    approvalStatus: sub.approvalStatus || (sub.isApproved !== false ? 'approved' : 'pending'),
    sortOrder: sub.sortOrder || 0
});

export const assertSubCategoryBelongsToCategory = async (subCategoryId, categoryId) => {
    if (!subCategoryId) return null;
    if (!mongoose.Types.ObjectId.isValid(String(subCategoryId))) {
        throw new ValidationError('Invalid subcategory id');
    }
    const { FoodSubCategory } = await import('../admin/models/subcategory.model.js');
    const doc = await FoodSubCategory.findById(subCategoryId).select('name categoryId isActive').lean();
    if (!doc || doc.isActive === false) {
        throw new ValidationError('Subcategory not found');
    }
    if (String(doc.categoryId) !== String(categoryId)) {
        throw new ValidationError('Subcategory does not belong to the selected category');
    }
    return doc;
};
