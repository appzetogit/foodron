import mongoose from 'mongoose';

/**
 * Bookkeeping for one bulk menu import (validate -> confirm -> import).
 * Not a Food/Addon model: it only tracks the import run and its per-row outcome.
 * Parsed rows live on disk in `stagingDir`; this document carries status, counters
 * and the compact per-row results shown in the UI / error report.
 */
const rowResultSchema = new mongoose.Schema(
    {
        entityType: { type: String, enum: ['food', 'addon'], required: true },
        rowNumber: { type: Number, required: true },
        code: { type: String, default: '' },
        name: { type: String, default: '' },
        // invalid: rejected by validation, never imported.
        status: {
            type: String,
            enum: ['invalid', 'pending', 'processing', 'success', 'failed', 'skipped'],
            required: true
        },
        errorCode: { type: String, default: '' },
        errorMessage: { type: String, default: '' },
        warnings: { type: [String], default: [] },
        duplicate: { type: String, enum: ['', 'existing', 'in_file'], default: '' },
        entityId: { type: mongoose.Schema.Types.ObjectId, default: undefined }
    },
    { _id: false }
);

const bulkMenuImportJobSchema = new mongoose.Schema(
    {
        jobCode: { type: String, required: true, unique: true },
        ownerType: { type: String, enum: ['ADMIN', 'RESTAURANT'], required: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
        restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodRestaurant', required: true, index: true },
        entity: { type: String, enum: ['food', 'addon', 'both'], required: true },
        status: {
            type: String,
            enum: ['validated', 'queued', 'processing', 'completed', 'failed'],
            default: 'validated',
            index: true
        },
        fileName: { type: String, default: '' },
        stagingDir: { type: String, default: '' },
        duplicateMode: { type: String, enum: ['skip', 'createAnyway'], default: 'skip' },
        performer: { type: mongoose.Schema.Types.Mixed, default: null },
        validation: { type: mongoose.Schema.Types.Mixed, default: {} },
        progress: {
            food: { total: { type: Number, default: 0 }, done: { type: Number, default: 0 } },
            addon: { total: { type: Number, default: 0 }, done: { type: Number, default: 0 } }
        },
        counters: {
            imported: { type: Number, default: 0 },
            skipped: { type: Number, default: 0 },
            failed: { type: Number, default: 0 }
        },
        rowResults: { type: [rowResultSchema], default: [] },
        error: { type: String, default: '' },
        startedAt: { type: Date },
        finishedAt: { type: Date },
        // Housekeeping: jobs are only a short-lived audit trail.
        expireAt: { type: Date, default: () => new Date(Date.now() + 30 * 24 * 3600 * 1000) }
    },
    { collection: 'food_bulk_menu_imports', timestamps: true }
);

bulkMenuImportJobSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const BulkMenuImportJob = mongoose.model(
    'BulkMenuImportJob',
    bulkMenuImportJobSchema,
    'food_bulk_menu_imports'
);
