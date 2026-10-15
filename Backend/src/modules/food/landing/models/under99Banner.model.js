import mongoose from 'mongoose';

const foodUnder99BannerSchema = new mongoose.Schema(
    {
        imageUrl: {
            type: String,
            required: true
        },
        publicId: {
            type: String,
            required: true
        },
        title: {
            type: String
        },
        ctaText: {
            type: String
        },
        ctaLink: {
            type: String
        },
        zoneId: {
            type: String
        },
        sortOrder: {
            type: Number,
            default: 0,
            index: true
        },
        isActive: {
            type: Boolean,
            default: true,
            index: true
        }
    },
    {
        collection: 'food_under99_banners',
        timestamps: true
    }
);

foodUnder99BannerSchema.index({ isActive: 1, sortOrder: 1 });

export const FoodUnder99Banner = mongoose.model('FoodUnder99Banner', foodUnder99BannerSchema, 'food_under99_banners');

