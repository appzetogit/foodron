/**
 * Redis / BullMQ integration for the bulk menu import: batched cache invalidation and the real
 * queue -> worker path. Needs a throwaway MongoDB AND a Redis database you do not mind flushing:
 *   BULK_TEST_MONGODB_URI=mongodb://127.0.0.1:27017/cravioo_bulk_test \
 *   BULK_TEST_REDIS_URL=redis://127.0.0.1:6379/15 node --test tests/bulkMenu.redis.test.mjs
 * Refuses Atlas Mongo URIs and any Redis URL without an explicit non-zero database index.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const MONGO = process.env.BULK_TEST_MONGODB_URI || '';
const REDIS = process.env.BULK_TEST_REDIS_URL || '';
if (!MONGO || /mongodb\.net/i.test(MONGO)) throw new Error('Set BULK_TEST_MONGODB_URI to a throwaway MongoDB.');
if (!/\/\d+$/.test(REDIS) || /\/0$/.test(REDIS)) throw new Error('Set BULK_TEST_REDIS_URL with an explicit non-zero db, e.g. redis://127.0.0.1:6379/15');

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cravioo-bulk-redis-uploads-'));
Object.assign(process.env, {
    UPLOAD_PATH: UPLOAD_DIR,
    REDIS_ENABLED: 'true',
    REDIS_URL: REDIS,
    BULLMQ_ENABLED: 'true',
    MONGODB_URI: MONGO,
    MONGO_URI: MONGO,
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET || 'bulk-test-secret',
    JWT_SECRET: process.env.JWT_SECRET || 'bulk-test-secret'
});

const { default: mongoose } = await import('mongoose');
const { default: express } = await import('express');
const { default: ExcelJS } = await import('exceljs');
const { default: JSZip } = await import('jszip');
const { default: sharp } = await import('sharp');
const { connectRedis, getRedisClient } = await import('../src/config/redis.js');
const { closeBullMQConnection, initializeQueues } = await import('../src/queues/index.js');
const { FoodItem } = await import('../src/modules/food/admin/models/food.model.js');
const { FoodCategory } = await import('../src/modules/food/admin/models/category.model.js');
const { FoodRestaurant } = await import('../src/modules/food/restaurant/models/restaurant.model.js');
const { BulkMenuImportJob } = await import('../src/modules/food/bulkMenu/models/bulkMenuImportJob.model.js');
const { runBulkMenuImportJob } = await import('../src/modules/food/bulkMenu/bulkMenuImport.service.js');
const { approveFoodItemController } = await import('../src/modules/food/admin/controllers/foodApproval.controller.js');
const { signAccessToken } = await import('../src/core/auth/token.util.js');
const restaurantRoutes = (await import('../src/modules/food/restaurant/routes/restaurant.routes.js')).default;

const webp = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#00aa55' } }).webp().toBuffer();
let R;
let token;
let server;
let base;
let worker;
let redis;

const zipFor = async (names) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Foods');
    ws.addRow(['itemCode', 'name', 'categoryName', 'price', 'foodType', 'image']);
    names.forEach((n, i) => ws.addRow([`C${i}`, n, 'Burger', 99, 'Veg', `C${i}.webp`]));
    const zip = new JSZip();
    zip.file('menu.xlsx', Buffer.from(await wb.xlsx.writeBuffer()));
    names.forEach((_, i) => zip.file(`images/C${i}.webp`, webp));
    return zip.generateAsync({ type: 'nodebuffer' });
};
const post = (url, form) => fetch(`${base}${url}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
const validate = async (names) => {
    const form = new FormData();
    form.append('file', new Blob([await zipFor(names)]), 'p.zip');
    const res = await post('/api/v1/food/restaurant/bulk-menu/validate?entity=food', form);
    assert.equal(res.status, 200);
    return (await res.json()).data;
};
const waitFor = async (jobId, ms = 60000) => {
    const t0 = Date.now();
    for (;;) {
        const job = await BulkMenuImportJob.findById(jobId).lean();
        if (job && ['completed', 'failed'].includes(job.status)) return job;
        if (Date.now() - t0 > ms) throw new Error(`timeout in status ${job?.status}`);
        await new Promise((r) => setTimeout(r, 150));
    }
};

before(async () => {
    await mongoose.connect(MONGO, { autoIndex: false });
    await mongoose.connection.dropDatabase();
    await connectRedis();
    redis = getRedisClient();
    await redis.flushDb(); // only the explicitly provided throwaway db index
    initializeQueues();

    R = await FoodRestaurant.create({ restaurantName: 'Queue Kitchen', ownerName: 'O', pureVegRestaurant: false, status: 'approved', isActive: true, isListed: true });
    await FoodCategory.create({ name: 'Burger', image: '/x.webp', foodTypeScope: 'Veg', approvalStatus: 'approved', isApproved: true, isActive: true });
    token = signAccessToken({ userId: String(R._id), role: 'RESTAURANT' });

    const app = express();
    app.use(express.json());
    app.use('/api/v1/food/restaurant', restaurantRoutes);
    server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    worker?.kill();
    await new Promise((resolve) => server?.close(resolve));
    await redis?.flushDb();
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    await closeBullMQConnection().catch(() => {});
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
    setTimeout(() => process.exit(0), 300).unref();
});

describe('cache invalidation', () => {
    const seed = async () => {
        const keys = ['restaurant_menu:GET:/m', 'restaurant_menus_batch:GET:/b', 'categories:GET:/c', 'restaurants:GET:/r', 'restaurant_detail:GET:/d', 'food_search:GET:/s', 'restaurant_addons:GET:/a', 'unrelated:GET:/keep'];
        for (const key of keys) await redis.set(key, '1');
    };

    it('a food import clears only the menu/category/restaurant/search caches, once at the end', async () => {
        await seed();
        const data = await validate(['Cache A', 'Cache B']);
        await BulkMenuImportJob.updateOne({ _id: data.jobId }, { $set: { status: 'queued' } });
        await runBulkMenuImportJob(data.jobId); // run the runner directly (no worker needed)
        const left = (await redis.keys('*')).filter((k) => !k.startsWith('bull:'));
        assert.deepEqual(left.sort(), ['restaurant_addons:GET:/a', 'unrelated:GET:/keep'].sort());
    });

    it('food approval now also clears restaurant_menu / batch caches', async () => {
        await seed();
        const item = await FoodItem.findOne({ name: 'Cache A' });
        const res = { statusCode: 0, status(c) { this.statusCode = c; return this; }, json() { return this; } };
        await approveFoodItemController({ params: { id: String(item._id) }, user: { userId: String(new mongoose.Types.ObjectId()), role: 'ADMIN' } }, res, (e) => { throw e; });
        assert.equal(res.statusCode, 200);
        const left = await redis.keys('*');
        assert.ok(!left.includes('restaurant_menu:GET:/m'));
        assert.ok(!left.includes('restaurant_menus_batch:GET:/b'));
        assert.ok(left.includes('unrelated:GET:/keep'));
    });
});

describe('BullMQ queue -> worker', () => {
    it('start enqueues; the separate worker process imports the rows and reports progress', async () => {
        worker = spawn(process.execPath, ['src/queues/workers/bulkMenuImport.worker.js'], {
            cwd: path.resolve(import.meta.dirname, '..'),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let workerLog = '';
        worker.stdout.on('data', (d) => { workerLog += d; });
        worker.stderr.on('data', (d) => { workerLog += d; });
        await new Promise((resolve) => setTimeout(resolve, 4000)); // let it connect

        const data = await validate(Array.from({ length: 40 }, (_, i) => `Queued ${i}`));
        const start = await (await post(`/api/v1/food/restaurant/bulk-menu/imports/${data.jobId}/start`, undefined)).json();
        assert.equal(start.data.executor, 'queue', 'BullMQ path used, not the inline fallback');

        let job;
        try {
            job = await waitFor(data.jobId, 30000);
        } catch (err) {
            assert.fail(`${err.message}
--- worker output ---
${workerLog}`);
        }
        assert.equal(job.status, 'completed', workerLog);
        assert.equal(job.counters.imported, 40);
        assert.equal(await FoodItem.countDocuments({ name: /^Queued / }), 40);
    });
});
