import { useState, useEffect, useCallback } from "react"
import { Search, Loader2, Phone, ChevronLeft, ChevronRight, X } from "lucide-react"
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

export default function DeclineStats() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [pagination, setPagination] = useState({ total: 0, pages: 1 })

  const [viewPartner, setViewPartner] = useState(null)
  const [reasons, setReasons] = useState([])
  const [reasonsLoading, setReasonsLoading] = useState(false)

  const fetchStats = useCallback(async (targetPage, targetSearch) => {
    try {
      setLoading(true)
      setError(null)
      const response = await adminAPI.getDeliveryPartnerDeclineStats({
        page: targetPage,
        limit: PAGE_SIZE,
        search: targetSearch || undefined,
      })
      const body = response?.data?.data || {}
      setRows(Array.isArray(body.data) ? body.data : [])
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
    const timer = setTimeout(() => fetchStats(page, search), search.trim() ? 400 : 0)
    return () => clearTimeout(timer)
  }, [page, search, fetchStats])

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

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-5xl mx-auto">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Driver Order Decline Stats</h1>
          <p className="text-sm text-slate-500 mt-1">
            How many order offers each driver has passed/declined, with their reasons.
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="relative mb-4 max-w-sm">
            <input
              type="text"
              placeholder="Search by name or phone..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1) }}
              className="pl-10 pr-4 py-2.5 w-full text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          ) : error ? (
            <div className="text-center py-16 text-sm text-red-600">{error}</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-sm text-slate-500">
              No driver has declined any order offer yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-2 pr-4 font-semibold">Driver</th>
                    <th className="py-2 pr-4 font-semibold">Phone</th>
                    <th className="py-2 pr-4 font-semibold">Declines</th>
                    <th className="py-2 pr-4 font-semibold">Last Decline</th>
                    <th className="py-2 pr-4 font-semibold"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.partnerId} className="border-b border-slate-100">
                      <td className="py-3 pr-4 font-medium text-slate-900">{row.name}</td>
                      <td className="py-3 pr-4 text-slate-600 flex items-center gap-1">
                        {row.phone && <Phone className="w-3 h-3" />} {row.phone}
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
