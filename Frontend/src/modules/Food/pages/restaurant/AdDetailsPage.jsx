import { useState, useEffect } from "react"
import { motion } from "framer-motion"
import { useNavigate, useParams } from "react-router-dom"
import useRestaurantBackNavigation from "@food/hooks/useRestaurantBackNavigation"
import {
  ArrowLeft,
  Calendar,
  Megaphone,
  Edit
} from "lucide-react"
import { Card, CardContent } from "@food/components/ui/card"
import { Button } from "@food/components/ui/button"
import BottomNavOrders from "@food/components/restaurant/BottomNavOrders"
import { restaurantAPI } from "@food/api"
import AdChargesLedger from "@food/components/restaurant/AdChargesLedger"
import { toast } from "sonner"

export default function AdDetailsPage() {
  const navigate = useNavigate()
  const goBack = useRestaurantBackNavigation()
  const { id } = useParams()
  const [adData, setAdData] = useState(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!id) return
      try {
        setLoading(true)
        const response = await restaurantAPI.getAdvertisement(id)
        if (!cancelled) setAdData(response?.data?.data || null)
      } catch (err) {
        if (!cancelled) {
          setAdData(null)
          toast.error(err?.response?.data?.message || "Failed to load advertisement")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [id])

  return (
    <div className="min-h-screen bg-gray-50 overflow-x-hidden pb-24 md:pb-6">
      <div className="bg-white border-b border-gray-200 px-4 py-3 sticky top-0 z-50 flex items-center gap-3">
        <button
          onClick={goBack}
          className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-gray-600" />
        </button>
        <h1 className="text-lg font-bold text-gray-900 flex-1">Ads Details</h1>
      </div>

      <div className="px-4 py-4 space-y-4">
        {loading && (
          <Card className="bg-white shadow-sm border border-gray-100">
            <CardContent className="p-6 text-center">
              <p className="text-sm text-gray-600">Loading advertisement...</p>
            </CardContent>
          </Card>
        )}

        {!loading && !adData && (
          <Card className="bg-white shadow-sm border border-gray-100">
            <CardContent className="p-6 text-center">
              <p className="text-gray-900 font-semibold">Advertisement unavailable</p>
              <p className="text-sm text-gray-600 mt-2">
                No advertisement data was found for ID {id || "unknown"}.
              </p>
            </CardContent>
          </Card>
        )}

        {!loading && adData && (
          <>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <Card className="bg-white shadow-sm border border-gray-100">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <h2 className="text-base font-bold text-gray-900">
                      Ads ID #{adData.adsId || adData.id}
                    </h2>
                    <span
                      className={`text-xs font-medium px-3 py-1 rounded-full ${
                        {
                          Approved: "bg-green-100 text-green-700",
                          Running: "bg-green-100 text-green-700",
                          Pending: "bg-amber-100 text-amber-700",
                          Rejected: "bg-red-100 text-red-700",
                          Paused: "bg-slate-200 text-slate-700",
                          Expired: "bg-orange-100 text-orange-700",
                        }[adData.status] || "bg-blue-100 text-blue-700"
                      }`}
                    >
                      {adData.status}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.1 }}
            >
              <Card className="bg-white shadow-sm border border-gray-100">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-0.5">
                      <Calendar className="w-5 h-5 text-[#FF0000]" />
                    </div>
                    <div className="flex-1">
                      <p className="text-xs text-gray-500 mb-0.5">Ads Created</p>
                      <p className="text-sm font-medium text-gray-900">{adData.adsCreated}</p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-0.5">
                      <Calendar className="w-5 h-5 text-[#FF0000]" />
                    </div>
                    <div className="flex-1">
                      <p className="text-xs text-gray-500 mb-0.5">Duration</p>
                      <p className="text-sm font-medium text-gray-900">
                        {adData.duration?.start || "N/A"} - {adData.duration?.end || "N/A"}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 mt-0.5">
                      <Megaphone className="w-5 h-5 text-[#FF0000]" />
                    </div>
                    <div className="flex-1">
                      <p className="text-xs text-gray-500 mb-0.5">Ads Details</p>
                      <p className="text-sm font-bold text-gray-900">{adData.adsDetails || adData.adsType}</p>
                    </div>
                  </div>

                </CardContent>
              </Card>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: 0.2 }}
            >
              <Card className="bg-white shadow-sm border border-gray-100">
                <CardContent className="p-4 space-y-4">
                  <div>
                    <h3 className="text-sm font-bold text-gray-900 mb-1.5">Title</h3>
                    <p className="text-sm text-gray-600">{adData.title}</p>
                  </div>

                  <div>
                    <h3 className="text-sm font-bold text-gray-900 mb-1.5">Description</h3>
                    <p className="text-sm text-gray-600 leading-relaxed">{adData.description || "—"}</p>
                  </div>

                  <div>
                    <h3 className="text-sm font-bold text-gray-900 mb-1.5">Pause Note</h3>
                    <p className="text-sm text-gray-600">{adData.pauseNote || "—"}</p>
                  </div>

                  {adData.imageUrl && (
                    <div>
                      <h3 className="text-sm font-bold text-gray-900 mb-1.5">Media</h3>
                      {adData.imageUrl && (
                        <img src={adData.imageUrl} alt={adData.title} className="w-full rounded-lg object-cover max-h-56" />
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>

            <Card className="bg-white shadow-sm border border-gray-100">
              <CardContent className="p-4 space-y-2">
                <h3 className="text-sm font-bold text-gray-900">Payment</h3>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Status</span>
                  <span className="font-medium text-gray-900">{adData.paymentStatus || "—"}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Rate</span>
                  <span className="font-medium text-gray-900">
                    {adData.billable && Number(adData.adCommissionPercentage) > 0
                      ? `${adData.adCommissionPercentage}% of daily earning`
                      : "Free"}
                  </span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">Charged so far</span>
                  <span className="font-bold text-red-600">
                    ₹{Number(adData.chargedTotal || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    <span className="font-normal text-gray-500"> ({adData.chargedDays || 0} day{adData.chargedDays === 1 ? "" : "s"})</span>
                  </span>
                </div>
              </CardContent>
            </Card>

            {adData.billable && <AdChargesLedger adId={adData.id} title="Day-wise charges for this ad" />}

            <Button
              onClick={() => navigate(`/food/restaurant/advertisements/${adData.id}/edit`)}
              className="w-full bg-[#FF0000] hover:bg-[#E60000] text-white font-semibold py-3 rounded-lg"
            >
              <Edit className="w-4 h-4 mr-2" />
              Edit Advertisement
            </Button>
          </>
        )}
      </div>

      <div className="lg:hidden">
        <BottomNavOrders />
      </div>
    </div>
  )
}
