const num = (v) => Number(v) || 0;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Restaurant-side earning breakdown for one order, taken from the FoodTransaction ledger
 * (the same snapshot payouts are computed from), so every screen shows the same numbers:
 *
 *   restaurantShare = gross (items + packaging)
 *                     − restaurant-funded delivery fee
 *                     − commission
 *                     − restaurant-borne discounts (menu + coupon)
 *                     + realized quick share
 *                     ± adjustments (partial refund scaling / rounding)
 *
 * The admin-borne discount is shown separately: it is funded from admin earning and is
 * NOT deducted from the restaurant.
 */
export function buildRestaurantEarningBreakdown(tx) {
    if (!tx) return null;
    const a = tx.amounts || {};
    const p = tx.pricing || {};

    const gross = r2(num(p.subtotal) + num(p.packagingFee));
    const commission = r2(num(a.restaurantCommission ?? p.restaurantCommission));
    const restaurantDeliveryFee = r2(num(p.restaurantDeliveryFee));
    const menuDiscountRestaurantShare = r2(num(a.menuRestaurantDiscountShare));
    const menuDiscountAdminShare = r2(num(a.menuAdminDiscountShare));
    const couponDiscountRestaurantShare = Math.max(
        0,
        r2(num(a.restaurantDiscountShare) - menuDiscountRestaurantShare)
    );
    const couponDiscountAdminShare = Math.max(
        0,
        r2(num(a.adminDiscountShare) - menuDiscountAdminShare)
    );
    const quickShare = a.quickRestaurantShareRealized ? r2(num(a.quickRestaurantShare)) : 0;
    const netEarning = r2(num(a.restaurantShare));

    const calculated = Math.max(
        0,
        r2(
            gross -
                restaurantDeliveryFee -
                commission -
                menuDiscountRestaurantShare -
                couponDiscountRestaurantShare +
                quickShare
        )
    );
    const adjustment = r2(netEarning - calculated);

    return {
        gross,
        commission,
        restaurantDeliveryFee,
        menuDiscount: r2(num(a.menuDiscount ?? p.menuDiscount)),
        menuDiscountRestaurantShare,
        menuDiscountAdminShare,
        couponDiscount: r2(num(a.couponDiscount ?? p.couponDiscount)),
        couponDiscountRestaurantShare,
        couponDiscountAdminShare,
        /** Total discount deducted from the restaurant's earning */
        restaurantDiscountShare: r2(menuDiscountRestaurantShare + couponDiscountRestaurantShare),
        /** Total discount funded by admin (not deducted from restaurant) */
        adminDiscountShare: r2(menuDiscountAdminShare + couponDiscountAdminShare),
        quickShare,
        /** Non-zero only after partial refund scaling / rounding */
        adjustment: Math.abs(adjustment) >= 0.01 ? adjustment : 0,
        netEarning,
    };
}
