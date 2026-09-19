import { useEffect, useMemo, useState } from "react"
import { FileSpreadsheet } from "lucide-react"
import { adminAPI } from "@food/api"
import BulkMenuImportWizard from "@food/components/bulk/BulkMenuImportWizard"

/** Admin bulk upload: the admin picks the restaurant; that selection is authoritative server-side. */
export default function BulkMenuImport() {
  const [restaurants, setRestaurants] = useState([])
  const [restaurantId, setRestaurantId] = useState("")
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const response = await adminAPI.getRestaurants({ limit: 1000, status: "approved" })
        const list = response?.data?.data?.restaurants || response?.data?.restaurants || []
        if (active) setRestaurants(list)
      } catch (error) {
        console.error("Error fetching restaurants", error)
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => {
      active = false
    }
  }, [])

  // Stable object so the wizard's polling effect is not restarted on every render.
  const api = useMemo(
    () => ({
      downloadTemplate: (entity, opts) => adminAPI.downloadBulkMenuTemplate(entity, { ...opts, restaurantId }),
      validate: (entity, file) => adminAPI.validateBulkMenuImport(restaurantId, entity, file),
      start: (jobId, body) => adminAPI.startBulkMenuImport(jobId, body),
      status: (jobId, params) => adminAPI.getBulkMenuImport(jobId, params),
    }),
    [restaurantId],
  )

  const restaurantSlot = (
    <div>
      <label className="block text-sm font-semibold text-slate-900 mb-2">Restaurant</label>
      <select
        value={restaurantId}
        onChange={(e) => setRestaurantId(e.target.value)}
        className="w-full max-w-md rounded-lg border border-slate-200 px-3 py-2 text-sm bg-white"
      >
        <option value="">{loading ? "Loading restaurants…" : "Select a restaurant"}</option>
        {restaurants.map((restaurant) => (
          <option key={restaurant._id || restaurant.id} value={restaurant._id || restaurant.id}>
            {restaurant.restaurantName || restaurant.name}
          </option>
        ))}
      </select>
      <p className="text-xs text-slate-500 mt-2">
        Everything in the package is imported into this restaurant. A restaurantId column in the file is never used to
        choose it.
      </p>
    </div>
  )

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-4 max-w-5xl">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-50 rounded-lg">
            <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Bulk Upload (Foods &amp; Add-ons)</h1>
            <p className="text-sm text-slate-500 mt-1">Import a restaurant&apos;s menu from one ZIP package.</p>
          </div>
        </div>
      </div>

      <BulkMenuImportWizard
        api={api}
        restaurantSlot={restaurantSlot}
        canValidate={Boolean(restaurantId)}
        resetKey={restaurantId}
        approvalNote="Admin imports are approved immediately: foods become visible on the user menu and add-ons are published."
      />
    </div>
  )
}
