import { useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { restaurantAPI } from "@food/api"
import BulkMenuImportWizard from "@food/components/bulk/BulkMenuImportWizard"

/** Restaurant bulk upload: the restaurant is the authenticated one (read-only here, taken from the token server-side). */
export default function BulkMenuImportPage() {
  const navigate = useNavigate()
  const [restaurantName, setRestaurantName] = useState("")

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const response = await restaurantAPI.getCurrentRestaurant()
        const profile =
          response?.data?.data?.restaurant || response?.data?.restaurant || response?.data?.data || null
        if (active) setRestaurantName(profile?.restaurantName || profile?.name || "")
      } catch (error) {
        // name is informational only
      }
    }
    load()
    return () => {
      active = false
    }
  }, [])

  const api = useMemo(
    () => ({
      downloadTemplate: (entity, opts) => restaurantAPI.downloadBulkMenuTemplate(entity, opts),
      validate: (entity, file) => restaurantAPI.validateBulkMenuImport(entity, file),
      start: (jobId, body) => restaurantAPI.startBulkMenuImport(jobId, body),
      status: (jobId, params) => restaurantAPI.getBulkMenuImport(jobId, params),
    }),
    [],
  )

  const restaurantSlot = (
    <div>
      <div className="text-sm font-semibold text-slate-900 mb-1">Restaurant</div>
      <div className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 max-w-md">
        {restaurantName || "Your restaurant"}
      </div>
      <p className="text-xs text-slate-500 mt-2">Items are always imported into your own restaurant.</p>
    </div>
  )

  return (
    <div className="min-h-screen bg-slate-50 p-4 lg:p-6">
      <div className="max-w-5xl mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate("/food/restaurant/inventory")}
          className="h-10 w-10 rounded-full bg-white border border-slate-200 flex items-center justify-center"
          aria-label="Back to inventory"
        >
          <ArrowLeft className="w-5 h-5 text-slate-700" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-slate-900">Bulk upload</h1>
          <p className="text-sm text-slate-500">Import food items and add-ons from one ZIP package.</p>
        </div>
      </div>

      <BulkMenuImportWizard
        api={api}
        restaurantSlot={restaurantSlot}
        approvalNote="Imported food items and add-ons are sent to the admin for approval (pending). They appear on the customer menu only after they are approved."
      />
    </div>
  )
}
