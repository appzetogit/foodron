/**
 * Integration tests for the bulk menu import layer.
 *
 * Run against a THROWAWAY MongoDB only:
 *   BULK_TEST_MONGODB_URI=mongodb://127.0.0.1:27017/cravioo_bulk_test node --test tests/bulkMenu.test.mjs
 * The suite refuses to run against Atlas (mongodb.net) URIs, disables Redis/BullMQ (jobs run
 * inline) and writes uploaded images to a temp directory, never to Backend/uploads.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const TEST_URI = process.env.BULK_TEST_MONGODB_URI || '';
if (!TEST_URI || /mongodb\.net/i.test(TEST_URI)) {
    throw new Error('Set BULK_TEST_MONGODB_URI to a local/throwaway MongoDB (Atlas URIs are refused).');
}

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cravioo-bulk-uploads-'));
process.env.UPLOAD_PATH = UPLOAD_DIR;
process.env.REDIS_ENABLED = 'false';
process.env.BULLMQ_ENABLED = 'false';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'bulk-test-secret';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'bulk-test-secret';

const { default: mongoose } = await import('mongoose');
const { default: express } = await import('express');
const { default: ExcelJS } = await import('exceljs');
const { default: JSZip } = await import('jszip');
const { default: sharp } = await import('sharp');

const { FoodItem } = await import('../src/modules/food/admin/models/food.model.js');
const { FoodCategory } = await import('../src/modules/food/admin/models/category.model.js');
const { FoodAddon } = await import('../src/modules/food/restaurant/models/foodAddon.model.js');
const { FoodRestaurant } = await import('../src/modules/food/restaurant/models/restaurant.model.js');
const { FoodAdmin } = await import('../src/core/admin/admin.model.js');
const { ItemSlotTiming } = await import('../src/modules/food/restaurant/models/itemSlotTiming.model.js');
const { BulkMenuImportJob } = await import('../src/modules/food/bulkMenu/models/bulkMenuImportJob.model.js');
const { approveFoodItem } = await import('../src/modules/food/admin/services/foodApproval.service.js');
const { getPublicApprovedRestaurantMenu } = await import('../src/modules/food/restaurant/services/restaurantMenu.service.js');
const { getPublicApprovedRestaurantAddons } = await import('../src/modules/food/restaurant/services/publicAddons.service.js');
const { signAccessToken } = await import('../src/core/auth/token.util.js');
const { authMiddleware } = await import('../src/core/auth/auth.middleware.js');
const { requireRoles } = await import('../src/core/roles/role.middleware.js');
const restaurantRoutes = (await import('../src/modules/food/restaurant/routes/restaurant.routes.js')).default;
const adminRoutes = (await import('../src/modules/food/admin/routes/admin.routes.js')).default;

// ------------------------------------------------------------------ fixtures & helpers
const oid = () => new mongoose.Types.ObjectId();
let R1; // mixed restaurant
let RV; // pure-veg restaurant
let R2; // another restaurant (private category owner)
let CAT = {};
let SLOT;
let server;
let base;
let adminToken;
let r1Token;
let r2Token;
let rvToken;

const webp = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#cc3300' } }).webp().toBuffer();
const png = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#0033cc' } }).png().toBuffer();

const FOOD_HEADERS = ['itemCode', 'name', 'description', 'categoryName', 'categoryId', 'price', 'otherPrice', 'foodType', 'image', 'images', 'isAvailable', 'preparationTime', 'itemSlotTimingId', 'variants', 'restaurantId'];
const ADDON_HEADERS = ['addonCode', 'name', 'description', 'price', 'foodType', 'image', 'images', 'isAvailable', 'restaurantId'];

const buildWorkbook = async ({ foods, addons, foodHeaders = FOOD_HEADERS, addonHeaders = ADDON_HEADERS, skipFoodsSheet = false }) => {
    const wb = new ExcelJS.Workbook();
    if (foods && !skipFoodsSheet) {
        const ws = wb.addWorksheet('Foods');
        ws.addRow(foodHeaders);
        for (const row of foods) ws.addRow(foodHeaders.map((h) => row[h] ?? null));
    }
    if (addons) {
        const ws = wb.addWorksheet('Addons');
        ws.addRow(addonHeaders);
        for (const row of addons) ws.addRow(addonHeaders.map((h) => row[h] ?? null));
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
};

/** images: { 'F001.webp': Buffer } ; extra: [{name, data, options}] raw zip entries */
const buildZip = async ({ workbook, images = {}, extra = [], workbookName = 'menu.xlsx' }) => {
    const zip = new JSZip();
    if (workbook) zip.file(workbookName, workbook);
    for (const [name, data] of Object.entries(images)) zip.file(`images/${name}`, data);
    for (const { name, data, options } of extra) zip.file(name, data, options);
    return zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' });
};

const food = (i, over = {}) => ({
    itemCode: `F${String(i).padStart(3, '0')}`,
    name: `Item ${i}`,
    categoryName: 'Burger',
    price: 100 + i,
    foodType: 'Veg',
    image: `F${String(i).padStart(3, '0')}.webp`,
    ...over
});
const imagesFor = (count, start = 1) =>
    Object.fromEntries(Array.from({ length: count }, (_, k) => [`F${String(start + k).padStart(3, '0')}.webp`, webp]));

const call = async (method, url, { token, body, form } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) payload = form;
    else if (body) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${url}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: res.status, json, text };
};

const uploadZip = (url, token, zipBuffer, name = 'cravioo-menu-import.zip') => {
    const form = new FormData();
    form.append('file', new Blob([zipBuffer], { type: 'application/zip' }), name);
    return call('POST', url, { token, form });
};

const restaurantValidate = (token, zip, entity = 'food') => uploadZip(`/api/v1/food/restaurant/bulk-menu/validate?entity=${entity}`, token, zip);
const adminValidate = (restaurantId, zip, entity = 'food', token = adminToken) =>
    uploadZip(`/api/v1/food/admin/restaurants/${restaurantId}/bulk-menu/validate?entity=${entity}`, token, zip);

const waitForJob = async (jobId, timeoutMs = 120000) => {
    const start = Date.now();
    for (;;) {
        const job = await BulkMenuImportJob.findById(jobId).lean();
        if (job && ['completed', 'failed'].includes(job.status)) return job;
        if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} timed out in status ${job?.status}`);
        await new Promise((r) => setTimeout(r, 100));
    }
};

const runRestaurantImport = async (token, zip, entity, duplicateMode) => {
    const v = await restaurantValidate(token, zip, entity);
    assert.equal(v.status, 200, v.text);
    const start = await call('POST', `/api/v1/food/restaurant/bulk-menu/imports/${v.json.data.jobId}/start`, { token, body: { duplicateMode } });
    assert.equal(start.status, 202, start.text);
    const job = await waitForJob(v.json.data.jobId);
    return { validation: v.json.data, job };
};
const runAdminImport = async (restaurantId, zip, entity, duplicateMode) => {
    const v = await adminValidate(restaurantId, zip, entity);
    assert.equal(v.status, 200, v.text);
    const start = await call('POST', `/api/v1/food/admin/bulk-menu/imports/${v.json.data.jobId}/start`, { token: adminToken, body: { duplicateMode } });
    assert.equal(start.status, 202, start.text);
    const job = await waitForJob(v.json.data.jobId);
    return { validation: v.json.data, job };
};

const rowByCode = (rows, code) => rows.find((r) => r.code === code);

// ------------------------------------------------------------------ suite
before(async () => {
    await mongoose.connect(TEST_URI, { serverSelectionTimeoutMS: 15000, autoIndex: false });
    await mongoose.connection.dropDatabase();

    const mk = (name, extra = {}) => FoodRestaurant.create({ restaurantName: name, ownerName: 'Owner', pureVegRestaurant: false, status: 'approved', isActive: true, isListed: true, ...extra });
    [R1, RV, R2] = await Promise.all([mk('Mixed Kitchen'), mk('Pure Veg Kitchen', { pureVegRestaurant: true }), mk('Other Kitchen')]);

    const cat = (name, extra = {}) => FoodCategory.create({ name, image: '/x.webp', foodTypeScope: 'Veg', approvalStatus: 'approved', isApproved: true, isActive: true, ...extra });
    CAT.burger = await cat('Burger');
    CAT.chicken = await cat('Chicken', { foodTypeScope: 'Non-Veg' });
    CAT.own = await cat('Desserts', { restaurantId: R1._id, createdByRestaurantId: R1._id });
    CAT.r2private = await cat('Secret R2', { restaurantId: R2._id, createdByRestaurantId: R2._id });
    CAT.pending = await cat('PendingCat', { restaurantId: R1._id, createdByRestaurantId: R1._id, approvalStatus: 'pending', isApproved: false });
    CAT.rejected = await cat('RejectedCat', { restaurantId: R1._id, createdByRestaurantId: R1._id, approvalStatus: 'rejected', isApproved: false });
    CAT.inactive = await cat('InactiveCat', { isActive: false });
    CAT.twin1 = await cat('Twin');
    CAT.twin2 = await cat('Twin');
    SLOT = await ItemSlotTiming.create({ restaurantId: R1._id, name: 'Lunch', startTime: '12:00', endTime: '15:00' });

    const app = express();
    app.use(express.json());
    app.use('/api/v1/food/restaurant', restaurantRoutes);
    app.use('/api/v1/food/admin', authMiddleware, requireRoles('ADMIN', 'EMPLOYEE'), adminRoutes);
    app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ success: false, message: err.message }));
    server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;

    const admin = await FoodAdmin.create({ email: 'bulk-test-admin@example.com', password: 'Passw0rd!x', name: 'Bulk Tester', role: 'ADMIN', isActive: true });
    adminToken = signAccessToken({ userId: String(admin._id), role: 'ADMIN' });
    r1Token = signAccessToken({ userId: String(R1._id), role: 'RESTAURANT' });
    r2Token = signAccessToken({ userId: String(R2._id), role: 'RESTAURANT' });
    rvToken = signAccessToken({ userId: String(RV._id), role: 'RESTAURANT' });
});

after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
    setTimeout(() => process.exit(0), 200).unref();
});

describe('auth & scope', () => {
    it('rejects unauthenticated and wrong-role callers', async () => {
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: [food(1)] }), images: imagesFor(1) });
        assert.equal((await uploadZip('/api/v1/food/restaurant/bulk-menu/validate?entity=food', null, zip)).status, 401);
        assert.equal((await restaurantValidate(adminToken, zip)).status, 403, 'admin token is not a restaurant');
        assert.equal((await adminValidate(R1._id, zip, 'food', r1Token)).status, 403, 'restaurant token cannot use admin route');
    });

    it('rejects an invalid entity before any upload work', async () => {
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: [food(1)] }), images: imagesFor(1) });
        const res = await restaurantValidate(r1Token, zip, 'bogus');
        assert.equal(res.status, 400);
        assert.equal(res.json.code, 'INVALID_ENTITY');
    });

    it('restaurant scope always comes from the token; restaurantId column cannot redirect it', async () => {
        const zip = await buildZip({
            workbook: await buildWorkbook({ foods: [food(1, { restaurantId: String(R2._id) }), food(2)] }),
            images: imagesFor(2)
        });
        const { validation, job } = await runRestaurantImport(r1Token, zip, 'food', 'skip');
        assert.equal(rowByCode(validation.rows, 'F001').errorCode, 'RESTAURANT_MISMATCH');
        assert.equal(rowByCode(validation.rows, 'F002').status, 'pending');
        assert.equal(job.counters.imported, 1);
        const created = await FoodItem.find({ restaurantId: R1._id, name: 'Item 2' }).lean();
        assert.equal(created.length, 1);
        assert.equal(await FoodItem.countDocuments({ restaurantId: R2._id }), 0);
    });

    it("another restaurant cannot read or start someone else's job", async () => {
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: [food(1)] }), images: imagesFor(1) });
        const v = await restaurantValidate(r1Token, zip);
        const jobId = v.json.data.jobId;
        assert.equal((await call('GET', `/api/v1/food/restaurant/bulk-menu/imports/${jobId}`, { token: r2Token })).status, 404);
        assert.equal((await call('POST', `/api/v1/food/restaurant/bulk-menu/imports/${jobId}/start`, { token: r2Token, body: {} })).status, 404);
        await BulkMenuImportJob.deleteOne({ _id: jobId });
    });
});

describe('restaurant food import', () => {
    it('imports 1 food as pending with requestedAt and no productCount change', async () => {
        const before = (await FoodRestaurant.findById(R1._id).lean()).productCount || 0;
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: [food(11, { name: 'Solo Burger', images: null })] }), images: imagesFor(1, 11) });
        const { job } = await runRestaurantImport(r1Token, zip, 'food', 'skip');
        assert.equal(job.status, 'completed');
        assert.equal(job.counters.imported, 1);
        const doc = await FoodItem.findOne({ restaurantId: R1._id, name: 'Solo Burger' }).lean();
        assert.equal(doc.approvalStatus, 'pending');
        assert.ok(doc.requestedAt);
        assert.equal(doc.foodType, 'Veg');
        assert.equal(String(doc.categoryId), String(CAT.burger._id));
        assert.match(doc.image, /^\/uploads\/appzeto\/restaurant\/menu-items\/.+\.webp$/);
        assert.deepEqual(doc.images, [doc.image]);
        assert.ok(fs.existsSync(path.join(UPLOAD_DIR, doc.image.replace('/uploads/', ''))), 'image written by the existing upload service');
        assert.equal((await FoodRestaurant.findById(R1._id).lean()).productCount || 0, before, 'productCount only moves on approval');
    });

    it('imports 100 foods; all pending; one batched notification pass', async () => {
        const rows = Array.from({ length: 100 }, (_, i) => food(200 + i, { name: `Batch Burger ${i}` }));
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: rows }), images: imagesFor(100, 200) });
        const { job, validation } = await runRestaurantImport(r1Token, zip, 'food', 'skip');
        assert.equal(validation.summary.food.valid, 100);
        assert.equal(job.counters.imported, 100);
        assert.equal(job.progress.food.done, 100);
        const docs = await FoodItem.find({ restaurantId: R1._id, name: /^Batch Burger/ }).lean();
        assert.equal(docs.length, 100);
        assert.ok(docs.every((d) => d.approvalStatus === 'pending'));
    });

    it('imports 600 rows (500+) with per-row results', async () => {
        const rows = Array.from({ length: 600 }, (_, i) => food(1000 + i, { name: `Big ${i}`, categoryName: i % 2 ? 'Burger' : 'Desserts' }));
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: rows }), images: imagesFor(600, 1000) });
        const t0 = Date.now();
        const { job } = await runRestaurantImport(r1Token, zip, 'food', 'skip');
        console.log(`      600 rows import+validate: ${Date.now() - t0}ms`);
        assert.equal(job.counters.imported, 600);
        assert.equal(job.counters.failed, 0);
        assert.equal(job.rowResults.length, 600);
        assert.ok(job.rowResults.every((r) => r.status === 'success'));
    });

    it('keeps successful rows when another row fails at import time', async () => {
        const zip = await buildZip({
            workbook: await buildWorkbook({ foods: [food(21, { name: 'Ok A' }), food(22, { name: 'Bad B', price: 'abc' }), food(23, { name: 'Ok C' })] }),
            images: imagesFor(3, 21)
        });
        const { validation, job } = await runRestaurantImport(r1Token, zip, 'food', 'skip');
        assert.equal(validation.summary.food.valid, 2);
        assert.equal(validation.summary.food.invalid, 1);
        assert.equal(job.counters.imported, 2);
        assert.equal(rowByCode(job.rowResults, 'F022').status, 'invalid');
        assert.equal(rowByCode(job.rowResults, 'F022').errorCode, 'INVALID_PRICE');
        assert.ok(await FoodItem.findOne({ restaurantId: R1._id, name: 'Ok A' }));
        assert.ok(await FoodItem.findOne({ restaurantId: R1._id, name: 'Ok C' }));
        assert.equal(await FoodItem.countDocuments({ restaurantId: R1._id, name: 'Bad B' }), 0);
    });

    it('supports variants, multiple images, slot timing, tags and unavailable flag', async () => {
        const variants = JSON.stringify([{ name: 'Regular', price: 149, otherPrice: 0, unit: 'piece' }, { name: 'Large', price: 199, otherPrice: 250, unit: 'piece' }]);
        const zip = await buildZip({
            workbook: await buildWorkbook({
                foods: [food(31, { name: 'Variant Pizza', price: 999, variants, images: 'F031-2.webp,F031-3.png', itemSlotTimingId: String(SLOT._id), isAvailable: 'FALSE', preparationTime: '15 mins' })]
            }),
            images: { 'F031.webp': webp, 'F031-2.webp': webp, 'F031-3.png': png }
        });
        const { validation, job } = await runRestaurantImport(r1Token, zip, 'food', 'skip');
        assert.ok(rowByCode(validation.rows, 'F031').warnings.some((w) => /price is ignored/.test(w)));
        assert.equal(job.counters.imported, 1);
        const doc = await FoodItem.findOne({ restaurantId: R1._id, name: 'Variant Pizza' }).lean();
        assert.equal(doc.variants.length, 2);
        assert.equal(doc.price, 149, 'base price derived from cheapest variant by the existing rule');
        assert.equal(doc.images.length, 3);
        assert.equal(doc.image, doc.images[0]);
        assert.equal(String(doc.itemSlotTimingId), String(SLOT._id));
        assert.equal(doc.isAvailable, false);
        assert.equal(doc.preparationTime, '15 mins');
    });

    it('handles duplicates: flags, Skip and Create anyway; food names are never used alone', async () => {
        const rows = [food(41, { name: 'Dupe Dish' }), food(42, { name: 'dupe dish' }), food(43, { name: 'Dupe Dish', categoryName: 'Desserts' })];
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: rows }), images: imagesFor(3, 41) });

        const first = await runRestaurantImport(r1Token, zip, 'food', 'skip');
        // F042 repeats F041 (same name, case-insensitive, same category) inside the file; F043 differs by category
        assert.equal(rowByCode(first.validation.rows, 'F042').duplicate, 'in_file');
        assert.equal(rowByCode(first.validation.rows, 'F043').duplicate, '');
        assert.equal(first.job.counters.imported, 2);
        assert.equal(first.job.counters.skipped, 1);
        assert.equal(await FoodItem.countDocuments({ restaurantId: R1._id, name: /^dupe dish$/i }), 2);

        const second = await runRestaurantImport(r1Token, zip, 'food', 'skip'); // everything exists now
        assert.equal(second.job.counters.imported, 0);
        assert.equal(second.job.counters.skipped, 3);
        assert.equal(rowByCode(second.validation.rows, 'F041').duplicate, 'existing');

        const third = await runRestaurantImport(r1Token, zip, 'food', 'createAnyway');
        assert.equal(third.job.counters.imported, 3);
        assert.equal(await FoodItem.countDocuments({ restaurantId: R1._id, name: /^dupe dish$/i }), 5);
    });
});

describe('category resolution (existing restaurant policy)', () => {
    const cases = [
        ['unknown category', { categoryName: 'Nope' }, 'CATEGORY_NOT_FOUND'],
        ['pending category', { categoryName: 'PendingCat' }, 'CATEGORY_PENDING'],
        ['rejected category', { categoryName: 'RejectedCat' }, 'CATEGORY_REJECTED'],
        ['inactive category', { categoryName: 'InactiveCat' }, 'CATEGORY_INACTIVE'],
        ['ambiguous name', { categoryName: 'Twin' }, 'CATEGORY_AMBIGUOUS'],
        ["another restaurant's private category", { categoryName: 'Secret R2' }, 'CATEGORY_NOT_FOUND'],
        ['veg category with Non-Veg food', { categoryName: 'Burger', foodType: 'Non-Veg' }, 'FOOD_TYPE_CATEGORY_MISMATCH'],
        ['Non-Veg category with Veg food', { categoryName: 'Chicken', foodType: 'Veg' }, 'FOOD_TYPE_CATEGORY_MISMATCH']
    ];
    for (const [label, over, code] of cases) {
        it(`restaurant: ${label} -> ${code}`, async () => {
            const zip = await buildZip({ workbook: await buildWorkbook({ foods: [food(51, { name: `Cat Test ${label}`, ...over })] }), images: imagesFor(1, 51) });
            const v = await restaurantValidate(r1Token, zip);
            assert.equal(v.status, 200);
            assert.equal(rowByCode(v.json.data.rows, 'F051').errorCode, code);
            assert.equal(v.json.data.summary.food.valid, 0);
            await BulkMenuImportJob.deleteOne({ _id: v.json.data.jobId });
        });
    }

    it('categoryId takes priority and a valid own private category resolves', async () => {
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: [food(52, { name: 'By Id', categoryName: null, categoryId: String(CAT.own._id) })] }), images: imagesFor(1, 52) });
        const { job } = await runRestaurantImport(r1Token, zip, 'food', 'skip');
        assert.equal(job.counters.imported, 1);
        assert.equal(String((await FoodItem.findOne({ name: 'By Id' }).lean()).categoryId), String(CAT.own._id));
    });

    it('admin import cannot attach to another restaurant\'s private category (by name or id)', async () => {
        const rows = [food(53, { name: 'Admin Secret Name', categoryName: 'Secret R2' }), food(54, { name: 'Admin Secret Id', categoryName: null, categoryId: String(CAT.r2private._id) })];
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: rows }), images: imagesFor(2, 53) });
        const v = await adminValidate(R1._id, zip);
        assert.equal(v.status, 200);
        assert.equal(rowByCode(v.json.data.rows, 'F053').errorCode, 'CATEGORY_NOT_FOUND');
        assert.equal(rowByCode(v.json.data.rows, 'F054').errorCode, 'CATEGORY_NOT_FOUND');
        await BulkMenuImportJob.deleteOne({ _id: v.json.data.jobId });
    });

    it('pure-veg restaurant rejects Non-Veg food and Non-Veg categories', async () => {
        const rows = [food(55, { name: 'NV in PV', foodType: 'Non-Veg', categoryName: 'Chicken' }), food(56, { name: 'Veg in PV' })];
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: rows }), images: imagesFor(2, 55) });
        const v = await restaurantValidate(rvToken, zip);
        assert.equal(rowByCode(v.json.data.rows, 'F055').errorCode, 'PURE_VEG_VIOLATION');
        assert.equal(rowByCode(v.json.data.rows, 'F056').status, 'pending');
        await BulkMenuImportJob.deleteOne({ _id: v.json.data.jobId });
    });
});

describe('row validation', () => {
    it('reports each invalid row with a code, keeping valid rows importable', async () => {
        const rows = [
            food(61, { name: 'Valid One' }),
            food(62, { name: 'Wrong type', foodType: 'Vegan' }),
            food(63, { name: 'Bad price', price: -5 }),
            food(64, { name: 'Zero price', price: 0 }),
            food(65, { name: 'Bad variants', price: null, variants: '{not json' }),
            food(66, { name: 'Variant price', price: null, variants: JSON.stringify([{ name: 'S', price: 0 }]) }),
            food(67, { name: 'Bad bool', isAvailable: 'maybe' }),
            food(68, { name: 'Bad slot', itemSlotTimingId: String(oid()) }),
            food(69, { name: 'No image', image: null }),
            food(70, { name: '', image: 'F070.webp' }),
            food(71, { name: 'No cat', categoryName: null }),
            food(61, { name: 'Repeated code', image: 'F061.webp' })
        ];
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: rows }), images: imagesFor(11, 61) });
        const v = await restaurantValidate(r1Token, zip);
        const r = v.json.data.rows;
        assert.equal(rowByCode(r, 'F061').status, 'pending');
        assert.equal(rowByCode(r, 'F062').errorCode, 'INVALID_FOOD_TYPE');
        assert.equal(rowByCode(r, 'F063').errorCode, 'INVALID_PRICE');
        assert.equal(rowByCode(r, 'F064').errorCode, 'INVALID_PRICE');
        assert.equal(rowByCode(r, 'F065').errorCode, 'INVALID_VARIANTS');
        assert.equal(rowByCode(r, 'F066').errorCode, 'INVALID_VARIANTS');
        assert.equal(rowByCode(r, 'F067').errorCode, 'INVALID_BOOLEAN');
        assert.equal(rowByCode(r, 'F068').errorCode, 'INVALID_SLOT_TIMING');
        assert.equal(rowByCode(r, 'F069').errorCode, 'IMAGE_REQUIRED');
        assert.equal(rowByCode(r, 'F070').errorCode, 'MISSING_NAME');
        assert.equal(rowByCode(r, 'F071').errorCode, 'CATEGORY_REQUIRED');
        const dup = r.filter((x) => x.code === 'F061' && x.status === 'invalid');
        assert.equal(dup[0].errorCode, 'DUPLICATE_CODE');
        assert.equal(v.json.data.summary.food.valid, 1);
        await BulkMenuImportJob.deleteOne({ _id: v.json.data.jobId });
    });

    it('rejects unsupported columns, missing columns and missing sheets at file level', async () => {
        const withExtra = await buildZip({ workbook: await buildWorkbook({ foods: [food(1)], foodHeaders: [...FOOD_HEADERS, 'addonIds'] }), images: imagesFor(1) });
        let v = await restaurantValidate(r1Token, withExtra);
        assert.equal(v.status, 400);
        assert.equal(v.json.code, 'UNSUPPORTED_COLUMNS');

        const missingCols = await buildZip({ workbook: await buildWorkbook({ foods: [{ name: 'x' }], foodHeaders: ['name', 'price'] }) });
        v = await restaurantValidate(r1Token, missingCols);
        assert.equal(v.json.code, 'MISSING_COLUMNS');

        const noSheet = await buildZip({ workbook: await buildWorkbook({ addons: [{ addonCode: 'A1', name: 'x', price: 1, foodType: 'Veg' }] }) });
        v = await restaurantValidate(r1Token, noSheet, 'food');
        assert.equal(v.json.code, 'MISSING_SHEET');
    });
});

describe('image mapping & safety', () => {
    it('missing / wrong-case / wrong-type / oversize / corrupt images fail only their rows', async () => {
        const rows = [
            food(81, { name: 'Img ok' }),
            food(82, { name: 'Img missing', image: 'NOPE.webp' }),
            food(83, { name: 'Img wrong case', image: 'f083.WEBP' }),
            food(84, { name: 'Img gif', image: 'F084.gif' }),
            food(85, { name: 'Img big', image: 'F085.webp' }),
            food(86, { name: 'Img corrupt', image: 'F086.webp' }),
            food(87, { name: 'Img traversal', image: '../secret.webp' }),
            food(88, { name: 'Img folder', image: 'sub/F088.webp' })
        ];
        const zip = await buildZip({
            workbook: await buildWorkbook({ foods: rows }),
            images: { 'F081.webp': webp, 'F083.webp': webp, 'F084.gif': webp, 'F085.webp': Buffer.alloc(6 * 1024 * 1024, 7), 'F086.webp': Buffer.from('this is not an image') }
        });
        const v = await restaurantValidate(r1Token, zip);
        const r = v.json.data.rows;
        assert.equal(rowByCode(r, 'F081').status, 'pending');
        assert.equal(rowByCode(r, 'F082').errorCode, 'IMAGE_NOT_FOUND');
        assert.match(rowByCode(r, 'F082').errorMessage, /Image not found: NOPE\.webp/);
        assert.equal(rowByCode(r, 'F083').errorCode, 'IMAGE_NOT_FOUND', 'names are matched exactly, never guessed');
        assert.equal(rowByCode(r, 'F084').errorCode, 'INVALID_IMAGE_TYPE');
        assert.equal(rowByCode(r, 'F085').errorCode, 'IMAGE_TOO_LARGE');
        assert.equal(rowByCode(r, 'F086').errorCode, 'IMAGE_UNREADABLE');
        assert.equal(rowByCode(r, 'F087').errorCode, 'UNSAFE_IMAGE_PATH');
        assert.equal(rowByCode(r, 'F088').errorCode, 'UNSAFE_IMAGE_PATH');
        assert.equal(v.json.data.summary.food.valid, 1);
        assert.ok(v.json.data.summary.images.missing >= 2);
        await BulkMenuImportJob.deleteOne({ _id: v.json.data.jobId });
    });

    it('rejects invalid ZIPs, missing/nested workbooks', async () => {
        let v = await restaurantValidate(r1Token, Buffer.from('definitely not a zip'));
        assert.equal(v.json.code, 'INVALID_ZIP');

        const noWorkbook = await buildZip({ images: imagesFor(1) });
        v = await restaurantValidate(r1Token, noWorkbook);
        assert.equal(v.json.code, 'MISSING_WORKBOOK');

        const nested = await buildZip({ workbook: await buildWorkbook({ foods: [food(1)] }), workbookName: 'folder/menu.xlsx', images: imagesFor(1) });
        v = await restaurantValidate(r1Token, nested);
        assert.equal(v.json.code, 'MISSING_WORKBOOK');
        assert.match(v.json.message, /root of the ZIP/);

        const notXlsx = await buildZip({ workbook: Buffer.from('not a workbook') });
        v = await restaurantValidate(r1Token, notXlsx);
        assert.equal(v.json.code, 'INVALID_WORKBOOK');

        const notZipName = new FormData();
        notZipName.append('file', new Blob([Buffer.from('x')]), 'menu.xlsx');
        const bad = await call('POST', '/api/v1/food/restaurant/bulk-menu/validate?entity=food', { token: r1Token, form: notZipName });
        assert.equal(bad.status, 400);
    });

    it('rejects path traversal, absolute paths and symlinks and writes nothing outside staging', async () => {
        const workbook = await buildWorkbook({ foods: [food(1)] });
        const sentinel = path.join(os.tmpdir(), 'evil-bulk.txt');
        fs.rmSync(sentinel, { force: true });
        const attempts = [
            [{ name: '../evil-bulk.txt', data: 'x' }],
            [{ name: 'images/../../evil-bulk.txt', data: 'x' }],
            [{ name: '/abs/evil-bulk.txt', data: 'x' }],
            [{ name: 'images/link.webp', data: '/etc/passwd', options: { unixPermissions: 0o120777 } }]
        ];
        for (const extra of attempts) {
            const zip = await buildZip({ workbook, images: imagesFor(1), extra });
            const v = await restaurantValidate(r1Token, zip);
            assert.equal(v.status, 400, `attempt ${extra[0].name}: ${v.text}`);
            assert.equal(v.json.code, 'UNSAFE_ZIP_ENTRY', `attempt ${extra[0].name}`);
        }
        assert.equal(fs.existsSync(sentinel), false);
        assert.equal(fs.existsSync(path.join(os.tmpdir(), 'evil-bulk.txt')), false);
    });

    it('ignores junk entries (__MACOSX, .DS_Store) but still imports', async () => {
        const zip = await buildZip({
            workbook: await buildWorkbook({ foods: [food(91, { name: 'Junk OK' })] }),
            images: imagesFor(1, 91),
            extra: [{ name: '__MACOSX/._menu.xlsx', data: 'x' }, { name: 'images/.DS_Store', data: 'x' }]
        });
        const v = await restaurantValidate(r1Token, zip);
        assert.equal(v.json.data.summary.food.valid, 1);
        await BulkMenuImportJob.deleteOne({ _id: v.json.data.jobId });
    });

    it('cleans the staging directory after import', async () => {
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: [food(92, { name: 'Cleanup' })] }), images: imagesFor(1, 92) });
        const v = await restaurantValidate(r1Token, zip);
        const before = (await BulkMenuImportJob.findById(v.json.data.jobId).lean()).stagingDir;
        assert.ok(fs.existsSync(before));
        await call('POST', `/api/v1/food/restaurant/bulk-menu/imports/${v.json.data.jobId}/start`, { token: r1Token, body: {} });
        await waitForJob(v.json.data.jobId);
        assert.equal(fs.existsSync(before), false);
        assert.equal((await call('POST', `/api/v1/food/restaurant/bulk-menu/imports/${v.json.data.jobId}/start`, { token: r1Token, body: {} })).status, 409);
    });
});

describe('admin food import', () => {
    it('imports 1 food approved, uses the selected restaurant, persists images/slot/otherPrice and bumps productCount once', async () => {
        const before = await FoodRestaurant.findById(RV._id).lean();
        const rows = [food(101, { name: 'Admin Solo', otherPrice: 199, images: 'F101-2.webp', itemSlotTimingId: null })];
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: rows }), images: { 'F101.webp': webp, 'F101-2.webp': webp } });
        const { job } = await runAdminImport(RV._id, zip, 'food', 'skip');
        assert.equal(job.counters.imported, 1);
        const doc = await FoodItem.findOne({ name: 'Admin Solo' }).lean();
        assert.equal(String(doc.restaurantId), String(RV._id));
        assert.equal(doc.approvalStatus, 'approved');
        assert.ok(doc.approvedAt);
        assert.equal(doc.images.length, 2, 'images[] is persisted (single admin createFood would drop it)');
        assert.equal(doc.otherPrice, 199);
        const after = await FoodRestaurant.findById(RV._id).lean();
        assert.equal(after.productCount, (before.productCount || 0) + 1);
        assert.equal(after.isListed, true);
    });

    it('imports 100 foods approved; productCount +100 in one update', async () => {
        const before = (await FoodRestaurant.findById(R2._id).lean()).productCount || 0;
        const rows = Array.from({ length: 100 }, (_, i) => food(300 + i, { name: `Admin Batch ${i}`, categoryName: 'Burger' }));
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: rows }), images: imagesFor(100, 300) });
        const { job } = await runAdminImport(R2._id, zip, 'food', 'skip');
        assert.equal(job.counters.imported, 100);
        const docs = await FoodItem.find({ restaurantId: R2._id, name: /^Admin Batch/ }).lean();
        assert.equal(docs.length, 100);
        assert.ok(docs.every((d) => d.approvalStatus === 'approved'));
        assert.equal((await FoodRestaurant.findById(R2._id).lean()).productCount, before + 100);
    });

    it('admin-imported foods appear on the public menu immediately; pure-veg rule enforced', async () => {
        const menu = await getPublicApprovedRestaurantMenu(String(R2._id));
        const names = menu.sections.flatMap((s) => s.items.map((i) => i.name));
        assert.ok(names.includes('Admin Batch 5'));
        const rows = [food(400, { name: 'PV Non veg', foodType: 'Non-Veg', categoryName: 'Chicken' })];
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: rows }), images: imagesFor(1, 400) });
        const v = await adminValidate(RV._id, zip);
        assert.equal(rowByCode(v.json.data.rows, 'F400').errorCode, 'PURE_VEG_VIOLATION');
        await BulkMenuImportJob.deleteOne({ _id: v.json.data.jobId });
    });

    it('admin flow: restaurant missing -> 404; restaurantId column mismatch flagged', async () => {
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: [food(401, { restaurantId: String(R1._id) })] }), images: imagesFor(1, 401) });
        const missing = await adminValidate(oid(), zip);
        assert.equal(missing.status, 404);
        const v = await adminValidate(R2._id, zip);
        assert.equal(rowByCode(v.json.data.rows, 'F401').errorCode, 'RESTAURANT_MISMATCH');
        await BulkMenuImportJob.deleteOne({ _id: v.json.data.jobId });
    });
});

describe('addon import', () => {
    const addon = (i, over = {}) => ({ addonCode: `A${String(i).padStart(3, '0')}`, name: `Addon ${i}`, description: 'Tasty', price: 10 + i, foodType: 'Veg', image: `A${String(i).padStart(3, '0')}.webp`, ...over });
    const addonImages = (count, start = 1) => Object.fromEntries(Array.from({ length: count }, (_, k) => [`A${String(start + k).padStart(3, '0')}.webp`, webp]));

    it('restaurant addons import as pending drafts, never published; no food link created', async () => {
        const zip = await buildZip({ workbook: await buildWorkbook({ addons: [addon(1, { name: 'Extra Cheese' }), addon(2, { name: 'Extra Sauce', isAvailable: 'FALSE', image: null })] }), images: addonImages(1) });
        const { job } = await runRestaurantImport(r1Token, zip, 'addon', 'skip');
        assert.equal(job.counters.imported, 2);
        const cheese = await FoodAddon.findOne({ restaurantId: R1._id, 'draft.name': 'Extra Cheese' }).lean();
        assert.equal(cheese.approvalStatus, 'pending');
        assert.equal(cheese.published, null);
        assert.match(cheese.draft.image, /^\/uploads\/appzeto\/restaurant\/addons\/.+\.webp$/);
        assert.equal(cheese.draft.price, 11);
        assert.equal(cheese.isAvailable, true);
        const sauce = await FoodAddon.findOne({ restaurantId: R1._id, 'draft.name': 'Extra Sauce' }).lean();
        assert.equal(sauce.isAvailable, false);
        assert.equal(sauce.approvalStatus, 'pending');
        assert.equal(await FoodItem.countDocuments({ name: /Extra/ }), 0, 'add-ons never create food items');
    });

    it('public addon API hides pending, shows approved after existing admin approval', async () => {
        assert.deepEqual(await getPublicApprovedRestaurantAddons(String(R1._id)), []);
        const { approveRestaurantAddon } = await import('../src/modules/food/admin/services/admin.service.js');
        const cheese = await FoodAddon.findOne({ restaurantId: R1._id, 'draft.name': 'Extra Cheese' }).lean();
        await approveRestaurantAddon(cheese._id, null);
        const list = await getPublicApprovedRestaurantAddons(String(R1._id));
        assert.equal(list.length, 1);
        assert.equal(list[0].name, 'Extra Cheese');
    });

    it('admin addons import approved + published; image required; pure-veg enforced', async () => {
        const rows = [addon(11, { name: 'Admin Dip' }), addon(12, { name: 'No image', image: null }), addon(13, { name: 'NV dip', foodType: 'Non-Veg' })];
        const zip = await buildZip({ workbook: await buildWorkbook({ addons: rows }), images: addonImages(3, 11) });
        const v = await adminValidate(RV._id, zip, 'addon');
        const r = v.json.data.rows;
        assert.equal(rowByCode(r, 'A012').errorCode, 'VALIDATION_FAILED');
        assert.match(rowByCode(r, 'A012').errorMessage, /image is required/i);
        assert.equal(rowByCode(r, 'A013').errorCode, 'PURE_VEG_VIOLATION');
        const start = await call('POST', `/api/v1/food/admin/bulk-menu/imports/${v.json.data.jobId}/start`, { token: adminToken, body: {} });
        assert.equal(start.status, 202);
        const job = await waitForJob(v.json.data.jobId);
        assert.equal(job.counters.imported, 1);
        const doc = await FoodAddon.findOne({ restaurantId: RV._id, 'draft.name': 'Admin Dip' }).lean();
        assert.equal(doc.approvalStatus, 'approved');
        assert.equal(doc.published.name, 'Admin Dip');
        assert.match(doc.published.image, /^\/uploads\/appzeto\/admin\/addons\//);
        assert.deepEqual(doc.draft, doc.published);
    });

    it('rejects duplicate add-on names (in file and against existing), case-insensitively', async () => {
        const rows = [addon(21, { name: 'Twin Dip' }), addon(22, { name: 'twin dip' }), addon(23, { name: 'extra cheese' }), addon(24, { price: -1 }), addon(25, { foodType: 'Halal' })];
        const zip = await buildZip({ workbook: await buildWorkbook({ addons: rows }), images: addonImages(5, 21) });
        const v = await restaurantValidate(r1Token, zip, 'addon');
        const r = v.json.data.rows;
        assert.equal(rowByCode(r, 'A021').status, 'pending');
        assert.equal(rowByCode(r, 'A022').errorCode, 'ADDON_DUPLICATE');
        assert.equal(rowByCode(r, 'A023').errorCode, 'ADDON_DUPLICATE');
        assert.equal(rowByCode(r, 'A024').errorCode, 'INVALID_PRICE');
        assert.equal(rowByCode(r, 'A025').errorCode, 'INVALID_FOOD_TYPE');
        await BulkMenuImportJob.deleteOne({ _id: v.json.data.jobId });
    });

    it('food + addon import in one package', async () => {
        const zip = await buildZip({
            workbook: await buildWorkbook({ foods: [food(501, { name: 'Combo Food' })], addons: [addon(31, { name: 'Combo Addon' })] }),
            images: { ...imagesFor(1, 501), ...addonImages(1, 31) }
        });
        const { job, validation } = await runRestaurantImport(r1Token, zip, 'both', 'skip');
        assert.equal(validation.summary.food.valid, 1);
        assert.equal(validation.summary.addon.valid, 1);
        assert.equal(job.counters.imported, 2);
        assert.ok(await FoodItem.findOne({ name: 'Combo Food' }));
        assert.ok(await FoodAddon.findOne({ 'draft.name': 'Combo Addon' }));
    });
});

describe('approval, menu visibility and pricing after import', () => {
    it('restaurant-imported foods are hidden from the public menu until the existing approval runs', async () => {
        const before = await FoodRestaurant.findById(R1._id).lean();
        const pending = await FoodItem.findOne({ restaurantId: R1._id, name: 'Solo Burger' });
        let menu = await getPublicApprovedRestaurantMenu(String(R1._id));
        assert.ok(!menu.sections.flatMap((s) => s.items).some((i) => i.name === 'Solo Burger'));

        const approved = await approveFoodItem(pending._id, null);
        assert.equal(approved.approvalStatus, 'approved');

        menu = await getPublicApprovedRestaurantMenu(String(R1._id));
        const item = menu.sections.flatMap((s) => s.items).find((i) => i.name === 'Solo Burger');
        assert.ok(item, 'visible after approval');
        assert.equal(item.price, 111);
        assert.match(item.image, /^\/uploads\//);
        assert.equal((await FoodRestaurant.findById(R1._id).lean()).productCount, (before.productCount || 0) + 1, 'existing approval owns productCount');
    });

    it('approved imported food satisfies the order-pricing query (approved + available, correct price/variants)', async () => {
        const doc = await FoodItem.findOne({ restaurantId: R1._id, name: 'Solo Burger' }).lean();
        const priced = await FoodItem.find({ _id: { $in: [doc._id] }, approvalStatus: 'approved', isAvailable: true }).select('restaurantId name price variants image images foodType').lean();
        assert.equal(priced.length, 1);
        assert.equal(priced[0].price, 111);
        assert.equal(String(priced[0].restaurantId), String(R1._id));
    });
});


describe('notifications', () => {
    it('bulk import sends ONE admin summary instead of one notification per row; single create still notifies per item', async () => {
        const { createRestaurantFood } = await import('../src/modules/food/restaurant/services/restaurantFood.service.js');

        // notifyAdminsSafely looks up active admins exactly once per notification: count those lookups.
        const originalFind = FoodAdmin.find;
        let notifications = 0;
        FoodAdmin.find = function patched(query, ...rest) {
            if (query && query.isActive === true) notifications += 1;
            return originalFind.call(this, query, ...rest);
        };
        try {
            for (let i = 0; i < 3; i += 1) {
                await createRestaurantFood(String(R1._id), { name: `Single ${i}`, price: 50, foodType: 'Veg', categoryName: 'Burger', image: '/x.webp' });
            }
            const perItem = notifications;

            notifications = 0;
            const rows = Array.from({ length: 30 }, (_, i) => food(700 + i, { name: `Notify Batch ${i}` }));
            const zip = await buildZip({ workbook: await buildWorkbook({ foods: rows }), images: imagesFor(30, 700) });
            await runRestaurantImport(r1Token, zip, 'food', 'skip');
            console.log(`      single x3 -> ${perItem} admin notifications; bulk x30 -> ${notifications}`);
            assert.equal(perItem, 3, 'single-item flow notifies once per item (unchanged)');
            assert.equal(notifications, 1, 'bulk import sends exactly one summary');

            notifications = 0;
            const addonZip = await buildZip({
                workbook: await buildWorkbook({ addons: Array.from({ length: 10 }, (_, i) => ({ addonCode: `N${i}`, name: `Notify Addon ${i}`, price: 5, foodType: 'Veg', image: `N${i}.webp` })) }),
                images: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`N${i}.webp`, webp]))
            });
            await runRestaurantImport(r1Token, addonZip, 'addon', 'skip');
            assert.equal(notifications, 1, 'bulk add-on import also sends exactly one summary');
        } finally {
            FoodAdmin.find = originalFind;
        }
    });
});


describe('existing single-item flows are unchanged by the refactor', () => {
    it('restaurant createRestaurantFood: pending, notifies, validates category', async () => {
        const { createRestaurantFood } = await import('../src/modules/food/restaurant/services/restaurantFood.service.js');
        const doc = await createRestaurantFood(String(R1._id), { name: 'Legacy Single', price: 80, foodType: 'Veg', categoryName: 'Burger', image: '/i.webp', images: ['/i.webp', '/j.webp'], itemSlotTimingId: String(SLOT._id) });
        assert.equal(doc.approvalStatus, 'pending');
        assert.ok(doc.requestedAt);
        assert.equal(doc.images.length, 2);
        assert.equal(String(doc.itemSlotTimingId), String(SLOT._id));
        await assert.rejects(() => createRestaurantFood(String(R1._id), { name: 'X', price: 1, foodType: 'Veg', categoryName: 'PendingCat' }), /Category not found/);
        await assert.rejects(() => createRestaurantFood(String(R1._id), { name: '', price: 1 }), /Item name is required/);
    });

    it('restaurant createRestaurantAddon: pending + duplicate rule + notifies once', async () => {
        const { createRestaurantAddon } = await import('../src/modules/food/restaurant/services/restaurantAddon.service.js');
        const originalFind = FoodAdmin.find;
        let notifications = 0;
        FoodAdmin.find = function patched(query, ...rest) { if (query && query.isActive === true) notifications += 1; return originalFind.call(this, query, ...rest); };
        try {
            const a = await createRestaurantAddon(String(R1._id), { name: 'Legacy Addon', price: 5, foodType: 'Veg', image: '', images: [], description: '' });
            assert.equal(a.approvalStatus, 'pending');
            await assert.rejects(() => createRestaurantAddon(String(R1._id), { name: 'legacy addon', price: 5 }), /already exists/);
            await new Promise((r) => setTimeout(r, 150));
            assert.equal(notifications, 1);
        } finally {
            FoodAdmin.find = originalFind;
        }
    });

    it('admin createFood / createRestaurantAddonAdmin: approved, productCount bump intact', async () => {
        const adminService = await import('../src/modules/food/admin/services/admin.service.js');
        const before = (await FoodRestaurant.findById(R2._id).lean()).productCount;
        const f = await adminService.createFood({ restaurantId: String(R2._id), name: 'Legacy Admin Food', price: 60, foodType: 'Veg', categoryId: String(CAT.burger._id), image: '/a.webp' });
        assert.equal(f.approvalStatus, 'approved');
        assert.equal((await FoodRestaurant.findById(R2._id).lean()).productCount, before + 1);
        const a = await adminService.createRestaurantAddonAdmin({ restaurantId: String(R2._id), name: 'Legacy Admin Addon', price: 9, foodType: 'Veg', image: '/a.webp' }, null);
        assert.equal(a.approvalStatus, 'approved');
        assert.deepEqual(a.draft, a.published);
        await assert.rejects(() => adminService.createRestaurantAddonAdmin({ restaurantId: String(R2._id), name: 'legacy admin addon', price: 9, foodType: 'Veg', image: '/a.webp' }, null), /already exists/);
    });

    it('restaurant edits still resubmit for approval', async () => {
        const { updateRestaurantFood } = await import('../src/modules/food/restaurant/services/restaurantFood.service.js');
        const target = await FoodItem.findOne({ name: 'Solo Burger', restaurantId: R1._id });
        const updated = await updateRestaurantFood(String(R1._id), String(target._id), { description: 'changed' });
        assert.equal(updated.approvalStatus, 'pending');
    });
});


describe('downloadable ZIP packages', () => {
    const fetchZip = async (url, token) => {
        const res = await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /zip/);
        return Buffer.from(await res.arrayBuffer());
    };

    it('blank package has menu.xlsx at the root and an images/ folder, and is a valid (empty) package', async () => {
        const buf = await fetchZip('/api/v1/food/restaurant/bulk-menu/template?entity=both&format=zip', r1Token);
        const zip = await JSZip.loadAsync(buf);
        assert.ok(zip.file('menu.xlsx'));
        assert.ok(zip.file('images/PUT-IMAGES-HERE.txt'));
        const v = await restaurantValidate(r1Token, buf, 'both');
        assert.equal(v.json.code, 'EMPTY_SHEET', 'blank package has headers only');
    });

    it('restaurant sample package validates and imports as-is (pending)', async () => {
        const buf = await fetchZip('/api/v1/food/restaurant/bulk-menu/template?entity=both&format=zip&sample=1', r1Token);
        const { validation, job } = await runRestaurantImport(r1Token, buf, 'both', 'skip');
        assert.equal(validation.summary.food.invalid, 0, JSON.stringify(validation.rows));
        assert.equal(validation.summary.addon.invalid, 0, JSON.stringify(validation.rows));
        assert.equal(job.counters.imported, 4);
        assert.equal((await FoodItem.findOne({ name: /^Sample Item 1/, restaurantId: R1._id }).lean()).approvalStatus, 'pending');
    });

    it('default template is simple; full=1 adds the advanced columns; both import cleanly', async () => {
        const read = async (q) => {
            const zip = await JSZip.loadAsync(await fetchZip('/api/v1/food/restaurant/bulk-menu/template?entity=food&format=zip&sample=1' + q, r1Token));
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(await zip.file('menu.xlsx').async('nodebuffer'));
            return wb.getWorksheet('Foods').getRow(1).values.filter(Boolean);
        };
        const simple = await read('');
        const full = await read('&full=1');
        assert.deepEqual(simple, ['itemCode', 'name', 'description', 'categoryName', 'price', 'foodType', 'image']);
        assert.ok(full.includes('variants') && full.includes('categoryId') && full.length > simple.length);
    });

    it('admin sample package (selected restaurant) imports approved; restaurantId param only picks the sample category', async () => {
        const buf = await fetchZip(`/api/v1/food/admin/bulk-menu/template?entity=food&format=zip&sample=1&restaurantId=${R2._id}`, adminToken);
        const { validation, job } = await runAdminImport(R2._id, buf, 'food', 'skip');
        assert.equal(validation.summary.food.valid, 2);
        assert.equal(job.counters.imported, 2);
        assert.equal((await FoodItem.findOne({ name: /^Sample Item 2/, restaurantId: R2._id }).lean()).approvalStatus, 'approved');
    });
});

describe('job status & templates', () => {
    it('status endpoint reports progress/counters and rows once terminal', async () => {
        const zip = await buildZip({ workbook: await buildWorkbook({ foods: [food(601, { name: 'Status A' }), food(602, { name: 'Status B', price: 'x' })] }), images: imagesFor(2, 601) });
        const { validation } = await runRestaurantImport(r1Token, zip, 'food', 'skip');
        const res = await call('GET', `/api/v1/food/restaurant/bulk-menu/imports/${validation.jobId}`, { token: r1Token });
        assert.equal(res.status, 200);
        const d = res.json.data;
        assert.equal(d.status, 'completed');
        assert.deepEqual(d.counters, { imported: 1, skipped: 0, failed: 0 });
        assert.equal(d.validation.food.invalid, 1);
        assert.equal(d.rows.length, 2);
    });

    it('downloads food, addon and combined templates that our own parser accepts', async () => {
        for (const [entity, url] of [['food', '/api/v1/food/restaurant/bulk-menu/template?entity=food'], ['addon', '/api/v1/food/restaurant/bulk-menu/template?entity=addon'], ['both', '/api/v1/food/admin/bulk-menu/template?entity=both']]) {
            const token = url.includes('/admin/') ? adminToken : r1Token;
            const res = await fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${token}` } });
            assert.equal(res.status, 200, entity);
            assert.match(res.headers.get('content-disposition'), /template\.xlsx/);
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
            const names = wb.worksheets.map((w) => w.name);
            assert.ok(names.includes('README'));
            if (entity !== 'addon') assert.ok(names.includes('Foods'));
            if (entity !== 'food') assert.ok(names.includes('Addons'));
        }
    });
});
