import { useCallback, useEffect, useMemo, useState } from "react"
import { BadgePercent, CalendarDays, Edit2, Loader2, Plus, Power, Search, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { adminAPI } from "@food/api"
import {
  MENU_DISCOUNT_MAX_PERCENT,
  MENU_DISCOUNT_MIN_PERCENT,
  MENU_DISCOUNT_STATE_STYLES,
  computeMenuDiscount,
  formatDiscountPeriod,
  istToday,
  validateMenuDiscountForm,
} from "@food/utils/menuDiscount"

const STATE_TABS = [
  { key: "", label: "All" },
  { key: "active", label: "Active" },
  { key: "upcoming", label: "Upcoming" },
  { key: "expired", label: "Expired" },
  { key: "inactive", label: "Inactive" },
]

const PREVIEW_ORDER_VALUE = 500
const rupee = (n) => `₹${(Number(n) || 0).toFixed(2).replace(/\.00$/, "")}`

const emptyForm = () => ({
  restaurantId: "",
  percentage: "",
  scheduleType: "date_range",
  startDate: istToday(),
  endDate: istToday(),
  adminBearPercentage: "0",
  restaurantBearPercentage: "100",
  note: "",
})

const errorMessage = (error, fallback) => error?.response?.data?.message || error?.message || fallback

/**
 * Shared menu-discount screen.
 *  - role="admin": picks a restaurant and decides the admin/restaurant bear split.
 *  - role="restaurant": own restaurant only, restaurant bears 100% of the discount.
 * `api` is adminAPI or restaurantAPI (same method names).
 */
export default function MenuDiscountManager({ role, api }) {
  const isAdmin = role === "admin"
  const [items, setItems] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [stateFilter, setStateFilter] = useState("")
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [restaurants, setRestaurants] = useState([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [restaurantQuery, setRestaurantQuery] = useState("")
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState("")

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim())
      setPage(1)
    }, 350)
    return () => clearTimeout(t)
  }, [search])

  const fetchItems = useCallback(async () => {
    try {
      setLoading(true)
      const params = { page, limit: 20 }
      if (stateFilter) params.state = stateFilter
      if (isAdmin && debouncedSearch) params.search = debouncedSearch
      const res = await api.getMenuDiscounts(params)
      const data = res?.data?.data || {}
      setItems(Array.isArray(data.discounts) ? data.discounts : [])
      setSummary(data.summary || null)
      setTotalPages(data.totalPages || 1)
    } catch (error) {
      toast.error(errorMessage(error, "Failed to load menu discounts"))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [api, page, stateFilter, debouncedSearch, isAdmin])

  useEffect(() => {
    fetchItems()
  }, [fetchItems])

  useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await adminAPI.getRestaurants({ page: 1, limit: 500 })
        const list = res?.data?.data?.restaurants || []
        if (!cancelled) {
          setRestaurants(
            list.map((r) => ({ id: String(r._id || r.id), name: r.restaurantName || r.name || "", status: r.status })),
          )
        }
      } catch {
        if (!cancelled) setRestaurants([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [isAdmin])

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm())
    setRestaurantQuery("")
    setModalOpen(true)
  }

  const openEdit = (item) => {
    setEditing(item)
    setForm({
      restaurantId: item.restaurantId,
      percentage: String(item.percentage),
      scheduleType: item.scheduleType,
      startDate: item.startDate,
      endDate: item.endDate,
      adminBearPercentage: String(item.adminBearPercentage ?? 0),
      restaurantBearPercentage: String(item.restaurantBearPercentage ?? 100),
      note: item.note || "",
    })
    setModalOpen(true)
  }

  const closeModal = () => {
    if (saving) return
    setModalOpen(false)
    setEditing(null)
  }

  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  // Admin enters their share; restaurant share is always the remainder so the total stays 100%.
  const setAdminShare = (value) => {
    const n = Math.min(100, Math.max(0, Number(value)))
    setForm((prev) => ({
      ...prev,
      adminBearPercentage: value === "" ? "" : String(n),
      restaurantBearPercentage: value === "" ? "" : String(Math.round((100 - n) * 100) / 100),
    }))
  }

  const preview = useMemo(
    () =>
      computeMenuDiscount(PREVIEW_ORDER_VALUE, {
        percentage: Number(form.percentage),
        adminBearPercentage: isAdmin ? Number(form.adminBearPercentage) : 0,
        restaurantBearPercentage: isAdmin ? Number(form.restaurantBearPercentage) : 100,
      }),
    [form.percentage, form.adminBearPercentage, form.restaurantBearPercentage, isAdmin],
  )

  const filteredRestaurants = useMemo(() => {
    const q = restaurantQuery.trim().toLowerCase()
    const list = restaurants.filter((r) => !r.status || r.status === "approved" || r.id === form.restaurantId)
    return (q ? list.filter((r) => r.name.toLowerCase().includes(q)) : list).slice(0, 100)
  }, [restaurants, restaurantQuery, form.restaurantId])

  const handleSave = async () => {
    const validation = validateMenuDiscountForm(form, { role, existing: editing })
    if (validation) {
      toast.error(validation)
      return
    }
    const payload = {
      percentage: Number(form.percentage),
      scheduleType: form.scheduleType,
      startDate: form.startDate,
      endDate: form.scheduleType === "single_day" ? form.startDate : form.endDate,
      note: form.note.trim(),
    }
    if (isAdmin) {
      payload.adminBearPercentage = Number(form.adminBearPercentage)
      payload.restaurantBearPercentage = Number(form.restaurantBearPercentage)
      if (!editing) payload.restaurantId = form.restaurantId
    }
    try {
      setSaving(true)
      if (editing) await api.updateMenuDiscount(editing.id, payload)
      else await api.createMenuDiscount(payload)
      toast.success(editing ? "Menu discount updated" : "Menu discount created")
      setModalOpen(false)
      setEditing(null)
      fetchItems()
    } catch (error) {
      toast.error(errorMessage(error, "Failed to save menu discount"))
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (item) => {
    try {
      setBusyId(item.id)
      await api.setMenuDiscountStatus(item.id, !item.isActive)
      toast.success(item.isActive ? "Menu discount deactivated" : "Menu discount activated")
      fetchItems()
    } catch (error) {
      toast.error(errorMessage(error, "Failed to update status"))
    } finally {
      setBusyId("")
    }
  }

  const handleDelete = async (item) => {
    if (!window.confirm(`Delete the ${item.percentage}% menu discount${item.restaurantName ? ` for ${item.restaurantName}` : ""}?`)) return
    try {
      setBusyId(item.id)
      await api.deleteMenuDiscount(item.id)
      toast.success("Menu discount deleted")
      fetchItems()
    } catch (error) {
      toast.error(errorMessage(error, "Failed to delete menu discount"))
    } finally {
      setBusyId("")
    }
  }

  const canManage = (item) => isAdmin || item.createdByRole === "restaurant"
  const inputCls =
    "w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-red-600 focus:ring-2 focus:ring-red-600/10"

  return (
    <div className="p-4 lg:p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900 lg:text-2xl">
            <BadgePercent className="h-6 w-6 text-red-600" /> Menu Discount
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {isAdmin
              ? "Set a percentage discount on a restaurant's entire menu for a date range or a single day, and decide how much admin and the restaurant each bear."
              : "Offer a percentage discount on your whole menu for a date range or a single day. The discount is borne entirely by your earnings."}
          </p>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700"
        >
          <Plus className="h-4 w-4" /> Add Menu Discount
        </button>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Orders with discount</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{summary.orders}</p>
            <p className="text-xs text-slate-500">Delivered orders only</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Total discount given</p>
            <p className="mt-1 text-xl font-bold text-red-600">{rupee(summary.discountGiven)}</p>
            <p className="text-xs text-slate-500">On {rupee(summary.orderValue)} of food value</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
              {isAdmin ? "Borne by admin earning" : "Funded by admin"}
            </p>
            <p className="mt-1 text-xl font-bold text-amber-600">{rupee(summary.adminBorne)}</p>
            <p className="text-xs text-slate-500">{isAdmin ? "Deducted from admin earning" : "Not deducted from you"}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
              {isAdmin ? "Borne by restaurants" : "Deducted from your earning"}
            </p>
            <p className="mt-1 text-xl font-bold text-slate-900">{rupee(summary.restaurantBorne)}</p>
            <p className="text-xs text-slate-500">{isAdmin ? "Deducted from restaurant earning" : "Your share of the discount"}</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {STATE_TABS.map((tab) => (
          <button
            key={tab.key || "all"}
            onClick={() => {
              setStateFilter(tab.key)
              setPage(1)
            }}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
              stateFilter === tab.key
                ? "border-red-600 bg-red-600 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {tab.label}
          </button>
        ))}
        {isAdmin && (
          <div className="relative ml-auto w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search restaurant"
              className={`${inputCls} pl-9`}
            />
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              {isAdmin && <th className="px-4 py-3">Restaurant</th>}
              <th className="px-4 py-3">Discount</th>
              <th className="px-4 py-3">Period</th>
              <th className="px-4 py-3">Who bears it</th>
              <th className="px-4 py-3">Cost so far</th>
              <th className="px-4 py-3">Set by</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td colSpan={isAdmin ? 8 : 7} className="px-4 py-10 text-center text-slate-500">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={isAdmin ? 8 : 7} className="px-4 py-10 text-center text-slate-500">
                  No menu discounts found
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="align-middle">
                  {isAdmin && <td className="px-4 py-3 font-medium text-slate-900">{item.restaurantName || "—"}</td>}
                  <td className="px-4 py-3 font-bold text-red-600">{item.percentage}% OFF</td>
                  <td className="px-4 py-3 text-slate-700">
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
                      {formatDiscountPeriod(item)}
                    </span>
                    {item.scheduleType === "single_day" && (
                      <span className="ml-1 text-xs text-slate-400">(single day)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    Admin {item.adminBearPercentage}% · Restaurant {item.restaurantBearPercentage}%
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {item.usage?.orders > 0 ? (
                      <>
                        <p className="font-semibold text-slate-900">{rupee(item.usage.discountGiven)} · {item.usage.orders} order{item.usage.orders === 1 ? "" : "s"}</p>
                        <p>
                          Admin {rupee(item.usage.adminBorne)} · Restaurant {rupee(item.usage.restaurantBorne)}
                        </p>
                      </>
                    ) : (
                      <span className="text-slate-400">No orders yet</span>
                    )}
                  </td>
                  <td className="px-4 py-3 capitalize text-slate-600">{item.createdByRole}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${MENU_DISCOUNT_STATE_STYLES[item.state] || ""}`}
                    >
                      {item.state}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {canManage(item) ? (
                      <div className="flex items-center justify-end gap-1">
                        {item.state !== "expired" && (
                          <button
                            onClick={() => handleToggle(item)}
                            disabled={busyId === item.id}
                            title={item.isActive ? "Deactivate" : "Activate"}
                            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                          >
                            <Power className="h-4 w-4" />
                          </button>
                        )}
                        <button
                          onClick={() => openEdit(item)}
                          disabled={busyId === item.id}
                          title="Edit"
                          className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                        >
                          <Edit2 className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(item)}
                          disabled={busyId === item.id}
                          title="Delete"
                          className="rounded-lg p-2 text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <p className="text-right text-xs text-slate-400">Managed by admin</p>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40"
          >
            Prev
          </button>
          <span className="text-slate-500">
            Page {page} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
          <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-xl sm:rounded-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
              <h2 className="text-lg font-bold text-slate-900">{editing ? "Edit Menu Discount" : "New Menu Discount"}</h2>
              <button onClick={closeModal} className="rounded-full p-1 hover:bg-slate-100">
                <X className="h-5 w-5 text-slate-600" />
              </button>
            </div>

            <div className="space-y-4">
              {isAdmin && (
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">Restaurant</label>
                  {editing ? (
                    <p className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-800">
                      {editing.restaurantName}
                    </p>
                  ) : (
                    <>
                      <input
                        value={restaurantQuery}
                        onChange={(e) => setRestaurantQuery(e.target.value)}
                        placeholder="Type to filter restaurants"
                        className={`${inputCls} mb-2`}
                      />
                      <select
                        value={form.restaurantId}
                        onChange={(e) => setField("restaurantId", e.target.value)}
                        className={inputCls}
                      >
                        <option value="">Select restaurant</option>
                        {filteredRestaurants.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </>
                  )}
                </div>
              )}

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">
                  Discount on all menu items (%)
                </label>
                <input
                  type="number"
                  min={MENU_DISCOUNT_MIN_PERCENT}
                  max={MENU_DISCOUNT_MAX_PERCENT}
                  step="0.5"
                  value={form.percentage}
                  onChange={(e) => setField("percentage", e.target.value)}
                  placeholder={`${MENU_DISCOUNT_MIN_PERCENT} – ${MENU_DISCOUNT_MAX_PERCENT}`}
                  className={inputCls}
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Applies on</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { key: "date_range", label: "Date range" },
                    { key: "single_day", label: "Single day" },
                  ].map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => setField("scheduleType", opt.key)}
                      className={`rounded-xl border px-3 py-2.5 text-sm font-semibold ${
                        form.scheduleType === opt.key
                          ? "border-red-600 bg-red-50 text-red-700"
                          : "border-slate-300 text-slate-600"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className={`grid gap-3 ${form.scheduleType === "single_day" ? "grid-cols-1" : "grid-cols-2"}`}>
                <div>
                  <label className="mb-1 block text-sm font-medium text-slate-700">
                    {form.scheduleType === "single_day" ? "Date" : "Start date"}
                  </label>
                  <input
                    type="date"
                    min={editing && form.startDate < istToday() ? undefined : istToday()}
                    value={form.startDate}
                    onChange={(e) => {
                      const v = e.target.value
                      setForm((prev) => ({
                        ...prev,
                        startDate: v,
                        endDate: prev.endDate && prev.endDate >= v ? prev.endDate : v,
                      }))
                    }}
                    className={inputCls}
                  />
                </div>
                {form.scheduleType !== "single_day" && (
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">End date</label>
                    <input
                      type="date"
                      min={form.startDate || istToday()}
                      value={form.endDate}
                      onChange={(e) => setField("endDate", e.target.value)}
                      className={inputCls}
                    />
                  </div>
                )}
              </div>
              <p className="-mt-2 text-xs text-slate-500">
                The discount applies only within these dates (India time, whole days) — never before or after.
              </p>

              {isAdmin ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="mb-2 text-sm font-medium text-slate-700">Who bears the discount? (total 100%)</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">Admin earning (%)</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={form.adminBearPercentage}
                        onChange={(e) => setAdminShare(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs text-slate-500">Restaurant earning (%)</label>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={form.restaurantBearPercentage}
                        onChange={(e) => {
                          const v = e.target.value
                          const n = Math.min(100, Math.max(0, Number(v)))
                          setForm((prev) => ({
                            ...prev,
                            restaurantBearPercentage: v === "" ? "" : String(n),
                            adminBearPercentage: v === "" ? "" : String(Math.round((100 - n) * 100) / 100),
                          }))
                        }}
                        className={inputCls}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  This discount is deducted 100% from your restaurant earning on every order it applies to.
                </p>
              )}

              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Note (optional)</label>
                <input
                  value={form.note}
                  maxLength={200}
                  onChange={(e) => setField("note", e.target.value)}
                  placeholder="e.g. Festival special"
                  className={inputCls}
                />
              </div>

              {preview.discountAmount > 0 && (
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                  <p className="font-semibold">Example: {rupee(PREVIEW_ORDER_VALUE)} item total</p>
                  <p>Customer saves {rupee(preview.discountAmount)}</p>
                  <p>
                    Admin earning bears {rupee(preview.adminShare)} · Restaurant earning bears{" "}
                    {rupee(preview.restaurantShare)}
                  </p>
                </div>
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={closeModal}
                disabled={saving}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? "Save changes" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
