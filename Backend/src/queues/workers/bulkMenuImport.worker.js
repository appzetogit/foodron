import 'dotenv/config';
import { Worker } from 'bullmq';
import { config } from '../../config/env.js';
import { connectDB, disconnectDB } from '../../config/db.js';
import { logger } from '../../utils/logger.js';
import { getBullMQConnection } from '../connection.js';
import { BULK_MENU_IMPORT_QUEUE } from '../queue.constants.js';
import { processBulkMenuImportJob } from '../processors/bulkMenuImport.processor.js';

// NOTE: the worker reads the staged ZIP contents from the local temp directory, so it must run
// on the same machine (or share the OS temp dir) as the API process that validated the package.
const startBulkMenuImportWorker = () => {
    if (!config.bullmqEnabled) {
        logger.info('BullMQ is disabled. Bulk menu import worker not started.');
        return null;
    }
    const connection = getBullMQConnection();
    if (!connection) {
        logger.error('Bulk menu import worker: Redis connection unavailable. Exiting.');
        process.exit(1);
    }
    const worker = new Worker(BULK_MENU_IMPORT_QUEUE, processBulkMenuImportJob, {
        connection,
        concurrency: 1
    });
    worker.on('completed', (job) => logger.info(`Bulk menu import job ${job.id} completed`));
    worker.on('failed', (job, err) => logger.error(`Bulk menu import job ${job?.id} failed: ${err.message}`));
    worker.on('error', (err) => logger.error(`Bulk menu import worker error: ${err.message}`));
    logger.info('Bulk menu import worker started (Mongo connected)');
    return worker;
};

const bootstrap = async () => {
    try {
        await connectDB();
        const worker = startBulkMenuImportWorker();
        if (!worker) {
            process.exit(0);
            return;
        }
        const shutdown = async () => {
            await worker.close();
            await disconnectDB().catch(() => {});
            process.exit(0);
        };
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    } catch (err) {
        logger.error(`Bulk menu import worker bootstrap failed: ${err?.message || err}`);
        process.exit(1);
    }
};

bootstrap();
