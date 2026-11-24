# Restaurant order-reject reason + Regular Customers — Flutter handoff

Two independent, additive features for the **restaurant app**. Neither changes any
existing order flow, dispatch logic, or API contract that's already in use — both are
pure additions.

---

## 1. Order reject/decline reason

### What changed
When a restaurant rejects an incoming order, or cancels an order it already accepted,
it already picks a reason from a fixed list. That list now includes an **"Other reason"**
option that reveals a free-text box — whatever the restaurant types becomes the reason
sent to the backend.

### Submit payload — no new field, same as today
`PATCH /food/restaurant/orders/:orderId/status` already accepts:
```json
{
  "orderStatus": "cancelled_by_restaurant",
  "reason": "Kitchen flooded, cannot cook today"
}
```
`reason` is a **free-text string**, always was — no backend change was needed. If the
restaurant picks one of the fixed reasons (e.g. "Item not available"), send that exact
string as `reason`. If they pick "Other reason", send whatever they typed instead of the
literal text "Other reason".

### UI to add (if your Flutter reject/cancel screen doesn't have this yet)
- Show the fixed reason list (mirror whatever list the web app shows — e.g. "Restaurant
  is too busy", "Item not available", "Outside delivery area", "Kitchen closing soon",
  "Technical issue", "Other reason").
- When "Other reason" is selected, show a multi-line text input below the list. Require
  it to be non-empty before enabling the confirm button (same validation as the fixed
  list — you must have *a* reason, whether picked or typed).
- Send the typed text (trimmed) as `reason` instead of the literal "Other reason" string.

### Where the reason shows up afterward (already works, no Flutter change needed there)
- **Customer's order list/tracking**: already reads `order.cancellationReason` and
  `order.cancelledBy` to show "Cancelled by Restaurant — <reason>".
- **Restaurant's own order details**: already shows the reason under the
  "Rejection Reason" section.
- **Admin's order view**: already shows `cancellationReason` with a "Cancelled by
  Restaurant" prefix.

Since this was already free text end-to-end, a custom "Other reason" string just works —
no new fields, no new endpoints.

---

## 2. Regular/repeat customer flagging (restaurant-side)

### The rule
A customer becomes a **"regular customer"** for a specific restaurant once they place
their **6th non-cancelled order with that restaurant in the current calendar month**.
(5 completed orders qualify them; the flag/visibility starts showing from the 6th order
onward — nothing shows before that.) This resets every calendar month — it is **not** a
lifetime count.

Cancelled orders (by user, restaurant, admin, or system) never count toward the 5/6.

### New endpoint
```
GET /food/restaurant/customers/regular?page=1&limit=20
Authorization: Bearer <restaurant token>
```

Response:
```json
{
  "success": true,
  "message": "Regular customers retrieved",
  "data": {
    "data": [
      {
        "userId": "664a...",
        "name": "Rahul Sharma",
        "phone": "9876543210",
        "email": "rahul@example.com",
        "profileImage": "https://...",
        "monthlyOrderCount": 7,
        "lastOrderAt": "2026-11-20T10:15:00.000Z"
      }
    ],
    "meta": { "total": 1, "page": 1, "limit": 20, "totalPages": 1 },
    "pagination": { "page": 1, "limit": 20, "totalItems": 1, "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false }
  }
}
```

- `monthlyOrderCount` — how many non-cancelled orders this customer placed at this
  restaurant so far **this calendar month** (always ≥ 6 for anyone in this list).
- `lastOrderAt` — timestamp of their most recent order this month, for sorting/display.
- The list is **restaurant-scoped** — a restaurant only ever sees its own regular
  customers, never another restaurant's. The backend derives the restaurant from the
  authenticated token (no `restaurantId` param needed/accepted).
- Pagination works exactly like other list endpoints in the app (`page`, `limit`).
- If nobody has hit 6 orders yet this month, `data` is an empty array — show an empty
  state ("No regular customers yet this month").

### UI to add
A new screen, e.g. under the restaurant's "Explore More" / "Orders" menu, titled
**"Regular Customers"**. For each entry show:
- Name, phone (tap-to-call is a nice touch, not required)
- Profile image if present, otherwise a placeholder avatar
- Order count this month (e.g. "7 orders this month")
- Last order date

No action buttons are required on this screen — it's informational only (helps the
restaurant recognize and prioritize loyal customers, e.g. for a personal thank-you or
future loyalty perk — that's a business decision, not something this API enforces).

### What this is NOT
- Not a lifetime/all-time counter — it's strictly "this calendar month."
- Not a push notification or alert — the restaurant has to open the screen to see it.
- Not a discount/loyalty-program trigger — purely a visibility feature for now.
