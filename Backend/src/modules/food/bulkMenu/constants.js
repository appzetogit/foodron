/**
 * Shared constants for the bulk menu import layer.
 * The column lists below are the single source of truth for the parser, the
 * downloadable template and its README sheet.
 */

export const BULK_ENTITY = Object.freeze({ FOOD: 'food', ADDON: 'addon', BOTH: 'both' });
export const BULK_ENTITIES = Object.freeze(Object.values(BULK_ENTITY));

export const DUPLICATE_MODE = Object.freeze({ SKIP: 'skip', CREATE_ANYWAY: 'createAnyway' });

export const SHEET_FOODS = 'Foods';
export const SHEET_ADDONS = 'Addons';
export const SHEET_README = 'README';
export const WORKBOOK_NAME = 'menu.xlsx';
export const IMAGES_DIR = 'images';

export const LIMITS = Object.freeze({
    maxZipBytes: 150 * 1024 * 1024,
    maxWorkbookBytes: 10 * 1024 * 1024,
    // Same per-file cap the single-image upload endpoint enforces (middleware/upload.js).
    maxImageBytes: 5 * 1024 * 1024,
    maxZipEntries: 12000,
    maxTotalUncompressedBytes: 600 * 1024 * 1024,
    maxRowsPerSheet: 5000,
    // The add-on service already slices images to 10; foods use the same ceiling.
    maxImagesPerRow: 10
});

export const ALLOWED_IMAGE_EXTENSIONS = Object.freeze(['.webp', '.jpg', '.jpeg', '.png']);
export const ALLOWED_IMAGE_FORMATS = Object.freeze(['webp', 'jpeg', 'png']);

// Existing folder conventions used by the single-item screens.
export const IMAGE_FOLDERS = Object.freeze({
    food: 'appzeto/restaurant/menu-items',
    restaurantAddon: 'appzeto/restaurant/addons',
    adminAddon: 'appzeto/admin/addons'
});

export const IMPORT_CONCURRENCY = Object.freeze({ images: 4, rows: 4, batch: 20 });

export const ERROR = Object.freeze({
    // file level
    INVALID_ENTITY: 'INVALID_ENTITY',
    NO_FILE: 'NO_FILE',
    INVALID_ZIP: 'INVALID_ZIP',
    ZIP_TOO_LARGE: 'ZIP_TOO_LARGE',
    UNSAFE_ZIP_ENTRY: 'UNSAFE_ZIP_ENTRY',
    MISSING_WORKBOOK: 'MISSING_WORKBOOK',
    INVALID_WORKBOOK: 'INVALID_WORKBOOK',
    MISSING_SHEET: 'MISSING_SHEET',
    MISSING_COLUMNS: 'MISSING_COLUMNS',
    UNSUPPORTED_COLUMNS: 'UNSUPPORTED_COLUMNS',
    TOO_MANY_ROWS: 'TOO_MANY_ROWS',
    EMPTY_SHEET: 'EMPTY_SHEET',
    RESTAURANT_NOT_FOUND: 'RESTAURANT_NOT_FOUND',
    // row level
    MISSING_CODE: 'MISSING_CODE',
    DUPLICATE_CODE: 'DUPLICATE_CODE',
    MISSING_NAME: 'MISSING_NAME',
    INVALID_PRICE: 'INVALID_PRICE',
    INVALID_NUMBER: 'INVALID_NUMBER',
    INVALID_FOOD_TYPE: 'INVALID_FOOD_TYPE',
    INVALID_BOOLEAN: 'INVALID_BOOLEAN',
    INVALID_DISCOUNT_TYPE: 'INVALID_DISCOUNT_TYPE',
    INVALID_VARIANTS: 'INVALID_VARIANTS',
    CATEGORY_REQUIRED: 'CATEGORY_REQUIRED',
    CATEGORY_NOT_FOUND: 'CATEGORY_NOT_FOUND',
    CATEGORY_AMBIGUOUS: 'CATEGORY_AMBIGUOUS',
    CATEGORY_INACTIVE: 'CATEGORY_INACTIVE',
    CATEGORY_PENDING: 'CATEGORY_PENDING',
    CATEGORY_REJECTED: 'CATEGORY_REJECTED',
    FOOD_TYPE_CATEGORY_MISMATCH: 'FOOD_TYPE_CATEGORY_MISMATCH',
    PURE_VEG_VIOLATION: 'PURE_VEG_VIOLATION',
    INVALID_SLOT_TIMING: 'INVALID_SLOT_TIMING',
    IMAGE_REQUIRED: 'IMAGE_REQUIRED',
    TOO_MANY_IMAGES: 'TOO_MANY_IMAGES',
    UNSAFE_IMAGE_PATH: 'UNSAFE_IMAGE_PATH',
    IMAGE_NOT_FOUND: 'IMAGE_NOT_FOUND',
    INVALID_IMAGE_TYPE: 'INVALID_IMAGE_TYPE',
    IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
    IMAGE_UNREADABLE: 'IMAGE_UNREADABLE',
    RESTAURANT_MISMATCH: 'RESTAURANT_MISMATCH',
    ADDON_DUPLICATE: 'ADDON_DUPLICATE',
    DUPLICATE_FOOD: 'DUPLICATE_FOOD',
    VALIDATION_FAILED: 'VALIDATION_FAILED',
    IMPORT_FAILED: 'IMPORT_FAILED',
    IMAGE_PROCESSING_FAILED: 'IMAGE_PROCESSING_FAILED'
});

/**
 * Food sheet columns. `required` is enforced by the row parser; the `oneOf` groups
 * (category, price) need at least one member present, in the header and in each row.
 * Every column maps onto a field the existing restaurant food service persists.
 */
export const FOOD_COLUMNS = Object.freeze([
    { key: 'itemCode', basic: true, required: true, note: 'Your own unique code for the row. Import-only: it is never stored on the food item.' },
    { key: 'name', basic: true, required: true, note: 'Item name (max 200 characters).' },
    { key: 'description', basic: true, note: 'Free text.' },
    { key: 'categoryName', basic: true, oneOf: 'category', note: 'Exact category name (case-insensitive). Use categoryId if the same name exists more than once.' },
    { key: 'categoryId', oneOf: 'category', note: 'Category id. Takes priority over categoryName when both are given.' },
    { key: 'price', basic: true, oneOf: 'price', note: 'Base price, must be greater than 0. Ignored (with a warning) when variants are provided.' },
    { key: 'otherPrice', note: 'Optional strike-through price, 0 or more.' },
    { key: 'foodType', basic: true, required: true, note: 'Veg or Non-Veg.' },
    { key: 'image', basic: true, required: true, note: 'Image file name inside images/ (e.g. F001.webp). At least one image is required.' },
    { key: 'images', note: 'Extra image file names, comma separated (e.g. F001-2.webp,F001-3.webp).' },
    { key: 'isAvailable', note: 'TRUE/FALSE. Defaults to TRUE.' },
    { key: 'preparationTime', note: 'Free text, e.g. "15 mins".' },
    { key: 'itemSlotTimingId', note: "Id of one of this restaurant's item slot timings." },
    { key: 'variants', oneOf: 'price', note: 'JSON array: [{"name":"Regular","price":149,"otherPrice":0,"unit":"piece"}]. When present the base price is derived from the cheapest variant.' },
    { key: 'discountType', note: 'Percent or Amount. Defaults to Percent.' },
    { key: 'discountAmount', note: 'Number, 0 or more.' },
    { key: 'discount', note: 'Free text label.' },
    { key: 'isRecommended', note: 'TRUE/FALSE.' },
    { key: 'tags', note: 'Comma separated.' },
    { key: 'nutrition', note: 'Comma separated.' },
    { key: 'allergies', note: 'Comma separated.' },
    { key: 'availabilityTimeStart', note: 'Free text, e.g. 09:00.' },
    { key: 'availabilityTimeEnd', note: 'Free text, e.g. 22:00.' },
    { key: 'originalPrice', note: 'Number, 0 or more.' }
]);

export const ADDON_COLUMNS = Object.freeze([
    { key: 'addonCode', basic: true, required: true, note: 'Your own unique code for the row. Import-only: never stored.' },
    { key: 'name', basic: true, required: true, note: 'Add-on name (max 200). Must be unique per restaurant (case-insensitive).' },
    { key: 'description', basic: true, note: 'Free text.' },
    { key: 'price', basic: true, required: true, note: 'Number, 0 or more.' },
    { key: 'foodType', basic: true, required: true, note: 'Veg or Non-Veg.' },
    { key: 'image', basic: true, note: 'Image file name inside images/. Required when an admin imports add-ons.' },
    { key: 'images', note: 'Extra image file names, comma separated.' },
    { key: 'isAvailable', note: 'TRUE/FALSE. Defaults to TRUE.' }
]);

/** Columns shown in the default (simple) template; the full template adds the rest. */
export const basicColumns = (columns) => columns.filter((c) => c.basic);

/** Optional informational column on both sheets; never trusted, only cross-checked. */
export const INFORMATIONAL_COLUMNS = Object.freeze(['restaurantId']);

export class BulkImportError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'BulkImportError';
        this.code = code;
        this.statusCode = status;
    }
}
