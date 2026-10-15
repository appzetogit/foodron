import express from 'express';
import { upload } from '../../../../middleware/upload.js';
import {
    listHeroBannersController,
    uploadHeroBannersController,
    deleteHeroBannerController,
    updateHeroBannerOrderController,
    toggleHeroBannerStatusController,
    updateHeroBannerController
} from '../controllers/heroBanner.controller.js';
import {
    listUnder99BannersController,
    uploadUnder99BannersController,
    deleteUnder99BannerController,
    updateUnder99BannerOrderController,
    toggleUnder99BannerStatusController
} from '../controllers/under99Banner.controller.js';
import {
    getAdminLandingSettingsController,
    updateAdminLandingSettingsController
} from '../controllers/landingSettings.controller.js';
import {
    listExploreMoreController,
    createExploreMoreController,
    updateExploreMoreController,
    deleteExploreMoreController,
    toggleExploreMoreStatusController,
    updateExploreMoreOrderController
} from '../controllers/exploreIcon.controller.js';
import {
    getPublicHeroBannersController,
    getPublicUnder99BannersController,
    getPublicExploreIconsController,
    getPublicGourmetController,
    getPublicLandingSettingsController,
    getPublicAdvertisementsController
} from '../controllers/publicLanding.controller.js';
import { detectZonePublicController, listZonesPublicController, listZonesNearbyPublicController } from '../controllers/zonePublic.controller.js';
import { getPublicEnvController } from '../controllers/publicEnv.controller.js';
import { getPublicFeeSettingsController } from '../controllers/publicFeeSettings.controller.js';
import {
    listGourmetAdmin,
    createGourmetAdmin,
    deleteGourmetAdmin,
    updateGourmetOrderAdmin,
    toggleGourmetStatusAdmin
} from '../controllers/top10GourmetAdmin.controller.js';
import { getPublicPageController } from '../../admin/controllers/pageContent.controller.js';
import { getPublicReferralSettingsController } from '../controllers/publicReferralSettings.controller.js';
import { cacheResponse } from '../../../../middleware/cache.js';
import { authMiddleware, checkPermission } from '../../../../core/auth/auth.middleware.js';
import { requireRoles } from '../../../../core/roles/role.middleware.js';
import { invalidateLandingCacheOnSuccess } from '../landingCache.js';

const router = express.Router();

const LANDING_PERM = 'food::banner_settings::landing_page';
const adminLanding = (action) => [
    authMiddleware,
    requireRoles('ADMIN', 'EMPLOYEE'),
    checkPermission(LANDING_PERM, action)
];

// Public CMS pages (About + legal). No auth required.
router.get('/pages/:key', getPublicPageController);
// Public referral settings (no auth required).
router.get('/referral-settings', getPublicReferralSettingsController);

// Admin hero banner management
router.get('/hero-banners', ...adminLanding('view'), listHeroBannersController);
router.post(
    '/hero-banners/multiple',
    ...adminLanding('create'),
    upload.array('files'),
    invalidateLandingCacheOnSuccess('landing_hero'),
    uploadHeroBannersController
);
router.delete(
    '/hero-banners/:id',
    ...adminLanding('delete'),
    invalidateLandingCacheOnSuccess('landing_hero'),
    deleteHeroBannerController
);
router.patch(
    '/hero-banners/:id/order',
    ...adminLanding('edit'),
    invalidateLandingCacheOnSuccess('landing_hero'),
    updateHeroBannerOrderController
);
router.patch(
    '/hero-banners/:id/status',
    ...adminLanding('edit'),
    invalidateLandingCacheOnSuccess('landing_hero'),
    toggleHeroBannerStatusController
);
router.patch(
    '/hero-banners/:id',
    ...adminLanding('edit'),
    invalidateLandingCacheOnSuccess('landing_hero'),
    updateHeroBannerController
);

// Admin under 99 banners
router.get('/hero-banners/under-99', ...adminLanding('view'), listUnder99BannersController);
router.post(
    '/hero-banners/under-99/multiple',
    ...adminLanding('create'),
    upload.array('files'),
    invalidateLandingCacheOnSuccess('landing_under99'),
    uploadUnder99BannersController
);
router.delete(
    '/hero-banners/under-99/:id',
    ...adminLanding('delete'),
    invalidateLandingCacheOnSuccess('landing_under99'),
    deleteUnder99BannerController
);
router.patch(
    '/hero-banners/under-99/:id/order',
    ...adminLanding('edit'),
    invalidateLandingCacheOnSuccess('landing_under99'),
    updateUnder99BannerOrderController
);
router.patch(
    '/hero-banners/under-99/:id/status',
    ...adminLanding('edit'),
    invalidateLandingCacheOnSuccess('landing_under99'),
    toggleUnder99BannerStatusController
);

// Admin Explore More (icons)
router.get('/hero-banners/landing/explore-more', ...adminLanding('view'), listExploreMoreController);
router.post(
    '/hero-banners/landing/explore-more',
    ...adminLanding('create'),
    upload.single('image'),
    invalidateLandingCacheOnSuccess('landing_explore'),
    createExploreMoreController
);
router.delete(
    '/hero-banners/landing/explore-more/:id',
    ...adminLanding('delete'),
    invalidateLandingCacheOnSuccess('landing_explore'),
    deleteExploreMoreController
);
router.patch(
    '/hero-banners/landing/explore-more/:id/status',
    ...adminLanding('edit'),
    invalidateLandingCacheOnSuccess('landing_explore'),
    toggleExploreMoreStatusController
);
router.patch(
    '/hero-banners/landing/explore-more/:id/order',
    ...adminLanding('edit'),
    invalidateLandingCacheOnSuccess('landing_explore'),
    updateExploreMoreOrderController
);
router.patch(
    '/hero-banners/landing/explore-more/:id',
    ...adminLanding('edit'),
    upload.single('image'),
    invalidateLandingCacheOnSuccess('landing_explore'),
    updateExploreMoreController
);

// Admin Gourmet (hero-banners)
router.get('/hero-banners/gourmet', ...adminLanding('view'), listGourmetAdmin);
router.post(
    '/hero-banners/gourmet',
    ...adminLanding('create'),
    invalidateLandingCacheOnSuccess('landing_gourmet'),
    createGourmetAdmin
);
router.delete(
    '/hero-banners/gourmet/:id',
    ...adminLanding('delete'),
    invalidateLandingCacheOnSuccess('landing_gourmet'),
    deleteGourmetAdmin
);
router.patch(
    '/hero-banners/gourmet/:id/order',
    ...adminLanding('edit'),
    invalidateLandingCacheOnSuccess('landing_gourmet'),
    updateGourmetOrderAdmin
);
router.patch(
    '/hero-banners/gourmet/:id/status',
    ...adminLanding('edit'),
    invalidateLandingCacheOnSuccess('landing_gourmet'),
    toggleGourmetStatusAdmin
);

// Public landing endpoints (Food user app)
router.get('/hero-banners/public', cacheResponse(300, 'landing_hero'), getPublicHeroBannersController);
router.get('/hero-banners/under-99/public', cacheResponse(300, 'landing_under99'), getPublicUnder99BannersController);
router.get('/explore-icons/public', cacheResponse(300, 'landing_explore'), getPublicExploreIconsController);
router.get('/hero-banners/gourmet/public', cacheResponse(300, 'landing_gourmet'), getPublicGourmetController);
router.get('/landing/settings/public', cacheResponse(300, 'landing_settings'), getPublicLandingSettingsController);
router.get('/advertisements/public', cacheResponse(300, 'landing_advertisements'), getPublicAdvertisementsController);
router.get('/zones/detect', detectZonePublicController);
router.get('/zones/nearby', listZonesNearbyPublicController);
router.get('/zones/public', cacheResponse(600, 'landing_zones'), listZonesPublicController);
router.get('/public/env', getPublicEnvController);
router.get('/fee-settings/public', cacheResponse(60, 'fee_settings'), getPublicFeeSettingsController);

// Admin landing settings (old paths used by admin UI)
router.get('/hero-banners/landing/settings', ...adminLanding('view'), getAdminLandingSettingsController);
router.patch(
    '/hero-banners/landing/settings',
    ...adminLanding('edit'),
    invalidateLandingCacheOnSuccess('landing_settings'),
    updateAdminLandingSettingsController
);

export default router;
