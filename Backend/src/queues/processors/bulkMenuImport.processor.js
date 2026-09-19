import { logger } from '../../utils/logger.js';
import { runBulkMenuImportJob } from '../../modules/food/bulkMenu/bulkMenuImport.service.js';

/** @param {import('bullmq').Job} job */
export const processBulkMenuImportJob = async (job) => {
    const { jobId } = job?.data || {};
    logger.info(`[BullMQ:bulk-menu-import] jobId=${job.id} importId=${jobId}`);
    if (!jobId) return;
    await runBulkMenuImportJob(jobId);
};
