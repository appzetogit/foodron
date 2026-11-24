import { useState, useEffect, useCallback } from "react"
import useRestaurantBackNavigation from "@food/hooks/useRestaurantBackNavigation"
import { ArrowLeft, Users, Phone, ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import { restaurantAPI } from "@food/api"
const debugError = (...args) => {}

const PAGE_SIZE = 20

const formatDate = (value) => {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

export default function RegularCustomers() {
  const goBack = useRestaurantBackNavigation()
  const [customers, setCustomers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState({ total: 0, pages: 1 })

  const fetchCustomers = useCallback(async (targetPage) => {
    try {
      setLoading(true)
      setError(null)
      const response = await restaurantAPI.getRegularCustomers({ page: targetPage, limit: PAGE_SIZE })
      const body = response?.data?.data || {}
      setCustomers(Array.isArray(body.data) ? body.data : [])
      setPagination({
        total: Number(body.meta?.total) || 0,
        pages: Number(body.meta?.totalPages) || 1,
      })
    } catch (err) {
      debugError("Error fetching regular customers:", err)
      setError(err?.response?.data?.message || "Failed to load regular customers")
      setCustomers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCustomers(page)
  }, [page, fetchCustomers])

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <div className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="px-4 py-3 flex items-center gap-3">
          <button
            onClick={goBack}
            className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
            aria-label="Go back"
          >
            <ArrowLeft className="w-6 h-6 text-gray-900" />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-gray-900">Regular Customers</h1>
            <span className="text-xs text-gray-500">
              Customers with 6+ orders from you this month
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 px-4 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        ) : customers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Users className="w-10 h-10 text-gray-300 mb-3" />
            <p className="text-sm text-gray-600">
              No regular customers yet this month
            </p>
            <p className="text-xs text-gray-400 mt-1">
              A customer shows up here once they place 6 orders with you in a calendar month
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {customers.map((customer) => (
              <div
                key={customer.userId}
                className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center shrink-0 overflow-hidden">
                    {customer.profileImage ? (
                      <img src={customer.profileImage} alt={customer.name} className="w-full h-full object-cover" />
                    ) : (
                      <Users className="w-5 h-5 text-gray-400" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900 truncate">{customer.name}</p>
                    {customer.phone && (
                      <p className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                        <Phone className="w-3 h-3" /> {customer.phone}
                      </p>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold text-green-700">{customer.monthlyOrderCount} orders</p>
                  <p className="text-[11px] text-gray-400 mt-0.5">this month</p>
                  {customer.lastOrderAt && (
                    <p className="text-[11px] text-gray-400">Last: {formatDate(customer.lastOrderAt)}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && !error && pagination.pages > 1 && (
          <div className="flex items-center justify-center gap-4 mt-6">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="p-2 rounded-lg border border-gray-200 bg-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-xs text-gray-600">
              Page {page} of {pagination.pages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
              disabled={page >= pagination.pages}
              className="p-2 rounded-lg border border-gray-200 bg-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
