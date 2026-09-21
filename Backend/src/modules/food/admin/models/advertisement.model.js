import mongoose from 'mongoose';

/**
 * 'Video Promotion' is discontinued: it stays in the enum only so legacy documents
 * still validate. It can no longer be created/edited (see ADS_TYPE_OPTIONS) and is
 * never billed or shown publicly.
 */
const ADS_TYPES = [
    'Video Promotion',
    'Restaurant Promotion',
    'Image Promotion',
    'Banner Promotion'
];

const advertisementSchema = new mongoose.Schema(
    {
        restaurantId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'FoodRestaurant',
            required: true,
            index: true
        },
        restaurantName: { type: String, required: true },
        restaurantEmail: { type: String, default: '' },
        adsId: { type: String, required: true, unique: true, index: true },
        title: { type: String, required: true, trim: true },
        description: { type: String, default: '' },
        adsType: {
            type: String,
            enum: ADS_TYPES,
            required: true
        },
        fileDescription: { type: String, default: '' },
        videoDescription: { type: String, default: '' },
        imageUrl: { type: String, default: '' },
        imagePublicId: { type: String, default: '' },
        videoUrl: { type: String, default: '' },
        videoPublicId: { type: String, default: '' },
        validity: { type: String, default: '' },
        startDate: { type: Date, default: null },
        endDate: { type: Date, default: null },
        priority: {
            type: String,
            enum: ['1', '2', '3'],
            default: '2'
        },
        status: {
            type: String,
            enum: ['Pending', 'Approved', 'Rejected', 'Paused'],
            default: 'Pending',
            index: true
        },
        requestType: {
            type: String,
            enum: ['new', 'update'],
            default: 'new',
            index: true
        },
        /**
         * Admin revenue-share % snapshotted from the restaurant when the ad went live
         * (0 = free / non-billable such as Video Promotion). Display copy of the
         * latest billing window — charges use the per-window value.
         */
        adCommissionPercentage: { type: Number, default: 0, min: 0, max: 100 },
        /**
         * Periods in which the ad was live (Approved and not paused/deleted).
         * Maintained by the pre-save hook below. Ads that went live before billing
         * existed have no window and are never charged retroactively.
         */
        billingWindows: {
            type: [
                {
                    _id: false,
                    from: { type: Date, required: true },
                    to: { type: Date, default: null },
                    percentage: { type: Number, default: 0, min: 0, max: 100 }
                }
            ],
            default: []
        },
        isDeleted: { type: Boolean, default: false, index: true }
    },
    { collection: 'food_advertisements', timestamps: true }
);

advertisementSchema.index({ restaurantId: 1, isDeleted: 1, createdAt: -1 });
advertisementSchema.index({ status: 1, requestType: 1, isDeleted: 1 });

/** Legacy ad types that carry no admin revenue share. */
export const NON_BILLABLE_ADS_TYPES = ['Video Promotion'];

advertisementSchema.pre('save', async function trackBillingWindow() {
    const live = this.status === 'Approved' && !this.isDeleted;
    const windows = this.billingWindows;
    const last = windows.length ? windows[windows.length - 1] : null;
    const isOpen = Boolean(last && !last.to);

    if (live && !isOpen) {
        let percentage = 0;
        if (!NON_BILLABLE_ADS_TYPES.includes(this.adsType)) {
            const restaurant = await mongoose
                .model('FoodRestaurant')
                .findById(this.restaurantId)
                .select('adCommissionPercentage')
                .lean();
            percentage = Math.min(100, Math.max(0, Number(restaurant?.adCommissionPercentage) || 0));
        }
        windows.push({ from: new Date(), to: null, percentage });
        this.adCommissionPercentage = percentage;
    } else if (!live && isOpen) {
        last.to = new Date();
    }
});

/** Ad types that can be created / saved today. */
export const ADS_TYPE_OPTIONS = ADS_TYPES.filter((t) => t !== 'Video Promotion');
export const FoodAdvertisement = mongoose.model(
    'FoodAdvertisement',
    advertisementSchema,
    'food_advertisements'
);
