# Driver order-decline reason — Flutter handoff

When a delivery partner (driver) is offered an order and taps "decline"/"pass", they
should now pick a reason before the decline goes through. The web driver panel already
has this; the Flutter driver app needs the same.

---

## What was broken before

Previously, declining an incoming order offer only cleared it from the driver's local
screen — it never told the backend. The order offer stayed alive server-side until it
naturally timed out, which delayed re-dispatch to another driver. This has been fixed on
the web panel by actually calling the reject endpoint; the Flutter app needs to do the
same if it has the same gap (check whether your current "decline" button calls
`PATCH /food/delivery/orders/:orderId/reject` at all — if not, this is the fix to make).

---

## Submit payload

```
PATCH /food/delivery/orders/:orderId/reject
Authorization: Bearer <driver token>
Content-Type: application/json

{ "reason": "Too far from my location" }
```

- `reason` is **optional** but should always be sent when the driver actively taps
  decline (as opposed to the offer timing out on its own — see below).
- If the driver picks one of the fixed reasons, send that exact string.
- If the driver picks "Other", send whatever free text they typed (trimmed), **not**
  the literal word "Other".
- Max length is 300 characters — truncate client-side if needed, though in practice a
  short reason is expected.

### When the offer times out on its own (driver didn't respond)
Do **not** call the reject endpoint for a timeout — that's a separate, automatic
server-side process (a background job detects no response and re-dispatches on its
own). Only call `/reject` when the driver explicitly taps "decline"/"pass".

---

## UI to add
When the driver taps "Pass"/"Decline" on an incoming order offer, show a bottom
sheet/dialog with:
1. Four fixed reasons (match the web panel's wording, or adapt to your own if you
   prefer — these aren't enforced server-side, it's free text):
   - "Too far from my location"
   - "Vehicle/bike issue"
   - "Already have another order"
   - "Payout too low"
2. A 5th option, "Other", which reveals a text input. Require non-empty text before
   enabling the confirm button.
3. On confirm: call the endpoint above with the chosen/typed reason, then dismiss the
   offer locally exactly as before (clear the incoming-order state, stop the
   ringtone/countdown, etc.) — don't block the UI waiting for the API response; fire it
   and continue dismissing immediately (best-effort — if the call fails, log it, don't
   show an error to the driver, since the offer timing out naturally is a safe
   fallback).

No response body change — the existing 200 success response shape is unchanged.

---

## What this unlocks for admin (no Flutter-side effect, context only)
Admin now has a "Order Decline Stats" page showing, per driver, how many order offers
they've declined and the exact reasons given, pulled from this new `reason` field. This
only works for declines that actually go through this endpoint — so the more complete
your Flutter wiring, the more useful this data is for admin.
