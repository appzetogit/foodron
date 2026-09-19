import MenuDiscountManager from "@food/components/shared/MenuDiscountManager"
import { adminAPI } from "@food/api"

export default function RestaurantMenuDiscount() {
  return <MenuDiscountManager role="admin" api={adminAPI} />
}
