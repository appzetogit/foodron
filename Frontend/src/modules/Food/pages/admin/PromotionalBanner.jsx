import { Navigate } from "react-router-dom"

/** Legacy route: promotional banners are managed under Landing Page Management. */
export default function PromotionalBanner() {
  return <Navigate to="/admin/food/hero-banner-management" replace />
}
