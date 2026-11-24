import { useState, useEffect, useRef, useMemo } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { MapPin, ArrowLeft, Save, X, Shapes, Trash2, Edit } from "lucide-react"
import { adminAPI } from "@food/api"
import { getGoogleMapsApiKey } from "@food/utils/googleMapsApiKey"
import { computePolygonAreaKm2, formatAreaValue } from "../../../../../shared/utils/zoneCoverage"
import { loadGoogleMaps as loadGoogleMapsSdk } from "@core/services/googleMapsLoader"
const debugError = (...args) => {}

const MIN_POINTS = 3

// Same radial ordering used by AddZone.jsx — keeps every clicked point, never self-intersects.
const orderPointsRadially = (pts) => {
  const points = pts
    .map((p) => ({
      lat: typeof p.lat === "function" ? p.lat() : p.lat,
      lng: typeof p.lng === "function" ? p.lng() : p.lng,
    }))
    .filter((p) => typeof p.lat === "number" && typeof p.lng === "number")

  if (points.length < 3) return points

  const cx = points.reduce((s, p) => s + p.lng, 0) / points.length
  const cy = points.reduce((s, p) => s + p.lat, 0) / points.length

  return [...points].sort(
    (a, b) => Math.atan2(a.lat - cy, a.lng - cx) - Math.atan2(b.lat - cy, b.lng - cx)
  )
}

const AREA_COLORS = ["#16a34a", "#ea580c", "#0ea5e9", "#db2777", "#7c3aed", "#ca8a04", "#059669", "#dc2626"]

export default function ServiceAreaSetup() {
  const navigate = useNavigate()
  const { zoneId } = useParams()
  const mapRef = useRef(null)
  const mapInstanceRef = useRef(null)
  const zonePolygonRef = useRef(null)
  const drawPolygonRef = useRef(null)
  const drawPolylineRef = useRef(null)
  const pathMarkersRef = useRef([])
  const savedAreaPolygonsRef = useRef([])
  const mapClickListenerRef = useRef(null)
  const drawPointsRef = useRef([])
  const isDrawingRef = useRef(false)

  const [mapLoading, setMapLoading] = useState(true)
  const [mapError, setMapError] = useState("")
  const [zone, setZone] = useState(null)
  const [serviceAreas, setServiceAreas] = useState([])
  const [loading, setLoading] = useState(false)
  const [isDrawing, setIsDrawing] = useState(false)
  const [coordinates, setCoordinates] = useState([])
  const [areaName, setAreaName] = useState("")
  const [editingAreaId, setEditingAreaId] = useState(null)

  const coverageAreaKm2 = useMemo(() => computePolygonAreaKm2(coordinates), [coordinates])
  const coverageLabel = formatAreaValue(coverageAreaKm2, "kilometer")

  useEffect(() => {
    fetchZone()
    fetchServiceAreas()
    loadGoogleMaps()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoneId])

  useEffect(() => {
    return () => {
      const google = window.google
      if (google && mapClickListenerRef.current) {
        google.maps.event.removeListener(mapClickListenerRef.current)
      }
      drawPolygonRef.current?.setMap(null)
      drawPolylineRef.current?.setMap(null)
      pathMarkersRef.current?.forEach((m) => m.setMap(null))
      savedAreaPolygonsRef.current?.forEach((p) => p?.setMap(null))
      zonePolygonRef.current?.setMap(null)
    }
  }, [])

  const fetchZone = async () => {
    try {
      const response = await adminAPI.getZoneById(zoneId)
      if (response.data?.success && response.data.data?.zone) {
        setZone(response.data.data.zone)
      }
    } catch (error) {
      debugError("Error fetching zone:", error)
      alert("Failed to load zone")
      navigate("/admin/food/zone-setup")
    }
  }

  const fetchServiceAreas = async () => {
    try {
      const response = await adminAPI.getServiceAreas({ zoneId, limit: 1000 })
      if (response.data?.success && response.data.data?.serviceAreas) {
        setServiceAreas(response.data.data.serviceAreas)
      }
    } catch (error) {
      debugError("Error fetching service areas:", error)
      setServiceAreas([])
    }
  }

  const loadGoogleMaps = async () => {
    try {
      setMapError("")
      const apiKey = await getGoogleMapsApiKey()
      if (!apiKey) {
        setMapError("Google Maps API key not found")
        setMapLoading(false)
        return
      }
      await loadGoogleMapsSdk(apiKey)
      initializeMap(window.google)
    } catch (error) {
      debugError("Error loading Google Maps:", error)
      setMapError("Unable to load Google Maps SDK. Please verify API key and network.")
      setMapLoading(false)
    }
  }

  const initializeMap = (google) => {
    if (!mapRef.current) return
    const map = new google.maps.Map(mapRef.current, {
      center: { lat: 20.5937, lng: 78.9629 },
      zoom: 5,
      clickableIcons: false,
      mapTypeControl: true,
      mapTypeControlOptions: {
        style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
        position: google.maps.ControlPosition.TOP_RIGHT,
        mapTypeIds: [google.maps.MapTypeId.ROADMAP, google.maps.MapTypeId.SATELLITE],
      },
      zoomControl: true,
      streetViewControl: false,
      fullscreenControl: true,
      scrollwheel: true,
      gestureHandling: "greedy",
    })
    mapInstanceRef.current = map

    mapClickListenerRef.current = google.maps.event.addListener(map, "click", (event) => {
      if (!isDrawingRef.current) return
      drawPointsRef.current.push(event.latLng)
      renderDrawingPreview(google, map)
    })

    setMapLoading(false)
  }

  // Draw the parent zone polygon (fixed, gray, non-editable background reference) once
  // the map and zone data are both ready.
  useEffect(() => {
    if (mapLoading || !zone?.coordinates?.length || !window.google || !mapInstanceRef.current) return
    const google = window.google
    const map = mapInstanceRef.current

    zonePolygonRef.current?.setMap(null)
    const path = zone.coordinates
      .map((c) => new google.maps.LatLng(c.latitude, c.longitude))
      .filter(Boolean)
    if (path.length < 3) return

    const polygon = new google.maps.Polygon({
      paths: path,
      strokeColor: "#475569",
      strokeOpacity: 0.8,
      strokeWeight: 2,
      fillColor: "#475569",
      fillOpacity: 0.05,
      clickable: false,
      zIndex: 0,
    })
    polygon.setMap(map)
    zonePolygonRef.current = polygon

    const bounds = new google.maps.LatLngBounds()
    path.forEach((p) => bounds.extend(p))
    map.fitBounds(bounds)
  }, [zone, mapLoading])

  // Draw already-saved service area polygons (colored, non-editable reference, one per area).
  useEffect(() => {
    if (mapLoading || !window.google || !mapInstanceRef.current) return
    const google = window.google
    const map = mapInstanceRef.current

    savedAreaPolygonsRef.current.forEach((p) => p?.setMap(null))
    savedAreaPolygonsRef.current = []

    serviceAreas.forEach((area, idx) => {
      if (editingAreaId && String(area._id || area.id) === String(editingAreaId)) return
      if (!area.coordinates?.length) return
      const path = area.coordinates.map((c) => new google.maps.LatLng(c.latitude, c.longitude))
      if (path.length < 3) return
      const color = AREA_COLORS[idx % AREA_COLORS.length]
      const polygon = new google.maps.Polygon({
        paths: path,
        strokeColor: color,
        strokeOpacity: 0.8,
        strokeWeight: 2,
        fillColor: color,
        fillOpacity: 0.2,
        clickable: false,
        zIndex: 1,
      })
      polygon.setMap(map)
      savedAreaPolygonsRef.current.push(polygon)
    })
  }, [serviceAreas, mapLoading, editingAreaId])

  const renderVertexMarkers = (google, map, latLngs) => {
    pathMarkersRef.current?.forEach((m) => m.setMap(null))
    pathMarkersRef.current = latLngs.map(
      (latLng, i) =>
        new google.maps.Marker({
          position: latLng,
          map,
          clickable: false,
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: "#9333ea",
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 2,
          },
          zIndex: 1000,
          title: `Point ${i + 1}`,
        })
    )
  }

  const renderDrawingPreview = (google, map) => {
    const points = drawPointsRef.current
    drawPolygonRef.current?.setMap(null)
    drawPolygonRef.current = null
    drawPolylineRef.current?.setMap(null)
    drawPolylineRef.current = null

    const path = points.map((p) => ({ lat: p.lat(), lng: p.lng() }))
    const orderedPath = path.length >= MIN_POINTS ? orderPointsRadially(points) : path

    if (path.length >= MIN_POINTS) {
      drawPolygonRef.current = new google.maps.Polygon({
        paths: orderedPath,
        strokeColor: "#9333ea",
        strokeWeight: 2,
        fillColor: "#9333ea",
        fillOpacity: 0.15,
        clickable: false,
        zIndex: 2,
      })
      drawPolygonRef.current.setMap(map)
    } else if (path.length >= 2) {
      drawPolylineRef.current = new google.maps.Polyline({
        path,
        strokeColor: "#9333ea",
        strokeWeight: 2,
        clickable: false,
        zIndex: 2,
      })
      drawPolylineRef.current.setMap(map)
    }

    renderVertexMarkers(google, map, points)
    setCoordinates(
      orderedPath.map((p) => ({
        latitude: parseFloat(p.lat.toFixed(6)),
        longitude: parseFloat(p.lng.toFixed(6)),
      }))
    )
  }

  const clearActiveDrawing = () => {
    drawPointsRef.current = []
    drawPolygonRef.current?.setMap(null)
    drawPolygonRef.current = null
    drawPolylineRef.current?.setMap(null)
    drawPolylineRef.current = null
    pathMarkersRef.current?.forEach((m) => m.setMap(null))
    pathMarkersRef.current = []
  }

  const resetForm = () => {
    clearActiveDrawing()
    setCoordinates([])
    setAreaName("")
    setEditingAreaId(null)
  }

  const toggleDrawingMode = () => {
    const google = window.google
    const map = mapInstanceRef.current
    if (!google || !map) {
      alert("Map is still loading.")
      return
    }
    if (isDrawing) {
      if (drawPointsRef.current.length < MIN_POINTS) {
        alert(`Please click at least ${MIN_POINTS} points on the map.`)
        return
      }
      isDrawingRef.current = false
      setIsDrawing(false)
      map.setOptions({ draggableCursor: null })
    } else {
      resetForm()
      isDrawingRef.current = true
      setIsDrawing(true)
      map.setOptions({ draggableCursor: "crosshair" })
    }
  }

  const handleEditArea = (area) => {
    const google = window.google
    const map = mapInstanceRef.current
    if (!google || !map) return
    isDrawingRef.current = false
    setIsDrawing(false)
    clearActiveDrawing()

    setEditingAreaId(area._id || area.id)
    setAreaName(area.name || "")
    setCoordinates(area.coordinates || [])

    const path = (area.coordinates || []).map((c) => new google.maps.LatLng(c.latitude, c.longitude))
    drawPointsRef.current = path
    drawPolygonRef.current = new google.maps.Polygon({
      paths: path,
      strokeColor: "#9333ea",
      strokeWeight: 2,
      fillColor: "#9333ea",
      fillOpacity: 0.2,
      clickable: false,
      zIndex: 2,
    })
    drawPolygonRef.current.setMap(map)
    renderVertexMarkers(google, map, path)

    const bounds = new google.maps.LatLngBounds()
    path.forEach((p) => bounds.extend(p))
    map.fitBounds(bounds)
  }

  const handleDeleteArea = async (area) => {
    if (!window.confirm(`Delete service area "${area.name}"? Restaurants/drivers tagged with it keep their own data, only the tag is removed.`)) return
    try {
      await adminAPI.deleteServiceArea(area._id || area.id)
      if (editingAreaId === (area._id || area.id)) resetForm()
      fetchServiceAreas()
    } catch (error) {
      alert(error?.response?.data?.message || "Failed to delete service area")
    }
  }

  const handleSaveArea = async () => {
    if (!areaName.trim()) {
      alert("Please enter a service area name")
      return
    }
    if (coordinates.length < MIN_POINTS) {
      alert(`Please draw at least ${MIN_POINTS} points on the map`)
      return
    }
    try {
      setLoading(true)
      const payload = { zoneId, name: areaName.trim(), coordinates }
      if (editingAreaId) {
        const res = await adminAPI.updateServiceArea(editingAreaId, payload)
        if (res.data?.data?.error) throw new Error(res.data.data.error)
      } else {
        const res = await adminAPI.createServiceArea(payload)
        if (res.data?.data?.error) throw new Error(res.data.data.error)
      }
      resetForm()
      fetchServiceAreas()
    } catch (error) {
      alert(error?.response?.data?.message || error.message || "Failed to save service area")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="p-4 lg:p-6 max-w-7xl mx-auto">
        <div className="flex items-center gap-4 mb-6">
          <button
            onClick={() => navigate("/admin/food/zone-setup")}
            className="p-2 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-slate-600" />
          </button>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500 flex items-center justify-center">
              <MapPin className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">
                Service Areas — {zone?.name || "Loading…"}
              </h1>
              <p className="text-sm text-slate-600">
                Optional sub-areas inside this zone, used only to filter/report data. The zone's own
                operational flow (dispatch, orders) is unaffected.
              </p>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: form + list */}
          <div className="space-y-6">
            <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
              <h2 className="text-lg font-semibold text-slate-900 mb-4">
                {editingAreaId ? "Edit Service Area" : "Add Service Area"}
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">
                    Service Area Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={areaName}
                    onChange={(e) => setAreaName(e.target.value)}
                    placeholder="e.g. Vijay Nagar, Rajendra Nagar"
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={toggleDrawingMode}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                      isDrawing ? "bg-red-600 text-white hover:bg-red-700" : "bg-blue-600 text-white hover:bg-blue-700"
                    }`}
                  >
                    <Shapes className="w-4 h-4" />
                    <span>{isDrawing ? "Stop Drawing" : "Start Drawing"}</span>
                  </button>
                  {(coordinates.length > 0 || editingAreaId) && (
                    <button
                      type="button"
                      onClick={resetForm}
                      className="flex items-center gap-2 px-4 py-2 bg-slate-600 text-white rounded-lg hover:bg-slate-700 transition-colors"
                    >
                      <X className="w-4 h-4" />
                      <span>Clear</span>
                    </button>
                  )}
                </div>
                {isDrawing && (
                  <p className="text-xs text-slate-600">
                    Click inside the zone boundary (gray) to add points (minimum {MIN_POINTS}), then click{" "}
                    <strong>Stop Drawing</strong>.
                  </p>
                )}
                {coordinates.length > 0 && (
                  <p className="text-xs text-slate-600">
                    Points drawn: <strong>{coordinates.length}</strong>
                    {coverageLabel && (
                      <span className="ml-2">
                        · Coverage: <strong>{coverageLabel}</strong>
                      </span>
                    )}
                  </p>
                )}
                <button
                  type="button"
                  onClick={handleSaveArea}
                  disabled={loading || coordinates.length < MIN_POINTS || !areaName.trim()}
                  className="w-full flex items-center justify-center gap-2 px-6 py-2.5 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4" />
                      <span>{editingAreaId ? "Update Service Area" : "Save Service Area"}</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
              <h2 className="text-lg font-semibold text-slate-900 mb-4">
                Existing Service Areas ({serviceAreas.length})
              </h2>
              {serviceAreas.length === 0 ? (
                <p className="text-sm text-slate-500">No service areas yet. Draw one on the map.</p>
              ) : (
                <div className="space-y-2">
                  {serviceAreas.map((area, idx) => (
                    <div
                      key={area._id || area.id}
                      className="flex items-center justify-between p-3 border border-slate-200 rounded-lg"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="w-3 h-3 rounded-full shrink-0"
                          style={{ backgroundColor: AREA_COLORS[idx % AREA_COLORS.length] }}
                        />
                        <span className="text-sm font-medium text-slate-900">{area.name}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleEditArea(area)}
                          className="p-2 text-slate-600 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="Edit"
                        >
                          <Edit className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteArea(area)}
                          className="p-2 text-slate-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right: map */}
          <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-4">Zone Map</h2>
            <div className="relative" style={{ height: "600px" }}>
              <div ref={mapRef} className="w-full h-full rounded-lg" />
              {mapLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-100 rounded-lg">
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4" />
                    <p className="text-slate-600">Loading map...</p>
                  </div>
                </div>
              )}
              {mapError && !mapLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-100 rounded-lg">
                  <div className="text-center p-6">
                    <MapPin className="w-12 h-12 text-slate-400 mx-auto mb-4" />
                    <p className="text-sm text-slate-600">{mapError}</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
