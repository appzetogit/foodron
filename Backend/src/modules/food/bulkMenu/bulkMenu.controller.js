import fs from 'fs';
import fsp from 'fs/promises';
import mongoose from 'mongoose';
import multer from 'multer';
import path from 'path';
import { checkPermission } from '../../../core/auth/auth.middleware.js';
import { resolveActionPerformerSnapshot } from '../../../core/utils/performer.js';
import { addBulkMenuImportJob } from '../../../queues/producers/bulkMenuImport.producer.js';
import { logger } from '../../../utils/logger.js';
import { sendError, sendResponse } from '../../../utils/response.js';
import { runBulkMenuImportJob } from './bulkMenuImport.service.js';
import { STAGING_ROOT, validateBulkPackage } from './bulkMenuValidation.service.js';
import {
    BULK_ENTITIES,
    BULK_ENTITY,
    BulkImportError,
    DUPLICATE_MODE,
    ERROR,
    LIMITS
} from './constants.js';
import { BulkMenuImportJob } from './models/bulkMenuImportJob.model.js';
import { buildTemplateBuffer, buildTemplatePackage } from './template.service.js';

const UPLOAD_TMP = path.join(STAGING_ROOT, 'uploads');

const zipUpload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => fs.mkdir(UPLOAD_TMP, { recursive: true }, (err) => cb(err, UPLOAD_TMP)),
        filename: (_req, _file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.zip`)
    }),
    limits: { fileSize: LIMITS.maxZipBytes, files: 1 },
    fileFilter: (_req, file, cb) => {
        if (!/\.zip$/i.test(file.originalname || '')) {
            return cb(new BulkImportError(ERROR.INVALID_ZIP, 'Upload a .zip package (menu.xlsx + images/).'));
        }
        return cb(null, true);
    }
}).single('file');

/** multer wrapper that turns upload errors into clean 4xx responses. */
export const bulkMenuZipUpload = (req, res, next) => {
    zipUpload(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
            return sendError(res, 413, `ZIP is too large (max ${Math.round(LIMITS.maxZipBytes / 1024 / 1024)}MB).`);
        }
        if (err instanceof BulkImportError) return sendError(res, err.statusCode, err.message);
        return sendError(res, 400, err.message || 'Failed to upload the ZIP.');
    });
};

const parseEntity = (raw) => {
    const entity = String(raw || '').trim().toLowerCase();
    if (!BULK_ENTITIES.includes(entity)) {
        throw new BulkImportError(ERROR.INVALID_ENTITY, 'entity must be one of: food, addon, both.');
    }
    return entity;
};

// Same envelope as sendError plus a machine-readable `code` the UI can key on.
const sendBulkError = (res, err) =>
    res.status(err.statusCode).json({ success: false, message: err.message, code: err.code });

const isAdminRequest = (req) => req.user?.role === 'ADMIN' || req.user?.role === 'EMPLOYEE';

// ---------------------------------------------------------------------------------------------
// RBAC for the admin routes: checkPermission takes a static key, so the food and/or add-on key
// is picked from the entity (query string for template/validate; the stored job for start/status).
// ---------------------------------------------------------------------------------------------
const PERMISSION_KEYS = {
    food: ['food::food_management::foods::list'],
    addon: ['food::food_management::foods::addons']
};

const keysForEntity = (entity) => [
    ...(entity !== BULK_ENTITY.ADDON ? PERMISSION_KEYS.food : []),
    ...(entity !== BULK_ENTITY.FOOD ? PERMISSION_KEYS.addon : [])
];

const runChain = (middlewares, req, res, next) => {
    let i = 0;
    const step = (err) => {
        if (err) return next(err);
        if (i >= middlewares.length) return next();
        return middlewares[i++](req, res, step);
    };
    step();
};

export const bulkMenuPermission = (source, action) => async (req, res, next) => {
    try {
        let entity;
        if (source === 'query') {
            entity = parseEntity(req.query?.entity);
        } else {
            if (!mongoose.Types.ObjectId.isValid(req.params.jobId)) return sendError(res, 404, 'Import not found');
            const job = await BulkMenuImportJob.findById(req.params.jobId).select('entity').lean();
            if (!job) return sendError(res, 404, 'Import not found');
            entity = job.entity;
        }
        return runChain(keysForEntity(entity).map((key) => checkPermission(key, action)), req, res, next);
    } catch (err) {
        if (err instanceof BulkImportError) return sendBulkError(res, err);
        return next(err);
    }
};

// ---------------------------------------------------------------------------------------------

const compactRow = (r) => ({
    entityType: r.entityType,
    rowNumber: r.rowNumber,
    code: r.code,
    name: r.name,
    status: r.status,
    errorCode: r.errorCode || '',
    errorMessage: r.errorMessage || '',
    warnings: r.warnings || [],
    duplicate: r.duplicate || '',
    entityId: r.entityId ? String(r.entityId) : undefined
});

const resolveScope = (req) => {
    if (isAdminRequest(req)) {
        const restaurantId = req.params.restaurantId;
        if (!mongoose.Types.ObjectId.isValid(restaurantId)) {
            throw new BulkImportError(ERROR.RESTAURANT_NOT_FOUND, 'Select a valid restaurant.', 400);
        }
        return { ownerType: 'ADMIN', restaurantId: new mongoose.Types.ObjectId(restaurantId), createdBy: req.user.userId };
    }
    // Restaurant: the id ALWAYS comes from the authenticated token, never from the request body/file.
    return { ownerType: 'RESTAURANT', restaurantId: new mongoose.Types.ObjectId(String(req.user.userId)), createdBy: req.user.userId };
};

const loadAccessibleJob = async (req) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.jobId)) return null;
    const job = await BulkMenuImportJob.findById(req.params.jobId);
    if (!job) return null;
    if (isAdminRequest(req)) {
        if (job.ownerType !== 'ADMIN') return null;
        if (req.user.role !== 'ADMIN' && String(job.createdBy) !== String(req.user.userId)) return null;
        return job;
    }
    if (job.ownerType !== 'RESTAURANT' || String(job.restaurantId) !== String(req.user.userId)) return null;
    return job;
};

const handleError = (res, next, err) => {
    if (err instanceof BulkImportError) return sendBulkError(res, err);
    return next(err);
};

export const downloadBulkTemplate = async (req, res, next) => {
    try {
        const entity = parseEntity(req.query?.entity);
        const isAdmin = isAdminRequest(req);
        const format = String(req.query?.format || 'xlsx').toLowerCase();
        const full = req.query?.full === '1' || req.query?.full === 'true';

        if (format === 'zip') {
            // Restaurant: always the authenticated restaurant. Admin: the selected one (only used to pick a real sample category).
            const rawId = isAdmin ? req.query?.restaurantId : req.user?.userId;
            const restaurantId = rawId && mongoose.Types.ObjectId.isValid(String(rawId)) ? String(rawId) : null;
            const sample = req.query?.sample === '1' || req.query?.sample === 'true';
            const buffer = await buildTemplatePackage(entity, { isAdmin, restaurantId, sample, full });
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="fudron-menu-import${sample ? '-sample' : ''}.zip"`);
            return res.send(buffer);
        }

        const buffer = await buildTemplateBuffer(entity, { isAdmin, full });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="fudron-menu-${entity}-template.xlsx"`);
        return res.send(Buffer.from(buffer));
    } catch (err) {
        return handleError(res, next, err);
    }
};

export const validateBulkMenu = async (req, res, next) => {
    const zipPath = req.file?.path;
    try {
        const entity = parseEntity(req.query?.entity);
        if (!zipPath) throw new BulkImportError(ERROR.NO_FILE, 'Attach the ZIP package in the "file" field.');
        const scope = resolveScope(req);

        const { job, summary, rowResults } = await validateBulkPackage({
            zipPath,
            fileName: req.file.originalname,
            entity,
            scope
        });

        return sendResponse(res, 200, 'Package validated', {
            jobId: String(job._id),
            jobCode: job.jobCode,
            entity,
            restaurantId: String(scope.restaurantId),
            summary,
            rows: rowResults.map(compactRow)
        });
    } catch (err) {
        return handleError(res, next, err);
    } finally {
        // The uploaded ZIP is never kept; extracted files live in the job's staging dir only.
        if (zipPath) await fsp.rm(zipPath, { force: true }).catch(() => {});
    }
};

export const startBulkMenuImport = async (req, res, next) => {
    try {
        const job = await loadAccessibleJob(req);
        if (!job) return sendError(res, 404, 'Import not found');

        const duplicateMode = req.body?.duplicateMode || DUPLICATE_MODE.SKIP;
        if (!Object.values(DUPLICATE_MODE).includes(duplicateMode)) {
            return sendError(res, 400, 'duplicateMode must be "skip" or "createAnyway".');
        }
        if (job.status !== 'validated') return sendError(res, 409, 'This import was already started.');
        if (!fs.existsSync(path.join(job.stagingDir || '', 'parsed.json'))) {
            return sendError(res, 410, 'The validated package expired. Upload and validate it again.');
        }
        const importable = (job.progress?.food?.total || 0) + (job.progress?.addon?.total || 0);
        if (importable === 0) return sendError(res, 400, 'There are no valid rows to import.');

        const performer = isAdminRequest(req) ? await resolveActionPerformerSnapshot(req.user) : null;
        const claimed = await BulkMenuImportJob.findOneAndUpdate(
            { _id: job._id, status: 'validated' },
            { $set: { status: 'queued', duplicateMode, performer } },
            { new: true }
        );
        if (!claimed) return sendError(res, 409, 'This import was already started.');

        const queued = await addBulkMenuImportJob(claimed._id);
        if (!queued) {
            // BullMQ/Redis not enabled: run the same runner in this process, off the request.
            setImmediate(() => {
                runBulkMenuImportJob(claimed._id).catch((err) => logger.error(`[bulk-menu] inline run failed: ${err.message}`));
            });
        }

        return sendResponse(res, 202, 'Import started', {
            jobId: String(claimed._id),
            jobCode: claimed.jobCode,
            status: claimed.status,
            executor: queued ? 'queue' : 'inline'
        });
    } catch (err) {
        return handleError(res, next, err);
    }
};

export const getBulkMenuImportStatus = async (req, res, next) => {
    try {
        const job = await loadAccessibleJob(req);
        if (!job) return sendError(res, 404, 'Import not found');

        const terminal = ['completed', 'failed'].includes(job.status);
        const includeRows = terminal || req.query?.includeRows === '1';
        return sendResponse(res, 200, 'Import status fetched', {
            jobId: String(job._id),
            jobCode: job.jobCode,
            entity: job.entity,
            status: job.status,
            progress: job.progress,
            counters: job.counters,
            validation: job.validation,
            error: job.error,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            ...(includeRows ? { rows: job.rowResults.map(compactRow) } : {})
        });
    } catch (err) {
        return handleError(res, next, err);
    }
};

