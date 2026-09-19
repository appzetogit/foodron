import { ERROR, LIMITS } from './constants.js';
import { isSafeImageFileName } from './zipExtractor.js';

/**
 * Cell -> typed value coercion for the Foods / Addons sheets.
 *
 * These parsers only turn spreadsheet cells into the same body shape the single-item forms
 * send (strings, numbers, arrays). Every business rule (category scope, pure-veg, variant
 * pricing, duplicate add-on names...) stays in the existing services, which the validation
 * and import passes call with these bodies.
 */

class CellError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const isEmpty = (value) => value == null || (typeof value === 'string' && value.trim() === '');

const toText = (value) => {
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString().slice(11, 16); // Excel time cells -> HH:mm
    return String(value).trim();
};

const toNumber = (value, label) => {
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || value < 0) throw new CellError(ERROR.INVALID_NUMBER, `${label} must be a number, 0 or more.`);
        return value;
    }
    const cleaned = String(value).trim().replace(/,/g, '');
    const parsed = Number(cleaned);
    if (cleaned === '' || !Number.isFinite(parsed) || parsed < 0) {
        throw new CellError(ERROR.INVALID_NUMBER, `${label} must be a number, 0 or more (got "${value}").`);
    }
    return parsed;
};

const toBoolean = (value, label) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (value === 1) return true;
        if (value === 0) return false;
    }
    const text = String(value).trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(text)) return true;
    if (['false', 'no', 'n', '0'].includes(text)) return false;
    throw new CellError(ERROR.INVALID_BOOLEAN, `${label} must be TRUE or FALSE (got "${value}").`);
};

const toList = (value) =>
    String(value)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);

export const parseFoodType = (value) => {
    const text = String(value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (text === 'veg') return 'Veg';
    if (text === 'non-veg' || text === 'nonveg') return 'Non-Veg';
    throw new CellError(ERROR.INVALID_FOOD_TYPE, `foodType must be "Veg" or "Non-Veg" (got "${value ?? ''}").`);
};

const parseImageNames = (imageCell, imagesCell) => {
    const names = [];
    if (!isEmpty(imageCell)) names.push(toText(imageCell));
    if (!isEmpty(imagesCell)) names.push(...toList(toText(imagesCell)));
    const unique = [...new Set(names)];
    for (const name of unique) {
        if (!isSafeImageFileName(name)) {
            throw new CellError(
                ERROR.UNSAFE_IMAGE_PATH,
                `Image "${name}" is not a plain file name. Use only the file name (e.g. F001.webp), no folders.`
            );
        }
    }
    if (unique.length > LIMITS.maxImagesPerRow) {
        throw new CellError(ERROR.TOO_MANY_IMAGES, `A row can reference at most ${LIMITS.maxImagesPerRow} images.`);
    }
    return unique;
};

const collect = (errors, fn) => {
    try {
        return fn();
    } catch (err) {
        if (err instanceof CellError) {
            errors.push({ code: err.code, message: err.message });
            return undefined;
        }
        throw err;
    }
};

const setIfPresent = (body, key, cell, convert) => {
    if (!isEmpty(cell)) body[key] = convert(cell);
};

export function parseFoodRow(values = {}) {
    const errors = [];
    const warnings = [];
    const body = {};

    const code = toText(values.itemCode);
    if (!code) errors.push({ code: ERROR.MISSING_CODE, message: 'itemCode is required.' });

    const name = toText(values.name);
    if (!name) errors.push({ code: ERROR.MISSING_NAME, message: 'name is required.' });
    body.name = name;

    setIfPresent(body, 'description', values.description, toText);
    setIfPresent(body, 'categoryName', values.categoryName, toText);
    setIfPresent(body, 'categoryId', values.categoryId, toText);
    if (!body.categoryId && !body.categoryName) {
        errors.push({ code: ERROR.CATEGORY_REQUIRED, message: 'categoryName or categoryId is required.' });
    }

    if (isEmpty(values.foodType)) {
        errors.push({ code: ERROR.INVALID_FOOD_TYPE, message: 'foodType is required (Veg or Non-Veg).' });
    } else {
        const foodType = collect(errors, () => parseFoodType(values.foodType));
        if (foodType) body.foodType = foodType;
    }

    // variants: JSON array, parsed here, validated by the existing variant normaliser later.
    let variants = [];
    if (!isEmpty(values.variants)) {
        collect(errors, () => {
            let parsed = values.variants;
            if (typeof parsed === 'string') {
                try {
                    parsed = JSON.parse(parsed);
                } catch (err) {
                    throw new CellError(ERROR.INVALID_VARIANTS, `variants is not valid JSON: ${err.message}`);
                }
            }
            if (!Array.isArray(parsed)) {
                throw new CellError(ERROR.INVALID_VARIANTS, 'variants must be a JSON array of {name, price, otherPrice, unit}.');
            }
            if (parsed.some((entry) => entry == null || typeof entry !== 'object' || Array.isArray(entry))) {
                throw new CellError(ERROR.INVALID_VARIANTS, 'Each variant must be a JSON object.');
            }
            variants = parsed;
        });
    }
    if (variants.length > 0) body.variants = variants;

    if (variants.length === 0) {
        if (isEmpty(values.price)) {
            errors.push({ code: ERROR.INVALID_PRICE, message: 'price is required (or provide variants).' });
        } else {
            const price = collect(errors, () => {
                let n;
                try {
                    n = toNumber(values.price, 'price');
                } catch (err) {
                    throw new CellError(ERROR.INVALID_PRICE, err.message);
                }
                if (n <= 0) throw new CellError(ERROR.INVALID_PRICE, 'price must be greater than 0.');
                return n;
            });
            if (price !== undefined) body.price = price;
        }
    } else if (!isEmpty(values.price)) {
        warnings.push('price is ignored because variants are provided (base price = cheapest variant).');
    }

    collect(errors, () => setIfPresent(body, 'otherPrice', values.otherPrice, (v) => toNumber(v, 'otherPrice')));
    collect(errors, () => setIfPresent(body, 'originalPrice', values.originalPrice, (v) => toNumber(v, 'originalPrice')));
    collect(errors, () => setIfPresent(body, 'discountAmount', values.discountAmount, (v) => toNumber(v, 'discountAmount')));
    collect(errors, () => setIfPresent(body, 'isAvailable', values.isAvailable, (v) => toBoolean(v, 'isAvailable')));
    collect(errors, () => setIfPresent(body, 'isRecommended', values.isRecommended, (v) => toBoolean(v, 'isRecommended')));
    collect(errors, () =>
        setIfPresent(body, 'discountType', values.discountType, (v) => {
            const text = toText(v).toLowerCase();
            if (text === 'percent') return 'Percent';
            if (text === 'amount') return 'Amount';
            throw new CellError(ERROR.INVALID_DISCOUNT_TYPE, `discountType must be "Percent" or "Amount" (got "${toText(v)}").`);
        })
    );
    setIfPresent(body, 'discount', values.discount, toText);
    setIfPresent(body, 'preparationTime', values.preparationTime, toText);
    setIfPresent(body, 'itemSlotTimingId', values.itemSlotTimingId, toText);
    setIfPresent(body, 'availabilityTimeStart', values.availabilityTimeStart, toText);
    setIfPresent(body, 'availabilityTimeEnd', values.availabilityTimeEnd, toText);
    setIfPresent(body, 'tags', values.tags, (v) => toList(toText(v)));
    setIfPresent(body, 'nutrition', values.nutrition, (v) => toList(toText(v)));
    setIfPresent(body, 'allergies', values.allergies, (v) => toList(toText(v)));

    const imageFiles = collect(errors, () => parseImageNames(values.image, values.images)) || [];
    if (imageFiles.length === 0 && !errors.some((e) => e.code === ERROR.UNSAFE_IMAGE_PATH || e.code === ERROR.TOO_MANY_IMAGES)) {
        errors.push({ code: ERROR.IMAGE_REQUIRED, message: 'image is required (file name inside images/).' });
    }

    return {
        code,
        name,
        body,
        imageFiles,
        errors,
        warnings,
        informationalRestaurantId: toText(values.restaurantId)
    };
}

export function parseAddonRow(values = {}) {
    const errors = [];
    const warnings = [];
    const body = {};

    const code = toText(values.addonCode);
    if (!code) errors.push({ code: ERROR.MISSING_CODE, message: 'addonCode is required.' });

    const name = toText(values.name);
    if (!name) errors.push({ code: ERROR.MISSING_NAME, message: 'name is required.' });
    body.name = name;

    setIfPresent(body, 'description', values.description, toText);

    if (isEmpty(values.price)) {
        errors.push({ code: ERROR.INVALID_PRICE, message: 'price is required (0 or more).' });
    } else {
        const price = collect(errors, () => {
            try {
                return toNumber(values.price, 'price');
            } catch (err) {
                throw new CellError(ERROR.INVALID_PRICE, err.message);
            }
        });
        if (price !== undefined) body.price = price;
    }

    if (isEmpty(values.foodType)) {
        errors.push({ code: ERROR.INVALID_FOOD_TYPE, message: 'foodType is required (Veg or Non-Veg).' });
    } else {
        const foodType = collect(errors, () => parseFoodType(values.foodType));
        if (foodType) body.foodType = foodType;
    }

    collect(errors, () => setIfPresent(body, 'isAvailable', values.isAvailable, (v) => toBoolean(v, 'isAvailable')));

    const imageFiles = collect(errors, () => parseImageNames(values.image, values.images)) || [];

    return {
        code,
        name,
        body,
        imageFiles,
        errors,
        warnings,
        informationalRestaurantId: toText(values.restaurantId)
    };
}
