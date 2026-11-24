import mongoose from 'mongoose';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    coordinatesToGeoJSONPolygon,
    computePolygonAreaKm2,
    findOverlappingZone,
} from '../../../../utils/zoneOverlap.js';

/**
 * A Service Area is a named sub-polygon drawn inside a Zone, purely for data filtering/
 * reporting (which part of a zone a restaurant/driver/order belongs to). It changes
 * NOTHING about the existing zone-based operational flow (dispatch, order routing,
 * restaurant/driver assignment all stay zone-based, unchanged).
 */
const coordinateSchema = new mongoose.Schema(
    {
        latitude: { type: Number, required: true },
        longitude: { type: Number, required: true }
    },
    { _id: false }
);

const serviceAreaSchema = new mongoose.Schema(
    {
        zoneId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodZone', required: true, index: true },
        name: { type: String, required: true, trim: true, index: true },
        coverageAreaKm2: { type: Number, default: 0, min: 0 },
        coordinates: {
            type: [coordinateSchema],
            required: true,
            validate: {
                validator(v) {
                    return Array.isArray(v) && v.length >= 3;
                },
                message: 'Service area must have at least 3 coordinates (polygon).'
            }
        },
        geometry: {
            type: { type: String, enum: ['Polygon'] },
            coordinates: { type: [[[Number]]] }
        },
        isActive: { type: Boolean, default: true, index: true }
    },
    {
        collection: 'food_service_areas',
        timestamps: true
    }
);

serviceAreaSchema.index({ zoneId: 1, isActive: 1, name: 1 });
serviceAreaSchema.index({ zoneId: 1, name: 1 }, { unique: true });
serviceAreaSchema.index({ geometry: '2dsphere' }, { sparse: true });

serviceAreaSchema.pre('save', async function saveServiceAreaGeometryAndValidateOverlap(next) {
    try {
        if (this.isNew || this.isModified('coordinates')) {
            // Overlap only matters among service areas inside the SAME zone.
            const overlapping = await findOverlappingZone(this.constructor, this.coordinates, {
                excludeId: this._id,
                extraFilter: { zoneId: this.zoneId }
            });
            if (overlapping) {
                return next(new ValidationError(
                    'A service area already exists for this part of the zone. Please adjust the boundary or choose another area.'
                ));
            }
        }

        if (this.coordinates?.length >= 3) {
            this.geometry = coordinatesToGeoJSONPolygon(this.coordinates);
            this.coverageAreaKm2 = Math.round(computePolygonAreaKm2(this.coordinates) * 1000) / 1000;
        }

        return next();
    } catch (error) {
        return next(error);
    }
});

export const FoodServiceArea = mongoose.model('FoodServiceArea', serviceAreaSchema, 'food_service_areas');
