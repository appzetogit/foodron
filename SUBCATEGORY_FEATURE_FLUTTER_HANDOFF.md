# Subcategory feature — Flutter handoff

A new, fully **optional** layer called **Subcategory** now sits under Category. A category
can have zero or more subcategories. When a category has subcategories, picking one is
required when adding a food under that category; when a category has none, nothing changes
— behave exactly as before.

This doc only covers API/data contract changes needed in the **User app** and
**Restaurant app**. Admin panel and backend are already live and tested in production.

---

## 1. Restaurant app — adding/editing a food item

### Category list response now includes subcategories

`GET /food/restaurant/categories` (and the admin equivalent used when an admin adds food on
a restaurant's behalf) now returns a `subCategories` array on every category object:

```json
{
  "id": "664f...",
  "name": "Pizza",
  "foodTypeScope": "Veg",
  "isGlobal": false,
  "subCategories": [
    { "id": "664a...", "name": "Thin Crust", "approvalStatus": "approved", "sortOrder": 1 },
    { "id": "664b...", "name": "Deep Dish",  "approvalStatus": "approved", "sortOrder": 2 }
  ]
}
```

- `subCategories` is always an array (possibly empty). **Empty array = this category has no
  subcategories, nothing to do.**
- Only `approved` subcategories should be shown/selectable in the picker (the field is
  included for completeness/debugging, filtering is optional since the backend already
  only returns active ones here).

### What the UI needs to do

After the restaurant picks a **Category**:
- If `subCategories.length > 0`: show a second picker (dropdown/bottom-sheet) for
  **Subcategory**, listing `subCategories[].name`. **Selecting one is required** before the
  food can be saved.
- If `subCategories.length === 0`: show nothing extra. Food can be saved with category alone,
  exactly like today.
- If the restaurant changes the selected Category, **reset/clear** the previously selected
  Subcategory (it belonged to the old category).

### Create/update food request body — two new optional fields

`POST /food/restaurant/foods` and `PATCH /food/restaurant/foods/:id` (and the admin
equivalents `POST /food/admin/foods` / `PATCH /food/admin/foods/:id`) now accept:

```json
{
  "categoryId": "664f...",
  "subCategoryId": "664a...",      // NEW — the FoodSubCategory _id the user picked
  // ...rest of the existing food fields unchanged
}
```

- `subCategoryId` is optional. Omit it (or send `null`) when the category has no
  subcategories.
- If the selected category **does** have subcategories and `subCategoryId` is omitted, the
  backend rejects the request with a 400 and message:
  `"This category has subcategories — please select one"`. Surface that message to the user.
- `subCategoryName` is also accepted (resolved by exact case-insensitive name match) if your
  flow prefers sending a name instead of an id, but **id is strongly preferred** — it's
  unambiguous and faster.
- The response food object now includes `subCategoryId` and `subCategoryName` (denormalized,
  same pattern as the existing `categoryId`/`categoryName`). Use these to pre-fill the
  subcategory picker when editing an existing food.

### Validation error to handle

If a food is submitted with a `categoryId` that currently has subcategories but no
`subCategoryId` was sent, the API responds:

```json
{ "success": false, "message": "This category has subcategories — please select one" }
```

Treat this like any other validation error already shown in a toast/snackbar.

---

## 2. Restaurant app — creating a category (restaurant's own)

`POST /food/restaurant/categories` and `PATCH /food/restaurant/categories/:id` now accept an
optional `subCategoryNames` array of plain strings:

```json
{
  "name": "Pizza",
  "foodTypeScope": "Veg",
  "subCategoryNames": ["Thin Crust", "Deep Dish"]
}
```

- Completely optional — omit it (or send `[]`) if the restaurant doesn't want subcategories
  for this category.
- This is a **full replace** on update: send the complete current list of subcategory names
  every time you update, not just the diff. The backend will create new ones, keep existing
  ones whose name is unchanged, and delete ones you removed (detaching any food that was
  using a removed subcategory — food stays, it just loses its subcategory tag).
- Restaurant-created subcategories go through the **same pending → admin-approval workflow**
  as the category itself. They become usable only after admin approves the category (which
  approves all its subcategories together in one action).
- If you want a simple "+ Add another" UI for this, mirror whatever UI pattern you already
  have for adding multiple variants/sizes — it's the same shape (array of text inputs).

---

## 3. Restaurant app — food list / filter screen

If your Flutter restaurant app has a category filter on the food list screen, consider
adding a second-level Subcategory filter, scoped to whichever category is currently
selected. This is **optional / nice-to-have**, not required for correctness — the web
restaurant panel added this filter, but it's a pure UX improvement, not a data requirement.

---

## 4. User app — menu display (likely needs ZERO changes)

The menu endpoint restaurants/users already call to render a restaurant's menu
(`GET /food/restaurant/:id/menu` — public approved menu) now returns real data in the
`subsections` field of each category section, where it previously was always an empty array:

```json
{
  "sections": [
    {
      "id": "664f...",
      "categoryId": "664f...",
      "name": "Pizza",
      "itemCount": 5,
      "items": [ /* foods with NO subcategory, shown directly under this category */ ],
      "subsections": [
        {
          "id": "664a...",
          "subCategoryId": "664a...",
          "name": "Thin Crust",
          "itemCount": 2,
          "items": [ /* foods in this subcategory */ ]
        },
        {
          "id": "664b...",
          "subCategoryId": "664b...",
          "name": "Deep Dish",
          "itemCount": 3,
          "items": [ /* foods in this subcategory */ ]
        }
      ]
    }
  ]
}
```

**If your Flutter user app already ignores/doesn't render `subsections` (treats menu as a
flat list of items per category), no change is required right now** — all items still also
appear correctly, just grouped; nothing is lost, you simply won't show the subcategory
grouping visually until you choose to add it.

**If you do want to show it** (recommended, since this feature exists specifically so
customers can browse by subcategory — e.g. "Pizza → Thin Crust / Deep Dish"):
- For each category section, render `section.items` first (foods with no subcategory —
  directly under the category).
- Then render each entry in `section.subsections` as a collapsible sub-group with its own
  heading (`subsection.name`) and its own items (`subsection.items`), same visual pattern as
  the category itself, just nested one level in.
- Each food item inside `items`/`subsections[].items` now also carries `subCategoryId` and
  `subCategoryName` directly on the item object, in case you want to group client-side
  instead of relying on the server-provided `subsections` structure.

---

## Summary of new/changed fields (quick reference)

| Endpoint | Field | Type | Required? |
|---|---|---|---|
| `GET .../categories` (any variant) | `subCategories` | `[{id, name, approvalStatus, sortOrder}]` | Always present (possibly empty array) |
| `POST/PATCH .../foods` | `subCategoryId` | string (ObjectId) | Required only if the selected category has subcategories |
| `POST/PATCH .../foods` | `subCategoryName` | string | Optional alternative to `subCategoryId` |
| Food object in any response | `subCategoryId` / `subCategoryName` | string / string | Present, `null`/`""` when not set |
| `POST/PATCH .../categories` (restaurant) | `subCategoryNames` | `string[]` | Optional, full-replace semantics |
| `GET .../menu` (public) | `section.subsections` | array (see shape above) | Always present (possibly empty array) |

No breaking changes — every new field is additive and optional. Existing app versions that
ignore these fields will continue to work exactly as before.
