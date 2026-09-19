import crypto from 'crypto';
import mongoose from 'mongoose';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { ValidationError } from '../../../core/auth/errors.js';
import { FoodCategory } from '../admin/models/category.model.js';
import { FoodItem } from '../admin/models/food.model.js';
import { prepareRestaurantAddonAdmin } from '../admin/services/admin.service.js';
import {
    getRestaurantContext,
    prepareRestaurantFoodDoc
} from '../restaurant/services/restaurantFood.service.js';
import { findDuplicateAddonByName } from '../restaurant/services/restaurantAddon.service.js';
import { validateAddonCreateDto } from '../restaurant/validators/addon.validator.js';
import { BulkMenuImportJob } from './models/bulkMenuImportJob.model.js';
import { readMenuWorkbook } from './excelParser.js';
import { imageErrorMessage, inspectReferencedImages } from './imageProcessor.js';
import { parseAddonRow, parseFoodRow } from './rowParsers.js';
import { BulkImportError, ERROR } from './constants.js';
import { extractBulkPackage } from './zipExtractor.js';

export const STAGING_ROOT = path.join(os.tmpdir(), 'cravioo-bulk-menu');
const STAGING_MAX_AGE_MS = 24 * 3600 * 1000;

export const removeDirSafe = async (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    // Only ever delete inside our own staging root.
    if (!resolved.startsWith(path.resolve(STAGING_ROOT) + path.sep)) return;
    await fsp.rm(resolved, { recursive: true, force: true }).catch(() => {});
};

/** Best-effort sweep of abandoned staging directories (validated but never imported). */
export async function cleanupStaleStaging() {
    try {
        const names = await fsp.readdir(STAGING_ROOT);
        const now = Date.now();
        await Promise.all(
            names.map(async (name) => {
                const dir = path.join(STAGING_ROOT, name);
                const stat = await fsp.stat(dir).catch(() => null);
                if (stat && now - stat.mtimeMs > STAGING_MAX_AGE_MS) await removeDirSafe(dir);
            })
        );
    } catch {
        // staging root may not exist yet
    }
}

const mapServiceError = (message = '') => {
    if (/category not found|invalid category id/i.test(message)) return ERROR.CATEGORY_NOT_FOUND;
    if (/multiple categories/i.test(message)) return ERROR.CATEGORY_AMBIGUOUS;
    if (/currently inactive/i.test(message)) return ERROR.CATEGORY_INACTIVE;
    if (/awaiting admin approval/i.test(message)) return ERROR.CATEGORY_PENDING;
    if (/rejected by admin/i.test(message)) return ERROR.CATEGORY_REJECTED;
    if (/pure veg/i.test(message)) return ERROR.PURE_VEG_VIOLATION;
    if (/cannot accept/i.test(message)) return ERROR.FOOD_TYPE_CATEGORY_MISMATCH;
    if (/variant/i.test(message)) return ERROR.INVALID_VARIANTS;
    if (/slot/i.test(message)) return ERROR.INVALID_SLOT_TIMING;
    if (/add-on already exists/i.test(message)) return ERROR.ADDON_DUPLICATE;
    return ERROR.VALIDATION_FAILED;
};


const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The existing resolver reports pending/rejected categories as plain "not found" (it only looks at
 * approved ones). This diagnostic-only lookup, run for failing rows, tells the user WHY, without
 * ever changing which categories are usable.
 */
const diagnoseMissingCategory = async (restaurantId, body) => {
    const scope = [{ restaurantId: { $exists: false } }, { restaurantId: null }, { restaurantId }];
    const query = { $or: scope };
    if (body.categoryId && mongoose.Types.ObjectId.isValid(String(body.categoryId))) {
        query._id = new mongoose.Types.ObjectId(String(body.categoryId));
    } else if (body.categoryName) {
        query.name = { $regex: `^${escapeRegex(String(body.categoryName).trim())}$`, $options: 'i' };
    } else {
        return null;
    }
    const found = await FoodCategory.find(query).select('name approvalStatus isApproved').lean();
    const status = (c) => c.approvalStatus || (c.isApproved === false ? 'pending' : 'approved');
    if (found.some((c) => status(c) === 'pending')) {
        return { code: ERROR.CATEGORY_PENDING, message: 'This category is awaiting admin approval' };
    }
    if (found.some((c) => status(c) === 'rejected')) {
        return { code: ERROR.CATEGORY_REJECTED, message: 'This category has been rejected by admin' };
    }
    return null;
};

/** Business-rule failures become row errors; anything else (DB down...) aborts the run. */
export const toRowError = (err) => {
    if (err instanceof ValidationError || err?.name === 'ValidationError') {
        return { code: mapServiceError(err.message), message: err.message };
    }
    throw err;
};

export const pendingImageUrls = (imageFiles) => imageFiles.map((name) => `pending://${name}`);

const rowResult = (entityType, parsed, rowNumber) => {
    const errors = parsed.errors;
    return {
        entityType,
        rowNumber,
        code: parsed.code || '',
        name: parsed.name || '',
        status: errors.length ? 'invalid' : 'pending',
        errorCode: errors[0]?.code || '',
        errorMessage: errors.map((e) => e.message).join(' | '),
        warnings: parsed.warnings || [],
        duplicate: ''
    };
};

const failRow = (result, code, message) => {
    result.status = 'invalid';
    result.errorCode = result.errorCode || code;
    result.errorMessage = result.errorMessage ? `${result.errorMessage} | ${message}` : message;
};

const normKey = (value) => String(value || '').trim().toLowerCase();

/**
 * Validate a whole package WITHOUT writing any Food/Addon data.
 * Every row goes through the same prepare/validate functions the single-item create flows use,
 * so validation and import can never disagree about the rules.
 */
export async function validateBulkPackage({ zipPath, fileName, entity, scope }) {
    await fsp.mkdir(STAGING_ROOT, { recursive: true });
    void cleanupStaleStaging();

    const stagingDir = path.join(STAGING_ROOT, crypto.randomBytes(12).toString('hex'));
    await fsp.mkdir(stagingDir, { recursive: true });

    try {
        // Restaurant must exist; admin selection is authoritative, restaurant comes from the token.
        let context;
        try {
            context = await getRestaurantContext(scope.restaurantId);
        } catch (err) {
            throw new BulkImportError(ERROR.RESTAURANT_NOT_FOUND, 'Restaurant not found.', 404);
        }

        const extracted = await extractBulkPackage(zipPath, stagingDir);
        const sheets = await readMenuWorkbook(extracted.workbookPath, entity);

        const foodParsed = sheets.foods.map((row) => ({ row, parsed: parseFoodRow(row.values) }));
        const addonParsed = sheets.addons.map((row) => ({ row, parsed: parseAddonRow(row.values) }));

        // ---- image inspection (each distinct referenced file once)
        const referenced = [...foodParsed, ...addonParsed].flatMap(({ parsed }) => parsed.imageFiles);
        const imageChecks = await inspectReferencedImages(referenced, extracted);

        const foodResults = [];
        const addonResults = [];
        const seenFoodCodes = new Map();
        const seenAddonCodes = new Map();
        const stagedFoods = [];
        const stagedAddons = [];

        const applyCommon = (entityType, { row, parsed }, result, seenCodes) => {
            const codeKey = normKey(parsed.code);
            if (codeKey) {
                if (seenCodes.has(codeKey)) {
                    failRow(result, ERROR.DUPLICATE_CODE, `Duplicate code "${parsed.code}" (first used on row ${seenCodes.get(codeKey)}).`);
                } else {
                    seenCodes.set(codeKey, row.rowNumber);
                }
            }
            if (parsed.informationalRestaurantId && parsed.informationalRestaurantId !== String(scope.restaurantId)) {
                failRow(
                    result,
                    ERROR.RESTAURANT_MISMATCH,
                    'restaurantId in the file does not match the restaurant this import is for. The file value is never used.'
                );
            }
            for (const name of parsed.imageFiles) {
                const check = imageChecks.get(name);
                if (check && !check.ok) failRow(result, check.code, imageErrorMessage(check.code, name));
            }
        };

        // ---- foods
        const caches = { categoryCache: new Map(), slotCache: new Map() };
        let existingKeys = null;
        const fileKeys = new Set();

        for (const item of foodParsed) {
            const result = rowResult('food', item.parsed, item.row.rowNumber);
            foodResults.push(result);
            applyCommon('food', item, result, seenFoodCodes);
            if (result.status === 'invalid') continue;

            try {
                const placeholders = pendingImageUrls(item.parsed.imageFiles);
                const { doc } = await prepareRestaurantFoodDoc(
                    scope.restaurantId,
                    { ...item.parsed.body, image: placeholders[0], images: placeholders },
                    { context, ...caches }
                );

                if (!existingKeys) {
                    const existing = await FoodItem.find({ restaurantId: scope.restaurantId }).select('name categoryId').lean();
                    existingKeys = new Set(existing.map((f) => `${f.categoryId || ''}|${normKey(f.name)}`));
                }
                const key = `${doc.categoryId || ''}|${normKey(doc.name)}`;
                if (existingKeys.has(key)) {
                    result.duplicate = 'existing';
                    result.warnings.push('A food with the same name already exists in this category for this restaurant.');
                } else if (fileKeys.has(key)) {
                    result.duplicate = 'in_file';
                    result.warnings.push('Another row in this file has the same name and category.');
                }
                fileKeys.add(key);
            } catch (err) {
                let { code, message } = toRowError(err);
                if (code === ERROR.CATEGORY_NOT_FOUND) {
                    const diagnosed = await diagnoseMissingCategory(scope.restaurantId, item.parsed.body);
                    if (diagnosed) ({ code, message } = diagnosed);
                }
                failRow(result, code, message);
                continue;
            }
            stagedFoods.push({ index: foodResults.length - 1, rowNumber: item.row.rowNumber, body: item.parsed.body, imageFiles: item.parsed.imageFiles });
        }

        // ---- addons
        const seenAddonNames = new Map();
        for (const item of addonParsed) {
            const result = rowResult('addon', item.parsed, item.row.rowNumber);
            addonResults.push(result);
            applyCommon('addon', item, result, seenAddonCodes);
            if (result.status === 'invalid') continue;

            const nameKey = normKey(item.parsed.name);
            if (seenAddonNames.has(nameKey)) {
                failRow(result, ERROR.ADDON_DUPLICATE, `Add-on name repeated in this file (first on row ${seenAddonNames.get(nameKey)}).`);
                continue;
            }

            try {
                const placeholders = pendingImageUrls(item.parsed.imageFiles);
                const withImages = { ...item.parsed.body, ...(placeholders.length ? { image: placeholders[0], images: placeholders } : {}) };
                if (scope.ownerType === 'ADMIN') {
                    // includes restaurant lookup, pure-veg, duplicate-name and "image required"
                    await prepareRestaurantAddonAdmin({ ...withImages, restaurantId: String(scope.restaurantId) });
                } else {
                    validateAddonCreateDto(withImages);
                    if (await findDuplicateAddonByName(scope.restaurantId, item.parsed.name)) {
                        throw new ValidationError('Add-on already exists');
                    }
                }
            } catch (err) {
                const { code, message } = toRowError(err);
                failRow(result, code, message);
                continue;
            }
            seenAddonNames.set(nameKey, item.row.rowNumber);
            stagedAddons.push({ index: addonResults.length - 1, rowNumber: item.row.rowNumber, body: item.parsed.body, imageFiles: item.parsed.imageFiles });
        }

        // ---- summary
        const count = (list, fn) => list.filter(fn).length;
        const referencedUnique = [...new Set(referenced)];
        const summary = {
            food: {
                total: foodResults.length,
                valid: count(foodResults, (r) => r.status === 'pending'),
                invalid: count(foodResults, (r) => r.status === 'invalid'),
                duplicates: count(foodResults, (r) => r.duplicate)
            },
            addon: {
                total: addonResults.length,
                valid: count(addonResults, (r) => r.status === 'pending'),
                invalid: count(addonResults, (r) => r.status === 'invalid')
            },
            images: {
                referenced: referencedUnique.length,
                found: count(referencedUnique, (n) => imageChecks.get(n)?.ok),
                missing: count(referencedUnique, (n) => imageChecks.get(n)?.code === ERROR.IMAGE_NOT_FOUND),
                invalid: count(referencedUnique, (n) => imageChecks.get(n) && !imageChecks.get(n).ok && imageChecks.get(n).code !== ERROR.IMAGE_NOT_FOUND)
            },
            ignoredEntries: extracted.ignored,
            fileName
        };

        // rows + image manifest are needed later by the import runner (possibly another process)
        await fsp.writeFile(
            path.join(stagingDir, 'parsed.json'),
            JSON.stringify({
                foods: stagedFoods,
                addons: stagedAddons,
                images: [...extracted.images.entries()]
            })
        );

        const rowResults = [...foodResults, ...addonResults];
        const job = await BulkMenuImportJob.create({
            jobCode: `IMP-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
            ownerType: scope.ownerType,
            createdBy: scope.createdBy,
            restaurantId: scope.restaurantId,
            entity,
            status: 'validated',
            fileName,
            stagingDir,
            validation: summary,
            progress: {
                food: { total: summary.food.valid, done: 0 },
                addon: { total: summary.addon.valid, done: 0 }
            },
            rowResults
        });

        return { job, summary, rowResults };
    } catch (err) {
        await removeDirSafe(stagingDir);
        throw err;
    }
}
