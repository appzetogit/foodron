import { useEffect, useState, useCallback } from "react"
import { Megaphone } from "lucide-react"
import { restaurantAPI } from "@food/api"

const money = (n) =>
  `${Number(n) < 0 ? "-" : ""}₹${Math.abs(Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * Advertisement charges for the restaurant: totals, today's live accrual and the
 * day-wise ledger (day earning × % = charge). Pass `adId` to scope to one ad.
 */
export default function AdChargesLedger({ adId = null, title = "Advertisement charges", limit = 30, onLoaded }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(false)
      const res = await restaurantAPI.getAdvertisementBilling({ limit, ...(adId ? { adId } : {}) })
      const payload = res?.data?.data || null
      setData(payload)
      onLoaded?.(payload)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [adId, limit, onLoaded])

  useEffect(() => {
    load()
  }, [load])

  const totals = data?.totals || {}
  const charges = data?.charges || []
  const todayAds = data?.todayAds || []
  const hasAnything = charges.length > 0 || todayAds.length > 0

  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm md:p-5">
      <div className="mb-3 flex items-center gap-2">
        <div className="rounded-full bg-red-50 p-2">
          <Megaphone className="h-4 w-4 text-red-600" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-bold text-gray-900">{title}</h3>
          <p className="text-xs text-gray-500">
            {data ? `Your ad rate: ${data.percentage}% of that day's earning, per active ad day` : " "}
          </p>
        </div>
      </div>

      {loading ? (
        <p className="py-6 text-center text-sm text-gray-500">Loading...</p>
      ) : error ? (
        <div className="py-6 text-center text-sm">
          <p className="text-red-600">Could not load ad charges</p>
          <button type="button" onClick={load} className="mt-1 text-sm font-medium text-red-600 underline">Retry</button>
        </div>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-gray-50 p-3">
              <p className="text-[10px] font-bold uppercase text-gray-400">Total charged</p>
              <p className="mt-1 text-sm font-bold text-gray-900">{money(totals.totalCharged)}</p>
            </div>
            <div className="rounded-xl bg-amber-50 p-3">
              <p className="text-[10px] font-bold uppercase text-amber-600">Deducted, pending</p>
              <p className="mt-1 text-sm font-bold text-amber-700">{money(totals.outstanding)}</p>
            </div>
            <div className="rounded-xl bg-blue-50 p-3">
              <p className="text-[10px] font-bold uppercase text-blue-600">Today (live)</p>
              <p className="mt-1 text-sm font-bold text-blue-700">{money(data?.todayAccrual)}</p>
            </div>
          </div>

          {!hasAnything ? (
            <p className="py-4 text-center text-sm text-gray-500">
              {data?.percentage > 0
                ? "No ad charges yet. Charges are booked after each active ad day ends."
                : "Your ads are currently free of charge."}
            </p>
          ) : (
            <div className="space-y-2">
              {todayAds.map((a) => (
                <div key={`live-${a.advertisementId}`} className="rounded-xl border border-blue-100 bg-blue-50/50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-gray-900">{a.adsId} • Today</p>
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700">LIVE ESTIMATE</span>
                  </div>
                  <p className="mt-1 text-xs text-gray-600">
                    {money(a.dayEarnings)} × {a.percentage}% = <span className="font-semibold text-blue-700">{money(a.amount)}</span>
                    <span className="text-gray-400"> (final after day ends)</span>
                  </p>
                </div>
              ))}
              {charges.map((c) =>
                c.isAdjustment ? (
                  <div key={c.id} className="rounded-xl border border-green-100 bg-green-50/50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-gray-900">{c.day} • {c.adsId} • Adjustment</p>
                      <span className={`text-sm font-bold ${c.amount < 0 ? "text-green-700" : "text-red-600"}`}>
                        {c.amount < 0 ? "+ " : "− "}{money(Math.abs(c.amount))}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-gray-600">
                      {c.note || "Earning changed after billing"}: earning {money(c.dayEarnings)} × {c.percentage}% ={" "}
                      {money(c.amount)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-gray-400">
                      {c.amount < 0
                        ? c.isSettled ? "Credited back to you" : "Added back to your wallet balance"
                        : c.isSettled ? "Adjusted in a withdrawal" : "Deducted from your wallet balance"}
                    </p>
                  </div>
                ) : (
                <div key={c.id} className="rounded-xl border border-gray-100 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-gray-900">{c.day} • {c.adsId}</p>
                    <span className="text-sm font-bold text-red-600">− {money(c.amount)}</span>
                  </div>
                  <p className="mt-1 text-xs text-gray-600">
                    Earning {money(c.dayEarnings)} ({c.ordersCount} orders) × {c.percentage}% = {money(c.amount)}
                  </p>
                  <p className="mt-0.5 text-[11px] text-gray-400">
                    {c.amount <= 0
                      ? "No earnings that day — nothing charged"
                      : c.isSettled
                        ? "Adjusted in a withdrawal"
                        : "Deducted from your wallet balance"}
                  </p>
                </div>
                )
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
