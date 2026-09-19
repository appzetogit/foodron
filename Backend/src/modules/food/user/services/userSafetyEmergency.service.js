import mongoose from 'mongoose';
import { ValidationError } from '../../../../core/auth/errors.js';
import { FoodUser } from '../../../../core/users/user.model.js';
import { FoodSafetyEmergencyReport } from '../../admin/models/safetyEmergencyReport.model.js';
import { reverseGeocodeCoordinates } from '../../../common/controllers/maps.controller.js';

export const createSafetyEmergencyReport = async (userId, message, location = {}) => {
    const id = String(userId || '');
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        throw new ValidationError('User not found');
    }
    const user = await FoodUser.findById(id).select('name email phone').lean();
    if (!user) {
        throw new ValidationError('User not found');
    }

    const latitude = Number.isFinite(location?.latitude) ? location.latitude : null;
    const longitude = Number.isFinite(location?.longitude) ? location.longitude : null;

    // One-time reverse geocode at creation so the admin panel can show a readable
    // address without loading the Maps JS API on every report view.
    const geocoded = latitude !== null && longitude !== null
        ? await reverseGeocodeCoordinates(latitude, longitude)
        : null;

    const created = await FoodSafetyEmergencyReport.create({
        userId: new mongoose.Types.ObjectId(id),
        userName: user.name || '',
        userEmail: user.email || '',
        userPhone: user.phone || '',
        message: String(message || '').trim(),
        latitude,
        longitude,
        address: geocoded?.formattedAddress || '',
        status: 'unread',
        priority: 'medium'
    });

    return { report: created.toObject() };
};

export const listMySafetyEmergencyReports = async (userId, query = {}) => {
    const id = String(userId || '');
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
        throw new ValidationError('User not found');
    }
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const filter = { userId: new mongoose.Types.ObjectId(id) };
    const [list, total] = await Promise.all([
        FoodSafetyEmergencyReport.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        FoodSafetyEmergencyReport.countDocuments(filter)
    ]);

    return {
        safetyEmergencies: list || [],
        pagination: { page, limit, total, pages: Math.ceil(total / limit) || 1 }
    };
};

