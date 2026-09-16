/**
 * Regression checks for parcel vehicle eligibility (no DB required).
 * Run: node Backend/scripts/test-porter-parcel-vehicles.js
 */
import {
    isParcelVehicleEligible,
    computeParcelWeight,
} from '../src/modules/porter/services/porter-parcel-vehicle.service.js';
import { calculateFareFromPricing } from '../src/modules/porter/utils/porter-pricing-calculator.util.js';

const pricing = {
    basePrice: 40,
    baseDistance: 2,
    distancePrice: 8,
    serviceTax: 5,
    enableDistanceCharges: true,
    commissionType: 'Percentage',
    commissionValue: 10,
};

const bike = {
    _id: 'bike',
    name: 'Bike',
    status: 'active',
    supportedServices: ['parcel'],
    maxWeight: 20,
    minWeight: 0,
};

const truck = {
    _id: 'truck',
    name: 'Truck',
    status: 'active',
    supportedServices: ['parcel'],
    maxWeight: 500,
    minWeight: 0,
};

const inactive = {
    ...bike,
    _id: 'inactive',
    status: 'inactive',
};

const foodOnly = {
    ...bike,
    _id: 'food',
    supportedServices: ['food'],
};

let passed = 0;
let failed = 0;

function assert(label, condition) {
    if (condition) {
        passed += 1;
        console.log(`PASS ${label}`);
    } else {
        failed += 1;
        console.error(`FAIL ${label}`);
    }
}

assert('10kg fits bike', isParcelVehicleEligible(bike, 10, pricing).eligible);
assert('25kg too heavy for bike', !isParcelVehicleEligible(bike, 25, pricing).eligible);
assert('100kg fits truck', isParcelVehicleEligible(truck, 100, pricing).eligible);
assert('inactive vehicle rejected', !isParcelVehicleEligible(inactive, 5, pricing).eligible);
assert('non-parcel service rejected', !isParcelVehicleEligible(foodOnly, 5, pricing).eligible);
assert('missing pricing rejected', !isParcelVehicleEligible(bike, 5, null).eligible);
assert('total parcel weight = weight * qty', computeParcelWeight({ weightKg: 5, quantity: 3 }) === 15);

const fare = calculateFareFromPricing(pricing, 5);
assert('fare has total', fare && fare.total > 0);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
