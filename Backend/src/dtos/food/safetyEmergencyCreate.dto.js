import { z } from 'zod';
import { ValidationError } from '../../core/auth/errors.js';

const schema = z.object({
    message: z.string().min(10, 'Message must be at least 10 characters').max(4000, 'Message too long'),
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional()
});

export const validateSafetyEmergencyCreateDto = (body) => {
    const rawLat = Number(body?.latitude);
    const rawLng = Number(body?.longitude);
    const result = schema.safeParse({
        message: String(body?.message || '').trim(),
        latitude: Number.isFinite(rawLat) ? rawLat : null,
        longitude: Number.isFinite(rawLng) ? rawLng : null
    });
    if (!result.success) {
        throw new ValidationError(result.error.errors[0].message);
    }
    return result.data;
};

