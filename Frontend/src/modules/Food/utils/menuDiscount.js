/**
 * Menu discount helpers — mirrors Backend shared/menuDiscount.util.js so previews match
 * server pricing (the server is always the source of truth at checkout).
 */
export const MENU_DISCOUNT_MIN_PERCENT = 1
export const MENU_DISCOUNT_MAX_PERCENT = 90
export const MENU_DISCOUNT_MAX_SPAN_DAYS = 366

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/** Today's calendar date in IST ("YYYY-MM-DD"), same clock the backend uses. */
export const istToday = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10)

const daysBetween = (a, b) =>
  Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86400000)

export const formatYmd = (ymd) => {
  if (!ymd) return ""
  const d = new Date(`${ymd}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ymd
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" })
}

export const formatDiscountPeriod = (md) => {
  if (!md?.startDate) return ""
  if (md.scheduleType === "single_day" || md.startDate === md.endDate) return formatYmd(md.startDate)
  return `${formatYmd(md.startDate)} – ${formatYmd(md.endDate)}`
}

/**
 * discount = subtotal * pct%; split into admin/restaurant shares that always sum to the discount.
 * Accepts either a discount doc ({percentage, adminBearPercentage, restaurantBearPercentage})
 * or nothing (returns zeros).
 */
export function computeMenuDiscount(subtotal, md) {
  const safeSubtotal = Math.max(0, Number(subtotal) || 0)
  const pct = Number(md?.percentage) || 0
  if (safeSubtotal <= 0 || pct <= 0) return { discountAmount: 0, adminShare: 0, restaurantShare: 0 }
  const discountAmount = Math.min(safeSubtotal, round2((safeSubtotal * pct) / 100))
  const adminPct = Number(md?.adminBearPercentage) || 0
  const restPct = Number(md?.restaurantBearPercentage)
  const restPctSafe = Number.isFinite(restPct) ? restPct : 100
  const total = adminPct + restPctSafe
  const restaurantShare = round2(discountAmount * (total > 0 ? restPctSafe / total : 1))
  return { discountAmount, adminShare: round2(discountAmount - restaurantShare), restaurantShare }
}

/** Client-side validation (server re-validates everything). Returns an error string or "". */
export function validateMenuDiscountForm(form, { role, existing } = {}) {
  const pct = Number(form.percentage)
  if (!Number.isFinite(pct) || pct < MENU_DISCOUNT_MIN_PERCENT || pct > MENU_DISCOUNT_MAX_PERCENT) {
    return `Discount must be between ${MENU_DISCOUNT_MIN_PERCENT}% and ${MENU_DISCOUNT_MAX_PERCENT}%`
  }
  if (role === "admin" && !existing && !form.restaurantId) return "Select a restaurant"
  if (!form.startDate) return form.scheduleType === "single_day" ? "Select the discount date" : "Select a start date"
  const today = istToday()
  const endDate = form.scheduleType === "single_day" ? form.startDate : form.endDate
  if (!endDate) return "Select an end date"
  if (form.startDate < today && form.startDate !== existing?.startDate) return "Start date cannot be in the past"
  if (endDate < today) return "End date cannot be in the past"
  if (endDate < form.startDate) return "End date must be on or after start date"
  if (daysBetween(form.startDate, endDate) + 1 > MENU_DISCOUNT_MAX_SPAN_DAYS) {
    return `Discount period cannot exceed ${MENU_DISCOUNT_MAX_SPAN_DAYS} days`
  }
  if (role === "admin") {
    const a = Number(form.adminBearPercentage)
    const r = Number(form.restaurantBearPercentage)
    if (!Number.isFinite(a) || !Number.isFinite(r) || a < 0 || r < 0) return "Enter valid admin / restaurant share"
    if (Math.abs(a + r - 100) > 0.01) return "Admin share + restaurant share must total 100%"
  }
  return ""
}

export const MENU_DISCOUNT_STATE_STYLES = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  upcoming: "bg-blue-50 text-blue-700 border-blue-200",
  expired: "bg-slate-100 text-slate-500 border-slate-200",
  inactive: "bg-amber-50 text-amber-700 border-amber-200",
}

/** Order pricing → display lines shared by user / restaurant / admin order screens. */
export function getOrderDiscountBreakdown(pricing) {
  const total = Math.max(0, Number(pricing?.discount) || 0)
  const menu = Math.min(total, Math.max(0, Number(pricing?.menuDiscount) || 0))
  const info = pricing?.menuDiscountInfo || null
  const coupon = Math.max(0, round2(total - menu))
  return {
    total,
    menu,
    coupon,
    percentage: info?.percentage ? Number(info.percentage) : 0,
    source: info?.source || null,
    adminShare: Number(info?.adminShare) || 0,
    restaurantShare: Number(info?.restaurantShare) || 0,
    adminBearPercentage: Number(info?.adminBearPercentage) || 0,
    restaurantBearPercentage: Number(info?.restaurantBearPercentage) || 0,
    period: info ? formatDiscountPeriod(info) : "",
    couponCode: pricing?.couponCode || pricing?.appliedCoupon?.code || "",
  }
}
