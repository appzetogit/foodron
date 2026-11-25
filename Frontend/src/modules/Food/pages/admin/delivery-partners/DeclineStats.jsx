import { useState, useEffect, useCallback } from "react"
import { Search, Loader2, Phone, ChevronLeft, ChevronRight, ChevronDown, Filter, XCircle, Users, TrendingDown } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@food/components/ui/dialog"
import { adminAPI } from "@food/api"
const debugError = (...args) => {}

const PAGE_SIZE = 20

const formatDate = (value) => {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

const DEFAULT_FILTERS = {
  search: "",
  zoneId: "",
  serviceAreaId: "",
  fromDate: "",
  toDate: "",
}

export default function DeclineStats() {
  const [rows, setRows] = useState([])
  const [summary, setSummary] = useState({ totalDeclines: 0, totalDrivers: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState({ total: 0, pages: 1 })

  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const [zones, setZones] = useState([])
  const [serviceAreas, setServiceAreas] = useState([])

  const [viewPartner, setViewPartner] = useState(null)
  const [reasons, setReasons] = useState([])
  const [reasonsLoading, setReasonsLoading] = useState(false)

  useEffect(() => {
    adminAPI.getZones({ limit: 1000, isActive: true, view: "summary" })
      .then((res) => {
        const list = res?.data?.data?.zones || []
        setZones(Array.isArray(list) ? list : [])
      })
      .catch(() => setZones([]))
  }, [])

  useEffect(() => {
    if (!filters.zoneId) {
      setServiceAreas([])
      return
    }
    adminAPI.getServiceAreas({ zoneId: filters.zoneId })
      .then((res) => {
        const list = res?.data?.data?.serviceAreas || []
        setServiceAreas(Array.isArray(list) ? list : [])
      })
      .catch(() => setServiceAreas([]))
  }, [filters.zoneId])

  const fetchStats = useCallback(async (targetPage, activeFilters) => {
    try {
      setLoading(true)
      setError(null)
      const response = await adminAPI.getDeliveryPartnerDeclineStats({
        page: targetPage,
        limit: PAGE_SIZE,
        search: activeFilters.search.trim() || undefined,
        zoneId: activeFilters.zoneId || undefined,
        serviceAreaId: activeFilters.zoneId && activeFilters.serviceAreaId ? activeFilters.serviceAreaId : undefined,
        fromDate: activeFilters.fromDate || undefined,
        toDate: activeFilters.toDate || undefined,
      })
      const body = response?.data?.data || {}
      setRows(Array.isArray(body.data) ? body.data : [])
      setSummary({
        totalDeclines: Number(body.summary?.totalDeclines) || 0,
        totalDrivers: Number(body.summary?.totalDrivers) || 0,
      })
      setPagination({
        total: Number(body.meta?.total) || 0,
        pages: Number(body.meta?.totalPages) || 1,
      })
    } catch (err) {
      debugError("Error fetching decline stats:", err)
      setError(err?.response?.data?.message || "Failed to load decline stats")
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => fetchStats(page, filters), filters.search.trim() ? 400 : 0)
    return () => clearTimeout(timer)
  }, [page, filters, fetchStats])

  const handleViewReasons = async (partner) => {
    setViewPartner(partner)
    setReasonsLoading(true)
    setReasons([])
    try {
      const response = await adminAPI.getDeliveryPartnerDeclineReasons(partner.partnerId, { limit: 50 })
      const body = response?.data?.data || {}
      setReasons(Array.isArray(body.data) ? body.data : [])
    } catch (err) {
      debugError("Error fetching decline reasons:", err)
    } finally {
      setReasonsLoading(false)
    }
  }

  const handleResetFilters = () => {
    setFilters(DEFAULT_FILTERS)
    setPage(1)
  }

  const activeFilterCount =
    (filters.zoneId ? 1 : 0) + (filters.fromDate ? 1 : 0) + (filters.toDate ? 1 : 0)

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-6xl mx-auto">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Driver Order Decline Stats</h1>
          <p className="text-sm text-slate-500 mt-1">
            How many order offers each driver has passed/declined, with their reasons.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex items-center gap-4">
            <div className="w-11 h-11 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
              <TrendingDown className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Total declines</p>
              <p className="text-xl font-bold text-slate-900">{summary.totalDeclines}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5 flex items-center gap-4">
            <div className="w-11 h-11 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
              <Users className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-xs text-slate-500">Drivers who declined</p>
              <p className="text-xl font-bold text-slate-900">{summary.totalDrivers}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
            <div className="relative flex-1 min-w-[220px]">
              <input
                type="text"
                placeholder="Search by name or phone..."
                value={filters.search}
                onChange={(e) => { setFilters((p) => ({ ...p, search: e.target.value })); setPage(1) }}
                className="pl-10 pr-4 py-2.5 w-full text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            </div>

            <button
              onClick={() => setIsFilterOpen((v) => !v)}
              className="px-4 py-2.5 text-sm font-medium rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 flex items-center gap-2 transition-all"
            >
              <Filter className="w-4 h-4" />
              <span>Filters</span>
              {activeFilterCount > 0 && (
                <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[11px] flex items-center justify-center">
                  {activeFilterCount}
                </span>
              )}
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isFilterOpen ? "rotate-180" : ""}`} />
            </button>

            {activeFilterCount > 0 && (
              <button
                onClick={handleResetFilters}
                className="px-3 py-2.5 text-sm font-medium text-slate-500 hover:text-red-600 flex items-center gap-1.5 transition-colors"
              >
                <XCircle className="w-4 h-4" /> Clear
              </button>
            )}
          </div>

          {isFilterOpen && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5 p-4 rounded-lg bg-slate-50 border border-slate-200">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">Zone</label>
                <select
                  value={filters.zoneId}
                  onChange={(e) => { setFilters((p) => ({ ...p, zoneId: e.target.value, serviceAreaId: "" })); setPage(1) }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                >
                  <option value="">All Zones</option>
                  {zones.map((zone) => (
                    <option key={zone._id} value={zone._id}>{zone.zoneName || zone.name}</option>
                  ))}
                </select>
              </div>

              {filters.zoneId && serviceAreas.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">Service Area</label>
                  <select
                    value={filters.serviceAreaId}
                    onChange={(e) => { setFilters((p) => ({ ...p, serviceAreaId: e.target.value })); setPage(1) }}
                    className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                  >
                    <option value="">All Service Areas</option>
                    {serviceAreas.map((sa) => (
                      <option key={sa._id} value={sa._id}>{sa.name}</option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">From Date</label>
                <input
                  type="date"
                  value={filters.fromDate}
                  onChange={(e) => { setFilters((p) => ({ ...p, fromDate: e.target.value })); setPage(1) }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">To Date</label>
                <input
                  type="date"
                  value={filters.toDate}
                  min={filters.fromDate || undefined}
                  onChange={(e) => { setFilters((p) => ({ ...p, toDate: e.target.value })); setPage(1) }}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 bg-white"
                />
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          ) : error ? (
            <div className="text-center py-16 text-sm text-red-600">{error}</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-sm text-slate-500">
              {activeFilterCount > 0 || filters.search.trim()
                ? "No decline data matches these filters."
                : "No driver has declined any order offer yet."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-2 pr-4 font-semibold">Driver</th>
                    <th className="py-2 pr-4 font-semibold">Phone</th>
                    <th className="py-2 pr-4 font-semibold">Zone</th>
                    <th className="py-2 pr-4 font-semibold">Declines</th>
                    <th className="py-2 pr-4 font-semibold">Last Decline</th>
                    <th className="py-2 pr-4 font-semibold"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.partnerId} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-3 pr-4 font-medium text-slate-900">{row.name}</td>
                      <td className="py-3 pr-4 text-slate-600">
                        <span className="flex items-center gap-1">
                          {row.phone && <Phone className="w-3 h-3" />} {row.phone}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-slate-600 text-xs">
                        {row.zoneName || "—"}
                        {row.serviceAreaName && <span className="text-slate-400"> / {row.serviceAreaName}</span>}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="px-2 py-0.5 rounded-full bg-red-50 text-red-700 font-semibold text-xs">
                          {row.declineCount}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-slate-500 text-xs">{formatDate(row.lastDeclineAt)}</td>
                      <td className="py-3 pr-4">
                        <button
                          onClick={() => handleViewReasons(row)}
                          className="text-xs font-semibold text-blue-600 hover:underline"
                        >
                          View reasons
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && !error && pagination.pages > 1 && (
            <div className="flex items-center justify-center gap-4 mt-6">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="p-2 rounded-lg border border-slate-200 bg-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-slate-600">Page {page} of {pagination.pages}</span>
              <button
                onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
                disabled={page >= pagination.pages}
                className="p-2 rounded-lg border border-slate-200 bg-white disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={Boolean(viewPartner)} onOpenChange={(open) => !open && setViewPartner(null)}>
        <DialogContent className="max-w-lg bg-white max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{viewPartner?.name} — Decline Reasons</DialogTitle>
          </DialogHeader>
          {reasonsLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
            </div>
          ) : reasons.length === 0 ? (
            <p className="text-sm text-slate-500 py-6 text-center">No reasons recorded.</p>
          ) : (
            <div className="space-y-3">
              {reasons.map((r, idx) => (
                <div key={`${r.orderMongoId}-${idx}`} className="border border-slate-200 rounded-lg p-3">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                    <span className="font-semibold text-slate-700">{r.orderId}</span>
                    <span>{formatDate(r.at)}</span>
                  </div>
                  <p className="text-xs text-slate-500 mb-1">{r.restaurantName}</p>
                  <p className="text-sm text-slate-900">
                    {r.reason ? r.reason : <span className="text-slate-400 italic">No reason given</span>}
                  </p>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
