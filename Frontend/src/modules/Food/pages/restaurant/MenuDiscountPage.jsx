import { ArrowLeft } from "lucide-react"
import useRestaurantBackNavigation from "@food/hooks/useRestaurantBackNavigation"
import MenuDiscountManager from "@food/components/shared/MenuDiscountManager"
import { restaurantAPI } from "@food/api"

export default function MenuDiscountPage() {
  const goBack = useRestaurantBackNavigation()
  return (
    <div className="min-h-screen bg-[#f6e9dc] pb-24 md:pb-6">
      <div className="sticky top-0 z-40 flex items-center gap-3 border-b border-gray-200 bg-white px-4 py-3">
        <button onClick={goBack} className="rounded-lg p-1.5 transition-colors hover:bg-gray-100">
          <ArrowLeft className="h-5 w-5 text-gray-600" />
        </button>
        <h1 className="flex-1 text-lg font-bold text-gray-900">Menu Discount</h1>
      </div>
      <MenuDiscountManager role="restaurant" api={restaurantAPI} />
    </div>
  )
}
