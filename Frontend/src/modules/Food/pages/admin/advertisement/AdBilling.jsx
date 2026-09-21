import { useState, useEffect, useCallback, useMemo } from "react"
import { Search, Percent, Wallet, CalendarDays, Clock, RefreshCw, Save } from "lucide-react"
import { adminAPI } from "@food/api"
import { toast } from "sonner"

const money = (n) =>
  `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function StatCard({ icon: Icon, label, value, hint, tone = "slate" }) {
  const tones = {
    slate: "bg-slate-100 text-slate-700",
    green: "bg-emerald-100 text-emerald-700",
    amber: "bg-amber-100 text-amber-700",
    blue: "bg-blue-100 text-blue-700",
  }
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-lg ${tones[tone]}`}>
          <Icon className="w-5 h-5" />
        </div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      </div>
      <p className="mt-3 text-2xl font-bold text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

const TH = "px-4 py-3 text-left text-[10px] font-bold text-slate-700 uppercase tracking-wider"

export default function AdBilling() {
  const [loading, setLoading] = useState(true)
  const [billing, setBilling] = useState(null)
  const [settings, setSettings] = useState([])
  const [drafts, setDrafts] = useState({})
  const [savingId, setSavingId] = useState(null)
  const [search, setSearch] = useState("")
  const [filters, setFilters] = useState({ from: "", to: "", restaurantId: "" })

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true)
      const params = {}
      if (filters.from) params.from = filters.from
      if (filters.to) params.to = filters.to
      if (filters.restaurantId) params.restaurantId = filters.restaurantId
      const [b, s] = await Promise.all([
        adminAPI.getAdvertisementBilling(params),
        adminAPI.getRestaurantAdSettings({ limit: 500 }),
      ])
      setBilling(b?.data?.data || null)
      setSettings(Array.isArray(s?.data?.data) ? s.data.data : [])
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to load ad billing")
    } finally {
      setLoading(false)
    }
  }, [filters.from, filters.to, filters.restaurantId])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const filteredSettings = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return settings
    return settings.filter((r) => `${r.restaurantName} ${r.ownerPhone}`.toLowerCase().includes(q))
  }, [settings, search])

  const savePercentage = async (row) => {
    const raw = drafts[row.restaurantId]
    const value = Number(raw)
    if (raw === undefined || raw === "" || !Number.isFinite(value) || value < 0 || value > 100) {
      toast.error("Enter a percentage between 0 and 100")
      return
    }
    try {
      setSavingId(row.restaurantId)
      await adminAPI.setRestaurantAdPercentage(row.restaurantId, value)
      toast.success(`${row.restaurantName}: ${value}% saved`)
      setSettings((prev) =>
        prev.map((r) => (r.restaurantId === row.restaurantId ? { ...r, adCommissionPercentage: value } : r))
      )
      setDrafts((prev) => {
        const next = { ...prev }
        delete next[row.restaurantId]
        return next
      })
    } catch (err) {
      toast.error(err?.response?.data?.message || "Failed to save percentage")
    } finally {
      setSavingId(null)
    }
  }

  const totals = billing?.totals || {}
  const charges = billing?.charges || []
  const todayAds = billing?.todayAds || []
  const byRestaurant = billing?.byRestaurant || []

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Advertisement Billing</h1>
          <p className="text-sm text-slate-600 mt-1">
            For every active ad day the admin receives the restaurant&apos;s set percentage of that day&apos;s order
            earnings.
          </p>
        </div>
        <button
          onClick={fetchAll}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-slate-300 text-sm font-medium hover:bg-slate-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard icon={Wallet} tone="green" label="Ad revenue (received)" value={money(totals.totalCharged)}
          hint={`${totals.chargedDays || 0} charged ad-day(s)`} />
        <StatCard icon={Clock} tone="blue" label="Today (live estimate)" value={money(totals.todayAccrual)}
          hint="Booked after the day ends" />
        <StatCard icon={Percent} tone="amber" label="Still with restaurants" value={money(totals.outstanding)}
          hint="Deducted from their earnings, not yet withdrawn" />
        <StatCard icon={CalendarDays} label="Earnings base" value={money(totals.earningsBase)}
          hint="Restaurant earnings the % was applied on" />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">From</label>
          <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-600 mb-1">To</label>
          <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
            className="px-3 py-2 text-sm border border-slate-300 rounded-lg" />
        </div>
        <div className="min-w-[220px]">
          <label className="block text-xs font-semibold text-slate-600 mb-1">Restaurant</label>
          <select value={filters.restaurantId} onChange={(e) => setFilters((f) => ({ ...f, restaurantId: e.target.value }))}
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white">
            <option value="">All restaurants</option>
            {settings.map((r) => (
              <option key={r.restaurantId} value={r.restaurantId}>{r.restaurantName}</option>
            ))}
          </select>
        </div>
        {(filters.from || filters.to || filters.restaurantId) && (
          <button onClick={() => setFilters({ from: "", to: "", restaurantId: "" })}
            className="px-3 py-2 text-sm text-slate-600 hover:underline">Clear</button>
        )}
      </div>

      {/* Per-restaurant percentage */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="p-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">Restaurant ad percentage</h2>
            <p className="text-xs text-slate-500">
              Applied when an ad goes live (approved). Existing live ads keep the rate they started with. 0% = free ads.
            </p>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search restaurant"
              className="pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg w-64" />
          </div>
        </div>
        <div className="overflow-x-auto max-h-[420px]">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
              <tr>
                <th className={TH}>Restaurant</th>
                <th className={TH}>Phone</th>
                <th className={TH}>Current %</th>
                <th className={TH}>Set new %</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredSettings.map((r) => {
                const draft = drafts[r.restaurantId]
                const dirty = draft !== undefined && Number(draft) !== r.adCommissionPercentage
                return (
                  <tr key={r.restaurantId} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-sm font-medium text-slate-900">{r.restaurantName}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{r.ownerPhone || "—"}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-slate-800">{r.adCommissionPercentage}%</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <input type="number" min="0" max="100" step="0.01"
                          value={draft ?? r.adCommissionPercentage}
                          onChange={(e) => setDrafts((p) => ({ ...p, [r.restaurantId]: e.target.value }))}
                          className="w-24 px-2 py-1.5 text-sm border border-slate-300 rounded-md" />
                        <span className="text-sm text-slate-500">%</span>
                        <button onClick={() => savePercentage(r)} disabled={!dirty || savingId === r.restaurantId}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-md bg-slate-900 text-white disabled:opacity-40">
                          <Save className="w-3.5 h-3.5" />
                          {savingId === r.restaurantId ? "Saving" : "Save"}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!filteredSettings.length && (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-slate-500">No restaurants found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Live today */}
      {todayAds.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
          <div className="p-4 border-b border-slate-200">
            <h2 className="text-base font-bold text-slate-900">Running today</h2>
            <p className="text-xs text-slate-500">Estimate on today&apos;s delivered earnings so far — final amount is booked after midnight (IST).</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className={TH}>Ad</th><th className={TH}>Restaurant</th><th className={TH}>Earning so far</th>
                  <th className={TH}>Calculation</th><th className={TH}>Admin share (est.)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {todayAds.map((a) => (
                  <tr key={a.advertisementId}>
                    <td className="px-4 py-3 text-sm"><span className="font-medium">{a.adsId}</span><span className="block text-xs text-slate-500">{a.adsTitle}</span></td>
                    <td className="px-4 py-3 text-sm">{a.restaurantName}</td>
                    <td className="px-4 py-3 text-sm">{money(a.dayEarnings)} <span className="text-xs text-slate-500">({a.ordersCount} orders)</span></td>
                    <td className="px-4 py-3 text-sm text-slate-600">{money(a.dayEarnings)} × {a.percentage}%</td>
                    <td className="px-4 py-3 text-sm font-semibold text-blue-700">{money(a.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* By restaurant */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="p-4 border-b border-slate-200"><h2 className="text-base font-bold text-slate-900">Revenue by restaurant</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className={TH}>Restaurant</th><th className={TH}>Ads</th><th className={TH}>Charged days</th>
                <th className={TH}>Total received</th><th className={TH}>Still with restaurant</th><th className={TH}>Withdrawn by restaurant</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byRestaurant.map((r) => (
                <tr key={r.restaurantId}>
                  <td className="px-4 py-3 text-sm font-medium">{r.restaurantName}</td>
                  <td className="px-4 py-3 text-sm">{r.adsCount}</td>
                  <td className="px-4 py-3 text-sm">{r.chargedDays}</td>
                  <td className="px-4 py-3 text-sm font-semibold text-emerald-700">{money(r.totalCharged)}</td>
                  <td className="px-4 py-3 text-sm text-amber-700">{money(r.outstanding)}</td>
                  <td className="px-4 py-3 text-sm">{money(r.paidOut)}</td>
                </tr>
              ))}
              {!byRestaurant.length && !loading && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">No ad charges yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Day-wise charges */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="p-4 border-b border-slate-200"><h2 className="text-base font-bold text-slate-900">Day-wise charges</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className={TH}>Day</th><th className={TH}>Ad</th><th className={TH}>Restaurant</th>
                <th className={TH}>Day earning</th><th className={TH}>Calculation</th><th className={TH}>Admin got</th><th className={TH}>Restaurant</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {charges.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-3 text-sm whitespace-nowrap">{c.day}</td>
                  <td className="px-4 py-3 text-sm"><span className="font-medium">{c.adsId}</span><span className="block text-xs text-slate-500">{c.adsType}</span></td>
                  <td className="px-4 py-3 text-sm">{c.restaurantName}</td>
                  <td className="px-4 py-3 text-sm">{money(c.dayEarnings)} <span className="text-xs text-slate-500">({c.ordersCount} orders)</span></td>
                  <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">
                    {c.isAdjustment ? (
                      <span className="text-red-700">{c.note || "Adjustment"}</span>
                    ) : (
                      <>{money(c.dayEarnings)} × {c.percentage}%</>
                    )}
                  </td>
                  <td className={`px-4 py-3 text-sm font-semibold ${c.amount < 0 ? "text-red-600" : "text-emerald-700"}`}>{money(c.amount)}</td>
                  <td className="px-4 py-3 text-xs">
                    <span className={`px-2 py-1 rounded-full font-medium ${c.isSettled ? "bg-slate-100 text-slate-700" : "bg-amber-100 text-amber-700"}`}>
                      {c.isAdjustment
                        ? c.isSettled ? "Credited back" : "Credit in wallet"
                        : c.amount <= 0 ? "No earning" : c.isSettled ? "Paid via withdrawal" : "Deducted from wallet"}
                    </span>
                  </td>
                </tr>
              ))}
              {!charges.length && !loading && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-slate-500">No charges in this range</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
