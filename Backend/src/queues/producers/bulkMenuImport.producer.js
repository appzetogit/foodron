import { getBulkMenuImportQueue } from '../index.js';
import { logger } from '../../utils/logger.js';

/**
 * Queue a validated bulk menu import for the BullMQ worker.
 * Returns true when queued; false when BullMQ/Redis is unavailable so the caller can run the
 * same runner in-process instead. attempts=1: rows are individually resumable, but a blind
 * whole-job retry could re-upload images, so the worker never auto-retries.
 */
export const addBulkMenuImportJob = async (jobId) => {
    const queue = getBulkMenuImportQueue();
    if (!queue) return false;
    try {
        await queue.add('bulk-menu-import', { jobId: String(jobId) }, { jobId: `bulk-menu-${jobId}`, attempts: 1 });
        return true;
    } catch (err) {
        logger.error(`Failed to queue bulk menu import ${jobId}: ${err.message}`);
        return false;
    }
};
