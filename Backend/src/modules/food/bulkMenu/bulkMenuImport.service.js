import fsp from 'fs/promises';
import path from 'path';
import { FoodItem } from '../admin/models/food.model.js';
import { bumpApprovedFoodCount, createRestaurantAddonAdmin } from '../admin/services/admin.service.js';
import { FoodRestaurant } from '../restaurant/models/restaurant.model.js';
import { createRestaurantAddon, updateRestaurantAddon } from '../restaurant/services/restaurantAddon.service.js';
import {
    getRestaurantContext,
    persistRestaurantFood,
    prepareRestaurantFoodDoc
} from '../restaurant/services/restaurantFood.service.js';
import { validateAddonCreateDto } from '../restaurant/validators/addon.validator.js';
import { invalidateCategoryCaches } from '../shared/categoryCache.js';
import { invalidateCache } from '../../../middleware/cache.js';
import { logger } from '../../../utils/logger.js';
import { BulkMenuImportJob } from './models/bulkMenuImportJob.model.js';
import { removeDirSafe, toRowError } from './bulkMenuValidation.service.js';
import { createImageUploader, createLimiter } from './imageProcessor.js';
import { DUPLICATE_MODE, ERROR, IMAGE_FOLDERS, IMPORT_CONCURRENCY } from './constants.js';

class RowImageError extends Error {}

const describeFailure = (err) => {
    if (err instanceof RowImageError) return { code: ERROR.IMAGE_PROCESSING_FAILED, message: err.message };
    try {
        return toRowError(err);
    } catch {
        return { code: ERROR.IMPORT_FAILED, message: err?.message || 'Unexpected error while importing this row.' };
    }
};

/** Persist a batch outcome with ONE update: row statuses + counters + progress. */
const flushBatch = async (jobId, outcomes, entityType) => {
    if (!outcomes.length) return;
    const $set = {};
    const inc = { [`progress.${entityType}.done`]: outcomes.length };
    for (const outcome of outcomes) {
        const base = `rowResults.${outcome.index}`;
        $set[`${base}.status`] = outcome.status;
        if (outcome.errorCode) $set[`${base}.errorCode`] = outcome.errorCode;
        if (outcome.errorMessage) $set[`${base}.errorMessage`] = outcome.errorMessage;
        if (outcome.entityId) $set[`${base}.entityId`] = outcome.entityId;
        const counter = outcome.status === 'success' ? 'imported' : outcome.status === 'skipped' ? 'skipped' : 'failed';
        inc[`counters.${counter}`] = (inc[`counters.${counter}`] || 0) + 1;
    }
    await BulkMenuImportJob.updateOne({ _id: jobId }, { $set, $inc: inc });
};

const markProcessing = async (jobId, indexes) => {
    if (!indexes.length) return;
    const $set = {};
    for (const index of indexes) $set[`rowResults.${index}.status`] = 'processing';
    await BulkMenuImportJob.updateOne({ _id: jobId }, { $set });
};

const runInBatches = async (jobId, entityType, rows, indexOffset, job, handler) => {
    const limit = createLimiter(IMPORT_CONCURRENCY.rows);
    let success = 0;
    for (let i = 0; i < rows.length; i += IMPORT_CONCURRENCY.batch) {
        const batch = rows.slice(i, i + IMPORT_CONCURRENCY.batch);
        await markProcessing(jobId, batch.map((row) => row.index + indexOffset));
        const outcomes = await Promise.all(
            batch.map((row) =>
                limit(async () => {
                    const index = row.index + indexOffset;
                    const existing = job.rowResults[index];
                    // Resumable: never redo a row that already reached a final state.
                    if (!existing || !['pending', 'processing'].includes(existing.status)) return null;
                    try {
                        return { index, ...(await handler(row, existing)) };
                    } catch (err) {
                        const { code, message } = describeFailure(err);
                        return { index, status: 'failed', errorCode: code, errorMessage: message };
                    }
                })
            )
        );
        const finished = outcomes.filter(Boolean);
        success += finished.filter((o) => o.status === 'success').length;
        await flushBatch(jobId, finished, entityType);
    }
    return success;
};

const uploadRowImages = async (uploadImage, imageFiles, folder) => {
    try {
        return await Promise.all(imageFiles.map((name) => uploadImage(name, folder)));
    } catch (err) {
        throw new RowImageError(`Image could not be processed: ${err?.message || 'upload failed'}`);
    }
};

export async function runBulkMenuImportJob(jobId) {
    const claimed = await BulkMenuImportJob.findOneAndUpdate(
        { _id: jobId, status: { $in: ['queued', 'processing'] } },
        { $set: { status: 'processing', startedAt: new Date() } },
        { new: true }
    );
    if (!claimed) return null;

    const job = claimed.toObject();
    const isAdmin = job.ownerType === 'ADMIN';
    const restaurantId = job.restaurantId;
    const skipDuplicates = job.duplicateMode === DUPLICATE_MODE.SKIP;

    try {
        const parsed = JSON.parse(await fsp.readFile(path.join(job.stagingDir, 'parsed.json'), 'utf8'));
        const images = new Map(parsed.images);
        const uploadImage = createImageUploader(images);
        const context = await getRestaurantContext(restaurantId);
        const caches = { categoryCache: new Map(), slotCache: new Map() };
        const foodOffset = 0;
        const addonOffset = job.validation?.food?.total || 0;

        let importedFoods = 0;
        let importedAddons = 0;

        // ---------------- foods ----------------
        if (parsed.foods.length) {
            importedFoods = await runInBatches(job._id, 'food', parsed.foods, foodOffset, job, async (row, existing) => {
                if (skipDuplicates && existing.duplicate) {
                    return {
                        status: 'skipped',
                        errorCode: ERROR.DUPLICATE_FOOD,
                        errorMessage: `Skipped: ${existing.duplicate === 'existing' ? 'already exists for this restaurant' : 'repeated in this file'} (same name and category).`
                    };
                }

                // Re-run the real create-time rules right before writing (state may have changed
                // since validation), then attach the uploaded image URLs.
                const { doc } = await prepareRestaurantFoodDoc(restaurantId, row.body, { context, ...caches });
                const urls = await uploadRowImages(uploadImage, row.imageFiles, IMAGE_FOLDERS.food);
                doc.image = urls[0];
                doc.images = urls;

                if (isAdmin) {
                    // Same semantics as admin createFood: approved immediately.
                    const created = await FoodItem.create({
                        ...doc,
                        approvalStatus: 'approved',
                        approvedAt: new Date(),
                        approvedBy: job.performer || null
                    });
                    return { status: 'success', entityId: created._id };
                }
                const created = await persistRestaurantFood(doc, { notifyAdmins: false });
                return { status: 'success', entityId: created._id };
            });

            // Admin foods are approved on creation, so productCount is bumped exactly once for the
            // batch (same rule as single admin createFood). Restaurant foods are counted later by the
            // existing approval flow, never here.
            if (isAdmin && importedFoods > 0) {
                await bumpApprovedFoodCount(restaurantId, importedFoods).catch((err) =>
                    logger.error(`[bulk-menu] productCount update failed: ${err.message}`)
                );
            }
        }

        // ---------------- addons ----------------
        if (parsed.addons.length) {
            const folder = isAdmin ? IMAGE_FOLDERS.adminAddon : IMAGE_FOLDERS.restaurantAddon;
            importedAddons = await runInBatches(job._id, 'addon', parsed.addons, addonOffset, job, async (row) => {
                const urls = row.imageFiles.length ? await uploadRowImages(uploadImage, row.imageFiles, folder) : [];
                const withImages = { ...row.body, ...(urls.length ? { image: urls[0], images: urls } : {}) };

                if (isAdmin) {
                    const created = await createRestaurantAddonAdmin(
                        { ...withImages, restaurantId: String(restaurantId) },
                        job.performer || null,
                        { notifyOwner: false }
                    );
                    return { status: 'success', entityId: created._id };
                }

                const dto = validateAddonCreateDto(withImages);
                const created = await createRestaurantAddon(restaurantId, dto, { notifyAdmins: false });
                if (row.body.isAvailable === false) {
                    // The create flow always starts available; reuse the existing toggle (no re-approval).
                    await updateRestaurantAddon(restaurantId, created._id, { isAvailable: false });
                }
                return { status: 'success', entityId: created._id };
            });
        }

        // Extracted files are no longer needed once every row has been processed.
        await removeDirSafe(job.stagingDir);

        const done = await BulkMenuImportJob.findByIdAndUpdate(
            job._id,
            { $set: { status: 'completed', finishedAt: new Date() } },
            { new: true }
        ).lean();

        await afterImport({ job, done, importedFoods, importedAddons });
        return done;
    } catch (err) {
        logger.error(`[bulk-menu] job ${job.jobCode} failed: ${err.message}`);
        await BulkMenuImportJob.updateOne(
            { _id: job._id },
            { $set: { status: 'failed', error: String(err.message || err).slice(0, 500), finishedAt: new Date() } }
        );
        throw err;
    } finally {
        await removeDirSafe(job.stagingDir);
    }
}

/** One summary notification + one batched cache invalidation per import. */
async function afterImport({ job, done, importedFoods, importedAddons }) {
    const results = done?.rowResults || [];
    const tally = (type) => {
        const rows = results.filter((r) => r.entityType === type);
        return {
            imported: rows.filter((r) => r.status === 'success').length,
            skipped: rows.filter((r) => r.status === 'skipped').length,
            failed: rows.filter((r) => r.status === 'failed' || r.status === 'invalid').length
        };
    };
    const food = tally('food');
    const addon = tally('addon');

    const lines = [];
    if (job.entity !== 'addon') lines.push(`Food items: imported ${food.imported}, skipped ${food.skipped}, failed ${food.failed}.`);
    if (job.entity !== 'food') lines.push(`Add-ons: imported ${addon.imported}, skipped ${addon.skipped}, failed ${addon.failed}.`);

    if (importedFoods + importedAddons > 0) {
        try {
            const restaurant = await FoodRestaurant.findById(job.restaurantId).select('restaurantName').lean();
            const name = restaurant?.restaurantName || 'A restaurant';
            if (job.ownerType === 'RESTAURANT') {
                const { notifyAdminsSafely } = await import('../../../core/notifications/firebase.service.js');
                await notifyAdminsSafely({
                    title: 'Bulk menu import submitted 📦',
                    body: `${name} submitted a bulk menu import (${job.jobCode}). ${lines.join(' ')} Approval required.`,
                    data: { type: 'approval_request', subType: 'food', id: String(job._id) }
                });
            } else {
                const { notifyOwnersWithInbox } = await import('../../../core/notifications/ownerInboxNotify.js');
                await notifyOwnersWithInbox([{ ownerType: 'RESTAURANT', ownerId: job.restaurantId }], {
                    title: 'Menu items added by admin',
                    body: `Admin imported menu items to your restaurant (${job.jobCode}). ${lines.join(' ')}`,
                    data: { type: 'bulk_import', restaurantId: String(job.restaurantId) }
                });
            }
        } catch (err) {
            logger.error(`[bulk-menu] summary notification failed: ${err.message}`);
        }
    }

    // Targeted (not FLUSHALL): the same prefixes single-item food routes clear.
    await Promise.all([
        importedFoods > 0 ? invalidateCategoryCaches() : null,
        importedFoods > 0 ? invalidateCache('restaurants*') : null,
        importedFoods > 0 ? invalidateCache('food_search*') : null,
        importedFoods > 0 ? invalidateCache('restaurant_detail*') : null,
        importedAddons > 0 ? invalidateCache('restaurant_addons:*') : null
    ]).catch((err) => logger.error(`[bulk-menu] cache invalidation failed: ${err.message}`));
}
