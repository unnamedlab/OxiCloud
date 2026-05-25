# Plan: User Avatar / Image Support

## Context

Users need to be able to set a profile photo (avatar). The image must:
- Be stored as a URL (`https://…`, `http://…`) or data URI (`data:image/(png|webp|jpeg);base64,…`)
- Match the CardDAV `PHOTO` format so the system address book exports it correctly
- Be editable **only** for local (username+password) accounts
- Be **synced automatically from OIDC** `picture` claim on every login for OIDC accounts
- Surface in `userVignette` components (owner column, ShareModal member rows)

Currently: no `image` column on `auth.users`, no `picture` claim extraction in OIDC, profile page shows initials only, `user_to_contact()` hardcodes `photo_url: None`.

---

## Execution order

### 1. DB Migration
**New file:** `migrations/20260526000000_add_user_image.sql`
```sql
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS image TEXT;
```

---

### 2. Domain Entity
**`src/domain/entities/user.rs`**
- Add `image: Option<String>` field
- `User::new()` and `User::new_oidc()` — initialise to `None`
- Add getter `pub fn image(&self) -> Option<&str>`
- Add setter `pub fn set_image(&mut self, image: Option<String>)`
- Add owned getter for persistence `pub fn image_owned(&self) -> Option<String>`

---

### 3. User Repository
**`src/infrastructure/repositories/pg/user_pg_repository.rs`**
- Add `image` to every `SELECT` that builds a `User` (row-mapper)
- Extend the `UPDATE` SQL in `update_user()` to include `image = $11`
- Add dedicated: `async fn update_image(&self, user_id: Uuid, image: Option<String>) -> Result<(), DomainError>`

---

### 4. OIDC: extract `picture` claim
**`src/application/ports/auth_ports.rs`**
- Add `pub picture: Option<String>` to `OidcIdClaims`

**`src/infrastructure/services/oidc_service.rs`**
- Add `picture: Option<String>` to both `IdTokenClaims` and `UserInfoResponse` structs
- Pass `picture` into the returned `OidcIdClaims`

**`src/application/services/auth_application_service.rs`** — in `oidc_callback()`:
- **Create path**: pass `claims.picture` to `User::new_oidc()`  
  (or call `user.set_image(claims.picture.clone())` before persisting)
- **Update path**: always call `user.set_image(claims.picture.clone())` then persist  
  (OIDC image is always authoritative — overwrite even if user had set one before)

---

### 5. User DTO
**`src/application/dtos/user_dto.rs`**
Add two fields to `UserDto`:
```rust
pub image: Option<String>,
pub can_edit_image: bool,   // true iff !user.is_oidc_user()
```
Populate in `UserDto::from(user)`.

---

### 6. Validation helper (shared)
In the auth application service (or a small `validation.rs` module in `src/common/`):
```rust
fn validate_image_url(image: &str) -> bool {
    image.starts_with("https://")
    || image.starts_with("http://")
    || image.starts_with("data:image/png;base64,")
    || image.starts_with("data:image/webp;base64,")
    || image.starts_with("data:image/jpeg;base64,")
}
```
Max length for data URIs: **10 KB** (10 608 bytes) to prevent DB abuse — a 1à4×104 WebP at quality 0.85 is well under this; a raw PNG could exceed it so the client must resize/compress first.

---

### 7. Auth Application Service — new method
**`src/application/services/auth_application_service.rs`**
```rust
pub async fn update_user_image(
    &self,
    caller_id: Uuid,
    image: Option<String>,
) -> Result<(), AppError>
```
Logic:
1. Load user from repository
2. If `user.is_oidc_user()` → return `AppError::Forbidden`
3. If `image.is_some()` → validate format + length; return `AppError::Validation` if invalid
4. Call `user_repository.update_image(caller_id, image).await`

---

### 8. Auth Handler + Route
**`src/interfaces/api/handlers/auth_handler.rs`**

New DTO (inline or in a dto file):
```rust
#[derive(Deserialize)]
pub struct UpdateUserImageDto {
    pub image: Option<String>, // None = clear the image
}
```

New handler `update_user_image` — pattern mirrors `change_password`:
- Extract `CurrentUserId`, JSON body
- Call service method
- Map `AppError::Forbidden` → 403, `AppError::Validation` → 422, else 200

**`src/interfaces/api/routes.rs`** — in `auth_protected_routes()`:
```rust
.route("/me/image", put(update_user_image))
```

---

### 9. System Address Book
**`src/interfaces/api/handlers/contacts_handler.rs`** — `user_to_contact()`:
```rust
photo_url: user.image.clone(),  // was: None
```

---

### 10. Frontend — `systemUsers.js`
**`static/js/model/systemUsers.js`**
- Add `let _photoIndex = null;` (`Map<string, string|null>`)
- In `_ensureIndex()`: build `_photoIndex` from `c.photo_url` alongside the name map
- Inject current user's photo from `localStorage.getItem('oxicloud_user')?.image`
- Add `async function getPhoto(userId): Promise<string|null>`
- Export `{ prefetch, getDisplayName, getPhoto, isAvailable }`

---

### 11. Frontend — `userVignette.js`
**`static/js/components/userVignette.js`**

In `createUserVignette(userId, size)`:
- After async name resolves, also await `systemUsers.getPhoto(userId)`
- If photo URL is truthy: replace the initials text with `<img src="…" alt="…">` inside `user-vignette__avatar`
- Wire `onerror` on the img to fall back to initials (guard against broken URLs)

CSS addition in `userVignette.css`:
```css
.user-vignette__avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 50%;
    display: block;
}
```

---

### 12. Frontend — User Menu (top-right)
**`static/js/app/userMenu.js`** — `updateUserMenuData()`:
- Read `user.image` from the stored `oxicloud_user` in localStorage
- `#user-avatar` (38 px circle): if `user.image` is set, replace inner HTML with `<img src="…" alt="…">` instead of initials text; wire `onerror` fallback to initials
- `#user-menu-avatar` (48 px circle in dropdown): same treatment
- When `profile.js` saves a new image successfully, it must also refresh the stored `oxicloud_user` in localStorage (re-fetch `/api/auth/me` and update) then call `updateUserMenuData()`

**`static/css/components/userMenu.css`** — add inside the file:
```css
.user-avatar img,
.user-menu-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 50%;
    display: block;
}
```

---

### 13. Frontend — Image resize helper (new shared utility)
**`static/js/utils/imageResize.js`** — new file

```js
/**
 * Load a File/Blob as an Image, draw it on a Canvas, resize to fit within
 * MAX_SIZE × MAX_SIZE, and return a data URI.
 *
 * @param {File} file
 * @param {number} [maxSize=102]
 * @returns {Promise<string>}   data:image/webp;base64,…  (or jpeg fallback)
 */
export async function resizeImageToDataUrl(file, maxSize = 104)
```

Logic:
1. Read file with `FileReader` → data URL
2. Create `<img>` element and wait for `onload`
3. Compute output dimensions: scale down proportionally if either dimension > `maxSize`; never scale up
4. Draw onto `OffscreenCanvas` (or regular `<canvas>`) at the computed size
5. Export with `canvas.toBlob('image/webp', 0.85)` (fallback to `image/jpeg` if WebP not supported)
6. Convert Blob → base64 data URI via `FileReader`

Accepts only MIME types: `image/png`, `image/webp`, `image/jpeg` — reject others with a thrown `Error`.

---

### 14. Frontend — Profile Page
**`static/profile.html`**
- Make `#p-avatar` support both `<img>` and initials text
- Add edit button (pencil icon) visible only when `user.can_edit_image === true`
- Add collapsible edit panel with **two input modes** (tabs or toggle):
  - **URL tab**: `<input type="url" id="p-image-url" placeholder="https://…">` with validation hint
  - **Upload tab**: `<input type="file" id="p-image-file" accept="image/png,image/jpeg,image/webp">` + live preview thumbnail
- Save / Cancel / Remove (clear) buttons

**`static/js/views/profile/profile.js`**

*Display:*
- If `user.image`: set `#p-avatar` to `<img src="…">` (with `onerror` → initials fallback)
- If `user.can_edit_image`: show edit pencil
- For OIDC users: show photo if `user.image` set; show "Managed by your identity provider" note; no edit controls

*URL mode save:*
- Validate prefix client-side (`https://`, `http://`, `data:image/…;base64,`)
- `PUT /api/auth/me/image` with `{ image: url || null }`

*Upload mode save:*
- On file selection: call `resizeImageToDataUrl(file, 104)` from the new utility
- Show preview in a `<img id="p-image-preview">` (hidden until file chosen)
- On Save: send resulting data URI via `PUT /api/auth/me/image` with `{ image: dataUri }`
- Show progress indicator during resize + upload (data URIs for a 104×104 WebP are ~2-5 kB)

*After successful save (both modes):*
- Re-fetch `/api/auth/me`, update `oxicloud_user` in localStorage
- Call `updateUserMenuData()` to refresh top-right avatar immediately
- Collapse the edit panel and update `#p-avatar` in-place

---

## Files to modify / create

| File | Action |
|---|---|
| `migrations/20260526000000_add_user_image.sql` | **CREATE** |
| `src/domain/entities/user.rs` | add `image` field + getter/setter |
| `src/infrastructure/repositories/pg/user_pg_repository.rs` | add to SELECT/UPDATE + `update_image()` |
| `src/application/ports/auth_ports.rs` | add `picture` to `OidcIdClaims` |
| `src/infrastructure/services/oidc_service.rs` | add `picture` to claims structs |
| `src/application/services/auth_application_service.rs` | OIDC sync + `update_user_image()` |
| `src/application/dtos/user_dto.rs` | add `image`, `can_edit_image` |
| `src/interfaces/api/handlers/auth_handler.rs` | `update_user_image` handler |
| `src/interfaces/api/routes.rs` | register `PUT /auth/me/image` |
| `src/interfaces/api/handlers/contacts_handler.rs` | `user_to_contact()` maps `image` → `photo_url` |
| `static/js/model/systemUsers.js` | add `_photoIndex`, `getPhoto()` |
| `static/js/components/userVignette.js` | render `<img>` when photo available |
| `static/css/components/userVignette.css` | add `img` rule inside avatar |
| `static/js/utils/imageResize.js` | **CREATE** — Canvas resize → WebP/JPEG data URI |
| `static/profile.html` | avatar image + URL input + file upload + preview |
| `static/js/views/profile/profile.js` | photo display + URL/upload edit flow + post-save menu refresh |
| `static/js/app/userMenu.js` | render `<img>` in both avatar circles when `user.image` present |
| `static/css/components/userMenu.css` | add `img` cover rule for `.user-avatar` and `.user-menu-avatar` |

---

## Verification

```bash
# Backend
cargo fmt --all
cargo clippy --all-features --all-targets -- -D warnings
cargo test

# Frontend
biome lint static/js/
tsc -p jsconfig.json --noEmit
stylelint static/css/
```

**Smoke tests:**
1. Local user → profile page → edit image → paste `https://example.com/me.jpg` → Save → avatar shows photo
2. Local user → paste `data:image/png;base64,…` → Save → works
3. Local user → paste invalid string → Save → 422 error shown
4. Local user → clear image (empty) → Save → avatar reverts to initials
5. OIDC user → `picture` claim present → after login, `GET /api/auth/me` returns `image` → profile shows photo, no edit button
6. OIDC user → `picture` claim absent → `image` is null → profile shows initials
7. SharedWithMe owner column → users with photos show `<img>`, others show initials
8. ShareModal People section → member avatars show photos where available
9. CardDAV client sync → system address book contact has `PHOTO` property set
10. After saving a photo on the profile page → top-right avatar button and dropdown header both update immediately without a page reload
11. Upload a large PNG (e.g. 2000×2000) → client resizes to 104×104 WebP, preview appears, Save sends data URI, backend accepts (< 10 KB)
12. Upload a 300×300 image → client does NOT upscale, stores at original dimensions
13. Upload a non-image file (PDF) → rejected client-side before any network call
