/**
 * Food-owned delivery vehicle catalog.
 * Replaces the Porter admin-managed vehicle catalog that food's delivery-partner
 * onboarding/dispatch used to borrow. Static list — no admin CRUD, no external DB catalog.
 */

const DISPATCH_ELIGIBLE_STATUSES = new Set(['active', 'approved']);

export const FOOD_VEHICLE_CATALOG = [
    { id: 'bicycle', vehicleCode: 'BICYCLE', category: 'bicycle', name: 'Bicycle', displayOrder: 1 },
    { id: 'bike', vehicleCode: 'BIKE', category: 'bike', name: 'Bike', displayOrder: 2 },
    { id: 'electric_bike', vehicleCode: 'EBIKE', category: 'electric_bike', name: 'Electric Bike', displayOrder: 3 },
    { id: 'scooter', vehicleCode: 'SCOOTER', category: 'scooter', name: 'Scooter', displayOrder: 4 },
    { id: 'electric_scooter', vehicleCode: 'ESCOOTER', category: 'electric_scooter', name: 'Electric Scooter', displayOrder: 5 },
];

export function isDriverVehicleDispatchEligible(vehicle) {
    if (!vehicle) return false;
    const status = String(vehicle.status || '').toLowerCase();
    return DISPATCH_ELIGIBLE_STATUSES.has(status);
}

export function mapVehicleStatusLabel(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'active' || s === 'approved') return 'Approved';
    if (s === 'pending' || s === 'draft') return 'Pending Verification';
    if (s === 'rejected') return 'Rejected';
    if (s === 'inactive') return 'Inactive';
    return 'Unknown';
}

/** Public catalog for delivery signup — static food vehicle types. */
export function getSignupVehicleCatalog() {
    return FOOD_VEHICLE_CATALOG.map((v) => ({
        id: v.id,
        name: v.name,
        category: v.category,
        iconUrl: '',
        maxWeight: 0,
        description: '',
        supportedServices: ['food'],
    }));
}

export function mapDriverVehicleForClient(vehicle) {
    if (!vehicle) return null;
    const status = String(vehicle.status || 'pending').toLowerCase();
    const supportedServices = Array.isArray(vehicle.supportedServices) && vehicle.supportedServices.length
        ? vehicle.supportedServices
        : ['food'];
    const displayName = vehicle.vehicleName || vehicle.vehicleCode || 'Vehicle';

    return {
        id: String(vehicle.id || vehicle._id || ''),
        vehicleId: String(vehicle.id || vehicle._id || ''),
        vehicleName: displayName,
        vehicleCode: vehicle.vehicleCode || vehicle.vehicleType || '',
        vehicleNumber: vehicle.vehicleNumber || '',
        registrationNumber: vehicle.vehicleNumber || vehicle.registrationNumber || '',
        model: vehicle.model || '',
        supportedServices,
        status,
        verificationStatus: mapVehicleStatusLabel(status),
        isDefault: Boolean(vehicle.isDefault),
        isDispatchEligible: isDriverVehicleDispatchEligible({ ...vehicle, status }),
        iconUrl: null,
        master: {
            name: displayName,
            category: vehicle.category || '',
            image: null,
            iconUrl: null,
            supportedServices,
            vehicleCode: vehicle.vehicleCode || '',
        },
    };
}

export function resolveActiveVehicleId(partner, vehicles = []) {
    if (!vehicles.length) return null;
    const activeId = partner?.activeVehicleId ? String(partner.activeVehicleId) : null;
    if (activeId && vehicles.some((v) => v.id === activeId || v.vehicleId === activeId)) {
        return activeId;
    }
    const defaultVeh = vehicles.find((v) => v.isDefault) || vehicles[0];
    return defaultVeh?.id || defaultVeh?.vehicleId || null;
}

export async function getDeliveryPartnerVehiclePayload(partner) {
    const vehicles = (partner?.driverVehicles || []).map((v) => mapDriverVehicleForClient(v));
    const activeVehicleId = resolveActiveVehicleId(partner, vehicles);
    return { vehicles, driverVehicles: vehicles, activeVehicleId };
}

export function getApprovedDriverVehicles(vehicles = []) {
    return (Array.isArray(vehicles) ? vehicles : []).filter((v) => isDriverVehicleDispatchEligible(v));
}

export async function activateDriverVehiclesOnPartnerApproval(partner) {
    if (!partner?.driverVehicles?.length) return partner;
    let changed = false;
    partner.driverVehicles.forEach((v) => {
        const status = String(v.status || '').toLowerCase();
        if (status !== 'rejected' && status !== 'inactive' && status !== 'active') {
            v.status = 'active';
            changed = true;
        }
    });
    if (changed) await partner.save();
    return partner;
}

/**
 * No-op now that there's no external vehicle catalog to self-heal against —
 * a partner's embedded driverVehicles snapshot is the source of truth.
 */
export async function reconcilePartnerVehiclesWithCatalog(partner) {
    return { changed: false, partner };
}

function normalizeDriverVehiclesInput(rawVehicles = []) {
    if (!Array.isArray(rawVehicles)) return [];
    return rawVehicles.map((v, idx) => {
        const id = v.id || v._id || `dv-${Math.random().toString(16).slice(2)}-${idx}`;
        let status = v.status ? String(v.status).toLowerCase() : 'pending';
        if (status === 'draft') status = 'pending';

        return {
            id: String(id),
            vehicleName: v.vehicleName || v.name || '',
            vehicleNumber: v.vehicleNumber || v.registrationNumber || v.number || '',
            vehicleCode: v.vehicleCode || v.vehicleType || v.type || '',
            model: v.model || '',
            supportedServices: ['food'],
            status,
            isDefault: Boolean(v.isDefault) || idx === 0,
        };
    });
}

/** Normalizes the vehicles a signup payload sends — no catalog lookup, client fields are trusted as-is. */
export async function enrichDriverVehiclesFromSignupPayload(payload) {
    let raw = payload?.vehicles || payload?.driverVehicles;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { raw = []; }
    }
    if (!Array.isArray(raw) || !raw.length) return [];
    return normalizeDriverVehiclesInput(raw);
}
