/**
 * Centralized queue names for BullMQ.
 * Used by producers, workers, and queue initialization.
 */
export const OTP_QUEUE = 'otp';
export const NOTIFICATION_QUEUE = 'notification';
export const ORDER_QUEUE = 'order';
export const PAYMENT_QUEUE = 'payment';
export const TRACKING_QUEUE = 'tracking';
export const SUBSCRIPTION_QUEUE = 'subscription';
export const BULK_MENU_IMPORT_QUEUE = 'bulk-menu-import';

export const QUEUE_NAMES = Object.freeze([
    OTP_QUEUE,
    NOTIFICATION_QUEUE,
    ORDER_QUEUE,
    PAYMENT_QUEUE,
    TRACKING_QUEUE,
    SUBSCRIPTION_QUEUE,
    BULK_MENU_IMPORT_QUEUE
]);
