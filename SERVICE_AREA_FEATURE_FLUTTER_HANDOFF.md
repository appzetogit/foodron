# Service Area feature — Flutter handoff

A new, **optional** layer called **Service Area** now exists inside a Zone. Admin draws one or
more named sub-polygons on the map inside an existing zone's boundary. This is **purely a
data-filtering/reporting tag** — it does **not** change how orders are dispatched, how a
restaurant's or driver's zone-based operational flow works, or anything else. Think of it as
a label: "this restaurant/driver is in Zone X, specifically in Service Area Y of that zone."

---

## 1. Restaurant app — onboarding (new restaurant signup)

### New field in the zone-selection step

After the restaurant picks a **Zone** (as before, unchanged), fetch the list of service areas
inside that zone:

```
GET /food/zones/:zoneId/service-areas/public
```

Response:
```json
{
  "success": true,
  "data": {
    "serviceAreas": [
      { "_id": "664a...", "name": "Vijay Nagar", "zoneId": "664f...", "coordinates": [...] },
      { "_id": "664b...", "name": "Rajendra Nagar", "zoneId": "664f...", "coordinates": [...] }
    ]
  }
}
```

- This is a **public, unauthenticated** endpoint (same auth level as the existing
  `GET /food/zones/public` zone list you already call during onboarding).
- If the array is empty, this zone has no service areas — **show nothing extra**, onboarding
  continues exactly as it does today (zone-only, no service area).
- If the restaurant changes the selected Zone, clear/reset the service area selection and
  refetch (service areas belong to exactly one zone).

### UI

- Show a second dropdown **"Service area (optional)"** right after the zone dropdown, only
  when `serviceAreas.length > 0`.
- It is never required — a restaurant can leave it unselected and onboarding works exactly as
  before.
- Draw the selected service area's polygon on the map **on top of** the zone polygon, in a
  different color (the web app uses green for service area vs. red for zone), so it's clear
  the pin must land inside the smaller shape, not just anywhere in the zone.
- If no service area is selected, pin validation stays exactly as it is today (anywhere
  inside the zone polygon).
- If a service area **is** selected, the pin must fall inside that polygon specifically — use
  the exact same point-in-polygon check you already do for the zone (no new library/API
  needed, it's the same geometry check against a different, smaller polygon).

### Submit payload — one new optional field

`POST /food/restaurant/register` (step 1 of onboarding, multipart form) now accepts:

```
serviceAreaId: "664a..."   // optional — omit or send empty string if none selected
```

alongside the existing `zoneId` field. If you select a service area but the pin ends up
outside it, the backend rejects with:

```json
{ "success": false, "message": "Selected address is outside the selected service area" }
```

Show this the same way you already show "Selected address is outside the selected zone" —
same error shape, just a different message string.

### Where the restaurant sees it afterward

The restaurant's own profile/account data (whatever endpoint you use to show "my restaurant
info") now includes:

```json
{
  "zoneId": "664f...",
  "zoneName": "Indore City",
  "serviceAreaId": "664a...",
  "serviceAreaName": "Vijay Nagar"
}
```

Show these two lines (Zone, Service Area) somewhere in the restaurant's outlet/business info
screen, the same place you'd show their address. `serviceAreaName` will be an empty string if
they didn't pick one — just hide that line in that case.

---

## 2. Delivery partner app — onboarding (new driver signup)

### Important: zone is now a required field for drivers (it wasn't before)

Previously, driver onboarding had no zone concept at all (only free-text city/address).
`POST /food/delivery/register` now **requires** a `zoneId`:

```
zoneId: "664f..."           // REQUIRED — new field
serviceAreaId: "664a..."    // optional, same as restaurant
```

If `zoneId` is missing, the backend rejects with:

```json
{ "success": false, "message": "Zone is required" }
```

**This is a data tag only** — it does **not** gate or change the dispatch flow in any way. A
driver still receives order offers for whatever zone their live GPS location is in, exactly as
today. The zone/service-area chosen at signup is purely so the admin panel can filter/report
"how many drivers do we have tagged to Zone X / Service Area Y," nothing else.

### UI for driver onboarding

- Add a **Zone** dropdown (required) — fetch the same `GET /food/zones/public` list already
  used elsewhere.
- Add a **Service area** dropdown (optional) — fetch
  `GET /food/zones/:zoneId/service-areas/public` once a zone is picked, same as the restaurant
  flow above. No pin/map validation needed for drivers (unlike restaurants, there's no address
  pin step in driver onboarding today) — it's just two plain dropdowns.

### Where the driver sees it afterward

The driver's own profile endpoint (`GET /food/auth/me` while authenticated as
`DELIVERY_PARTNER`, i.e. whatever you call for "my profile") now includes:

```json
{
  "zoneId": "664f...",
  "zoneName": "Indore City",
  "serviceAreaId": "664a...",
  "serviceAreaName": "Vijay Nagar"
}
```

Show these on the driver's profile screen (the web app shows it right under the driver's name,
alongside their city). `serviceAreaName` is empty if none was picked.

---

## 3. Admin-created restaurants/drivers (no Flutter work needed)

When admin manually adds a restaurant or driver from the web panel (not self-onboarding), the
same `zoneId`/`serviceAreaId` fields are now required there too, with the same containment
validation. This is admin-web-only — no Flutter changes needed for this part.

---

## Summary of new/changed fields (quick reference)

| Endpoint | Field | Type | Required? |
|---|---|---|---|
| `GET /food/zones/:zoneId/service-areas/public` | — | new endpoint | Public, no auth |
| `POST /food/restaurant/register` (step 1) | `serviceAreaId` | string (ObjectId) | Optional |
| `POST /food/delivery/register` | `zoneId` | string (ObjectId) | **Required (new)** |
| `POST /food/delivery/register` | `serviceAreaId` | string (ObjectId) | Optional |
| Restaurant profile response | `zoneName` / `serviceAreaId` / `serviceAreaName` | string | Present (empty if unset) |
| Delivery partner profile response | `zoneId` / `zoneName` / `serviceAreaId` / `serviceAreaName` | string | Present (empty/null if unset) |

The only **breaking** change for Flutter is the driver app: `zoneId` is now required at
registration, so the driver onboarding screen needs the new Zone dropdown added before this
ships to drivers, or new driver signups will start failing with "Zone is required." Everything
else is additive and optional.
