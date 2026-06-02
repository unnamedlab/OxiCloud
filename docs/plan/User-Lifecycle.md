# Plan — `UserLifecycleHook` + `is_external` flag

## Context

Today four code paths in `auth_application_service.rs` each call `create_personal_folder()` immediately after inserting an `auth.users` row: public `register`, `setup_create_admin`, admin `create_user`, and OIDC JIT (lines 283, 360, 832, 1277). A fifth self-heal at `folder_service.rs:350-365` retries home-folder creation when listing root folders returns empty. Five places, one concern, no shared abstraction — and adding a future service (calendar, address book, GPG keyring, external-user provenance for the upcoming magic-link feature) would have to touch all five again.

Separately, the upcoming "share with `external@example.com`" feature needs `auth.users` to distinguish recipients-with-no-storage from real internal users. The codebase already declares `Subject::External` (`domain/services/authorization.rs`) but no DB representation exists yet.

This plan introduces a `UserLifecycleHook` trait (mirroring the existing `FileLifecycleHook` / `BlobLifecycleHook` pattern at `application/ports/file_lifecycle.rs`), wires a dispatcher into the four lifecycle events, migrates the scattered eager work into services that own their own lifecycle (each implementing the trait with explicit no-ops for events they don't care about), and adds the `is_external` boolean to `auth.users` so hooks can short-circuit for non-internal users. The change is purely a refactor at first — behaviour is preserved — but it sets up the v2 external-user flow to land as a hook impl rather than a new auth code path.

## Design

### Trait shape

The trait diverges from `FileLifecycleHook`'s sync fire-and-forget model on purpose: file events fire on every upload (hot path, fire-and-forget appropriate); user events are rare (login is seconds-per-user, not requests-per-second) and some require synchronous semantics (provisioning must finish before the session token is returned; deletion cleanup must commit atomically with the user DELETE). The trait is async; the dispatcher decides per-event whether errors abort the flow.

```rust
// src/application/ports/user_lifecycle.rs (new)
#[async_trait]
pub trait UserLifecycleHook: Send + Sync {
    /// Short identifier used in tracing / error logs. e.g. "home_folder".
    fn name(&self) -> &'static str;

    /// Fires once after INSERT into auth.users succeeds, regardless of path.
    async fn on_user_created(&self, user: &User) -> Result<(), DomainError>;

    /// Fires after every successful authentication, before the session
    /// token is returned. MUST be idempotent (safety net for services
    /// added after the user existed).
    async fn on_user_login(&self, user: &User) -> Result<(), DomainError>;

    /// Fires on every session termination. `reason` lets hooks
    /// distinguish causes (audit cares; cache invalidation does not).
    async fn on_user_logout(&self, user: &User, reason: LogoutReason)
        -> Result<(), DomainError>;

    /// Fires inside the same transaction as the auth.users DELETE.
    /// Returning Err aborts the deletion. `mode` distinguishes admin
    /// delete (policy-driven cleanup) from GDPR purge (force everything).
    async fn on_user_deleted(
        &self,
        user: &User,
        mode: DeletionMode,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ) -> Result<(), DomainError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogoutReason {
    UserInitiated,    // explicit logout
    SessionExpired,   // TTL hit
    AdminRevoked,     // single-session revocation by admin
    AccountDisabled,  // user.active flipped to FALSE → all sessions revoked
    PasswordChanged,  // sibling sessions invalidated by a password change
    TokenReused,      // session-family reuse detection (existing feature)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeletionMode { AdminDelete, GdprPurge }
```

**No default impls.** Every hook must declare all four methods. Use explicit `Ok(())` for events you don't care about — matches the FileLifecycleHook convention and forces conscious acknowledgement.

### Dispatcher

```rust
// src/application/services/user_lifecycle_service.rs (new)
pub struct UserLifecycleService {
    hooks: Vec<Arc<dyn UserLifecycleHook>>,
}

impl UserLifecycleService {
    pub fn new() -> Self { Self { hooks: Vec::new() } }
    pub fn with_hook(mut self, hook: Arc<dyn UserLifecycleHook>) -> Self {
        self.hooks.push(hook); self
    }

    // Per-event dispatchers with event-specific failure semantics:

    /// Created: log-and-continue. Next login's `on_user_login` retries
    /// idempotently if anything fails here.
    pub async fn dispatch_created(&self, user: &User) {
        for h in &self.hooks {
            if let Err(e) = h.on_user_created(user).await {
                tracing::error!(target: "user_lifecycle",
                    hook = h.name(), user_id = %user.id(), error = %e,
                    "on_user_created failed; will retry on next login");
            }
        }
    }

    /// Login: log-and-continue. Same reasoning.
    pub async fn dispatch_login(&self, user: &User) { /* same shape */ }

    /// Logout: fire-and-forget (spawned), errors logged. The HTTP
    /// response shouldn't wait for cache flushes.
    pub fn dispatch_logout(&self, user: User, reason: LogoutReason) {
        let hooks = self.hooks.clone();
        tokio::spawn(async move {
            for h in &hooks {
                if let Err(e) = h.on_user_logout(&user, reason).await {
                    tracing::error!(target: "user_lifecycle",
                        hook = h.name(), reason = ?reason,
                        user_id = %user.id(), error = %e,
                        "on_user_logout failed");
                }
            }
        });
    }

    /// Deleted: propagate first Err to abort the transaction.
    pub async fn dispatch_deleted(
        &self,
        user: &User,
        mode: DeletionMode,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ) -> Result<(), DomainError> {
        for h in &self.hooks {
            h.on_user_deleted(user, mode, tx).await?;
        }
        Ok(())
    }
}
```

### `is_external` flag (additive migration)

New migration `migrations/20260612000002_auth_users_is_external.sql`:

```sql
-- Adds the is_external flag distinguishing storage-owning internal users
-- from grant-only external users (magic-link / OIDC-only / future OCM).
ALTER TABLE auth.users
    ADD COLUMN IF NOT EXISTS is_external BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index — most queries are "list internal users" or "list
-- external users for GDPR purge", never an unfiltered scan.
CREATE INDEX IF NOT EXISTS idx_users_is_external_login
    ON auth.users (is_external, last_login_at)
    WHERE is_external = TRUE;

-- Guard against accidental storage attribution to external users.
ALTER TABLE auth.users
    ADD CONSTRAINT users_external_no_storage
        CHECK (NOT is_external OR storage_used_bytes = 0);
```

User entity (`src/domain/entities/user.rs`):
- Add `is_external: bool` field
- Add getter `pub fn is_external(&self) -> bool`
- Add factory `User::new_external(username, email, ...)` for the magic-link flow
- Existing factories (`User::new(...)`) default `is_external = false`

The `Subject::External(uuid)` variant in `domain/services/authorization.rs` becomes redundant once external users live in `auth.users` and are addressed as `Subject::User(uuid)`. Deprecate it in a follow-up — out of scope here to avoid scope creep.

### Concrete hook implementations

**Each hook impl lives in the module of the service that owns the work**, matching the existing convention (`ThumbnailRefreshHook` lives in `src/infrastructure/services/thumbnail_service.rs`; `AudioMetadataService impl FileLifecycleHook` lives in `audio_metadata_service.rs`). There is **no centralised `lifecycle/` directory** — that would invert ownership and make "lifecycle" look like the owner of folder-creation policy when really the folder service owns it.

All four trait methods are explicit per impl; no-ops are `Ok(())` one-liners.

| Hook | Lives in | Responsibility |
|---|---|---|
| `HomeFolderLifecycleHook` | `src/application/services/folder_service.rs` (same module as `FolderService`) | Replaces the 4 eager `create_personal_folder` calls + the self-heal. `on_user_created` & `on_user_login`: if `!user.is_external()` and home folder missing, create "My Folder - {username}". `on_user_deleted` (AdminDelete): trash the home folder. `on_user_deleted` (GdprPurge): hard-delete folder + files. `on_user_logout`: `Ok(())`. |
| `AuthzCacheLifecycleHook` | `src/infrastructure/services/pg_acl_engine.rs` (same module as the Moka cache it invalidates) | Wraps `Arc<PgAclEngine>`. `on_user_logout` & `on_user_deleted`: `engine.invalidate_user_groups_cache(user.id())` (new public method on the engine — one line `self.user_groups_cache.invalidate(id).await`). `on_user_created` & `on_user_login`: `Ok(())`. |
| `AuditLifecycleHook` | `src/application/services/user_lifecycle_service.rs` (co-located with the dispatcher — cross-cutting, no domain owner) | All four events: `tracing::info!(target: "audit", event = "user.{created\|login\|logout\|deleted}", user_id = %user.id(), is_external = user.is_external(), ...)`. Stays one place for user-lifecycle audit. |
| `SessionRevocationLifecycleHook` | The session-service module (e.g. `src/application/services/session_service.rs` or wherever `revoke_all_user_sessions` lives — verify at PR-write time) | `on_user_deleted`: explicit `session_storage.revoke_all_user_sessions(user.id(), tx)` for traceable audit (the FK CASCADE would do it but produces no per-session audit event). `on_user_logout` / `on_user_login` / `on_user_created`: `Ok(())`. |
| `ExternalIdentityLifecycleHook` *(stubbed; populated by the magic-link PR later)* | A future external-identity service module (created with the magic-link PR sequence; for the stub PR, place it in `src/application/services/external_identity_service.rs` as a new module) | `on_user_login`: if `user.is_external()`, bump a `last_verified_at` column on a future `auth.user_external_identity` side-table. Other events: `Ok(())`. Lands as no-op now so the slot exists. |

**Why owner-located, not lifecycle-located**: it preserves the rule that "code about folders lives in the folder module". A future maintainer reading the folder service sees the lifecycle reactions next to the rest of the folder logic. It also makes a future workspace split (see "Crate-split note" at the end of this plan) almost free — each domain takes its hooks with it.

### Tips for hook implementors

These belong in the module-level docstring of `application/ports/user_lifecycle.rs` so the next maintainer reading the trait sees them in IDE hover.

1. **First-ever login detection.** `on_user_login` fires after credentials validate but **before** `user.last_login_at` is updated for this session. So `user.last_login_at().is_none()` is a reliable "this is the first login since account creation" signal. Use it for welcome emails, one-shot default-folder seeding, "complete your profile" prompts, etc.

2. **External-user short-circuit.** Every hook that provisions or manages user-owned resources (folders, calendars, address books) should start with `if user.is_external() { return Ok(()); }`. External users are grant-only; they don't own storage. The `CHECK (NOT is_external OR storage_used_bytes = 0)` constraint catches violations at the DB level.

3. **Idempotency is mandatory.** `on_user_login` fires on every successful authentication. A hook that creates a resource must first check whether the resource already exists. Examples: `HomeFolderLifecycleHook` does `if folder_exists(user_id) { return Ok(()); }` before calling `create_home_folder`. `AuthzCacheLifecycleHook::on_user_logout` is naturally idempotent (cache `invalidate` is a no-op on a missing key).

4. **First call after `is_external = TRUE → FALSE`.** When admin converts an external user to internal (`UPDATE auth.users SET is_external = FALSE`), the user's next login fires `on_user_login` with the new flag value. The home-folder hook sees `!is_external` and that no folder exists → creates it. No special "convert" event needed; idempotency carries the load.

5. **Per-session logout firing.** Disabling a user revokes N sessions in a loop. The dispatcher fires `on_user_logout` **once per session revoked**, all with `reason = AccountDisabled`. Hook implementors must accept N redundant calls (idempotent invalidation, idempotent audit) — do **not** assume "one logout = one user state change". The same applies to `revoke_all_user_sessions` on password change.

6. **Failure swallowing on create/login.** If your hook returns `Err`, the user is still created / logged in; only your hook's effect is delayed. Log enough detail (`tracing::error!`) that a subsequent investigation can identify the user and retry manually. Failure on `on_user_deleted` aborts the transaction — be conservative about returning Err there.

7. **No transaction handle on create/login/logout.** Only `on_user_deleted` gets `&mut Transaction` because deletion is the only event with hard atomic-with-DB requirements. Other hooks open their own connections / pools as needed. This keeps the trait surface minimal.

8. **Hook registration is at DI time.** Hook order is registration order; document this in the DI factory if you ever add an ordering dependency (e.g., HomeFolderLifecycleHook before any future hook that wants to write to that folder).

## Documentation

A new architecture page `docs/architecture/user-lifecycle.md` lands alongside the trait (in PR 1) and grows incrementally with each subsequent PR. Mirrors the structure of the existing `docs/architecture/file-and-blob-lifecycle.md` so readers familiar with the file-side pattern can navigate the user-side analog.

**Outline** (~150 lines):

1. **Context** — why hooks (replaces 4 scattered `create_personal_folder` calls + the self-heal; sets up the magic-link / external-user flow as a pluggable concern).
2. **The trait** — full signature, the 4 events, `LogoutReason` / `DeletionMode` enums.
3. **Dispatcher semantics** — per-event failure model (log-and-continue for created/login, fire-and-forget spawn for logout, abort-on-Err for deleted-in-transaction). Diagram.
4. **Implementation tips** (verbatim from the "Tips for hook implementors" section of this plan — first-login detection via `last_login_at.is_none()`, idempotency, external-user short-circuit, per-session logout firing, …).
5. **Owner-located convention** — explains why hooks live with their service module rather than a centralised `lifecycle/` directory, with the FileLifecycleHook precedent.
6. **Concrete hooks shipped today** — table of `HomeFolderLifecycleHook` / `AuthzCacheLifecycleHook` / `AuditLifecycleHook` / `SessionRevocationLifecycleHook` / `ExternalIdentityLifecycleHook` (stub) with one-line summaries and where each lives.
7. **Recommended future triggers** — the "future triggers" table from this plan (`on_user_password_changed`, `on_user_role_changed`, etc.) so v2 contributors see the design door.
8. **File map** — same shape as the file map at the bottom of `rebac-authorization.md`.

**VitePress sidebar update** in `docs/.vitepress/config.mts`. The Architecture section already lists "File and Blob lifecycle" (line 104); add immediately after:

```ts
{ text: "User lifecycle", link: "/architecture/user-lifecycle" },
```

**Incidental fix while we're in the file**: `docs/architecture/rebac-authorization.md` (created in a previous session) is missing from the sidebar. Add it in the same edit:

```ts
{ text: "ReBAC Authorization", link: "/architecture/rebac-authorization" },
```

Place it logically — probably right before "Share Integration" since shares depend on ReBAC concepts.

**Per-PR doc growth**:
- PR 1: sections 1, 2, 3, 4, 5 (trait, dispatcher, conventions) + the AuditLifecycleHook entry in section 6
- PR 2: short subsection in section 4 explaining the `is_external` short-circuit pattern
- PR 3: HomeFolderLifecycleHook entry in section 6, plus a worked example "what happens when a brand-new user logs in"
- PR 4: AuthzCacheLifecycleHook + SessionRevocationLifecycleHook entries, plus the `DeletionMode` section
- PR 5: ExternalIdentityLifecycleHook entry + a "this is a placeholder for the upcoming magic-link feature" note

Sidebar entry lands in PR 1; subsequent PRs only edit the markdown content.

## Migration sequencing (5 PRs)

**PR 1: trait + dispatcher + audit hook only.**
Lands the trait at `application/ports/user_lifecycle.rs`, the dispatcher at `application/services/user_lifecycle_service.rs`, and `AuditLifecycleHook` as the lone registered hook. Wires `dispatch_created` / `dispatch_login` / `dispatch_logout` / `dispatch_deleted` into the existing 4 auth code paths (no behaviour change for users; only audit log gains four new event types). Zero risk; validates plumbing.

**PR 2: `is_external` column + entity field.**
Migration `20260612000002_auth_users_is_external.sql`, `User::is_external` getter, factory variant, DTO field. All existing rows have `is_external = FALSE` from the column default; no breaking changes. New `POST /api/admin/users` accepts `is_external` (default `false`).

**PR 3: `HomeFolderLifecycleHook`.**
Register the hook. Remove the 4 eager `create_personal_folder` calls in `auth_application_service.rs:283 / 360 / 832 / 1277`. Remove the self-heal at `folder_service.rs:350-365`. Existing test suite should pass — folder still gets created, just by the hook now. The Hurl suite at `tests/api/run.sh` is the canary.

**PR 4: `AuthzCacheLifecycleHook` + `SessionRevocationLifecycleHook` + `on_user_deleted` policy.**
Adds the `pub fn invalidate_user_groups_cache(&self, id: Uuid)` method on `PgAclEngine`. Wires the two hooks. Adds `DeletionMode` switching to `HomeFolderLifecycleHook::on_user_deleted` (trash vs hard-delete). Admin-delete endpoint now passes `mode = AdminDelete`; a (future) GDPR sweeper passes `GdprPurge`.

**PR 5: `ExternalIdentityLifecycleHook` stub.**
Empty no-op hook landed in advance of the magic-link feature so the registration slot exists in DI. Populated in the magic-link PR sequence later.

After PR 3, the cleanup of `create_personal_folder` from `auth_application_service.rs` is complete and the service stops importing `FolderService` for that purpose.

## Recommended future triggers (DON'T ship now)

These are the events users / consumers will eventually want. Each has a "what would make us add it" rationale; absent that, **don't add the method to the trait** — every method adds a no-op to every hook impl forever.

| Future event | Why someone might want it | What would force adding it |
|---|---|---|
| `on_user_password_changed` | Notify the user via email; invalidate any cached credentials; trigger TOTP re-enrolment | A real per-user notification service. Today the password-change handler explicitly calls `revoke_all_user_sessions` which fires `on_user_logout(PasswordChanged)` for each session — sufficient for current consumers. |
| `on_user_role_changed` | Admin grants admin role → audit + maybe send "you're now an admin" email; admin demotion → revoke admin-only sessions | A multi-role system (today only `admin` / `user` exist). Currently a one-liner audit log at the admin handler covers it. |
| `on_user_email_changed` | External users: re-verify the new email via magic-link before trusting it; internal: notify both old and new addresses; update OIDC mapping | When external users start changing their email. Today email is immutable in the API. |
| `on_user_username_changed` | Update display names in audit logs that captured the old username; rename the home folder if it embeds the username | When username changes ship. Today username is immutable. |
| `on_user_avatar_changed` | Bust thumbnail caches downstream; sync to federated servers (OCM) | When OCM federation ships and remote partners need to learn about avatar changes. Today no downstream consumer. |
| `on_user_quota_changed` | Future per-service quota counters react to admin-changed limits | When quota becomes per-service (today it's a single global counter per user). |
| `on_user_disabled` / `on_user_enabled` | Audit-distinguishable state changes; pause per-user scheduled jobs | When per-user scheduled jobs land. Today `on_user_logout(AccountDisabled)` covers the only real consumer (sessions). Re-enable triggers `on_user_login` naturally. |
| `on_user_external_to_internal_converted` | Welcome email; provision the catalog of internal-only resources at conversion time rather than on next login | If admins routinely promote external users and the next-login lag is unacceptable. Today the idempotent `on_user_login` recheck handles conversion fine. |
| `on_user_oidc_linked` / `on_user_oidc_unlinked` | Audit; sync remote profile data | When users can link/unlink OIDC identities post-creation. Today OIDC linkage is fixed at user-creation time. |
| `on_user_2fa_enabled` / `on_user_2fa_disabled` | Audit; force re-login of other sessions | When 2FA ships. |

**Rule of thumb for adding any of these later**: add the trait method with a default `Ok(())` body so existing hooks don't need to declare it explicitly (one-time exception to the "no defaults" rule, paid forever after by IDE-discoverable docstrings on the new method). Make sure the docstring states whether it's await-or-spawn semantics and whether failure aborts the parent operation.

## Critical files

**New files** (per PR):

- PR 1: `src/application/ports/user_lifecycle.rs` (trait + `LogoutReason` + `DeletionMode` enums), `src/application/services/user_lifecycle_service.rs` (dispatcher + `AuditLifecycleHook` co-located inside), `docs/architecture/user-lifecycle.md` (architecture doc, outline above)
- PR 2: `migrations/20260612000002_auth_users_is_external.sql`
- PR 3: No new files — `HomeFolderLifecycleHook` is added as a new `impl UserLifecycleHook for ...` block inside the **existing** `src/application/services/folder_service.rs` (or a sibling `folder_lifecycle.rs` if folder_service.rs gets too large; verify line count at PR-write time)
- PR 4: No new files — `AuthzCacheLifecycleHook` added inside the existing `src/infrastructure/services/pg_acl_engine.rs`; `SessionRevocationLifecycleHook` added inside the session-service module
- PR 5: `src/application/services/external_identity_service.rs` (new module hosting the stub hook)

**Modified files**:

- `src/domain/entities/user.rs` (PR 2): add `is_external` field + getter + factory
- `src/application/services/auth_application_service.rs` (PRs 1, 3): wire dispatcher into the 4 create / 3 login / 2 logout / 1 delete sites; remove the 4 eager folder-creation calls in PR 3
- `src/application/services/folder_service.rs` (PR 3): add the `HomeFolderLifecycleHook` impl; remove the self-heal at lines 350-365 (now handled by the hook on next login)
- `src/infrastructure/services/pg_acl_engine.rs` (PR 4): add `pub fn invalidate_user_groups_cache(&self, id: Uuid)` exposing `user_groups_cache.invalidate(id)`; add the `AuthzCacheLifecycleHook` impl
- `src/common/di.rs` (PRs 1, 3, 4, 5): construct the `UserLifecycleService` with builder chain, mirror the `FileLifecycleService` registration pattern at lines 264-301
- `src/application/dtos/user_dto.rs` (PR 2): add `is_external: bool` field
- `src/interfaces/api/handlers/admin_handler.rs` (PR 2): accept `is_external` in `POST /api/admin/users` request body
- `docs/.vitepress/config.mts` (PR 1): add "User lifecycle" entry to the Architecture sidebar (line ~104). Also incidentally add the missing "ReBAC Authorization" entry that pre-dated this work
- `docs/architecture/user-lifecycle.md` (PRs 2, 3, 4, 5): grow the doc incrementally as each hook lands — `is_external` short-circuit note in PR 2, HomeFolderLifecycleHook section in PR 3, etc.

**Existing patterns to reuse**:

- Hook trait + dispatcher pattern: `src/application/ports/file_lifecycle.rs` + `src/application/services/file_lifecycle_service.rs` (the closest analog)
- DI builder chain: `src/common/di.rs:264-301` (FileLifecycleService construction)
- Audit tracing convention: `target: "audit"` events emitted by `src/application/services/subject_group_service.rs::create / rename / delete / add_member / remove_member`
- Per-cache invalidation method on engine: model after how `user_groups_cache` is accessed today in `src/infrastructure/services/pg_acl_engine.rs::expand_user`

## Verification

```bash
cargo fmt --all
cargo clippy --all-features --all-targets -- -D warnings
cargo test --workspace
biome check --fix static/js/
tsc -p jsconfig.json --noEmit
```

After PR 1 (smoke test the plumbing):

1. `cargo run`, then via the UI: register a new user, log in, log out, delete via admin.
2. `journalctl -t oxicloud | grep "target=user_lifecycle"` (or `RUST_LOG=user_lifecycle=info`) — exactly one event line per action.

After PR 3 (the migration of folder creation):

1. Hurl suite: `bash tests/api/run.sh` — all 13 test files still pass. `permissions.hurl` is the most relevant (it creates `bob` and verifies the home folder).
2. Manual: register a fresh user via the UI → home folder appears in the file list immediately. Then drop the home folder via SQL (`DELETE FROM storage.folders WHERE user_id = $1`), log out, log back in → folder reappears (the safety-net path).
3. Confirm via tracing that `dispatch_login` actually ran for an existing user whose folder was already there → no folder creation attempt, no error, just one `on_user_login` audit event.

After PR 4:

1. Authz cache: create a user, log them in, log them out. Inspect `RUST_LOG=oxicloud::infrastructure::services::pg_acl_engine=debug` — cache entry should be invalidated immediately on logout, not after 30s TTL.
2. User deletion: admin-deletes a user → verify (via audit log) that `on_user_deleted` ran inside the transaction and all sessions were revoked before the `auth.users` row vanished.

After PR 5: no functional change; just confirm `external_identity_hook.rs` compiles and registers in DI as a no-op.

## Out of scope (do NOT bundle into these 5 PRs)

- **The magic-link external-user flow itself.** Lands in a later sequence; this plan only prepares the schema (`is_external`) and the hook slot (`ExternalIdentityLifecycleHook` stub).
- **Removing `Subject::External` from the domain.** It's currently unused; the cleanup is a separate small PR after PR 2 demonstrates that external users live in `auth.users`.
- **GDPR sweeper.** The `DeletionMode::GdprPurge` variant exists in PR 4 but no sweeper is wired up — admin-delete uses `AdminDelete`. A scheduled sweeper is its own future work.
- **Moving the `active` flag transitions through a hook.** PR 4's `on_user_logout(AccountDisabled)` covers it; no `on_user_disabled` method is added (see "future triggers" section).
- **Side-table for OIDC/OCM provenance** (`auth.user_external_identity`). Lands with the magic-link PR; not needed for `is_external` alone.

## Crate-split note (forward-looking, NOT in this work)

OxiCloud is currently a single Rust crate (~50 kLOC). The lifecycle-hook restructuring above intentionally aligns with the natural domain boundaries (each hook lives with its service) so that a future workspace split is incremental rather than a rewrite. **Not on the table for this work, but worth recording the intended split axis** so subsequent refactors don't paint into a corner:

- **Split by domain bounded context, NOT by hexagonal layer.** Layered split (`oxicloud-domain` / `oxicloud-application` / etc.) makes the common case painful: adding a field to an entity touches 4 crates. Domain split (`oxicloud-files`, `oxicloud-auth`, `oxicloud-rebac`, …) makes the common case stay in one crate.
- Target shape, illustrative:
  ```
  oxicloud-kernel      ← errors, DI primitives, common port traits (incl. UserLifecycleHook)
  oxicloud-auth        ← users, sessions, OIDC, app passwords; dispatcher lives here
  oxicloud-rebac       ← groups, grants, engine; registers AuthzCacheLifecycleHook
  oxicloud-files       ← files, folders, blobs, dedup, thumbnails; registers HomeFolderLifecycleHook
  oxicloud-sharing     ← shares, magic-link, external identity
  oxicloud-calendar    ← caldav
  oxicloud-contacts    ← carddav
  oxicloud-server      ← Axum wire-up, the binary, DI composition root
  ```
  Each domain crate is internally layered. Cross-crate communication goes through `oxicloud-kernel` port traits. The DI factory at `oxicloud-server` is where crates compose into the full application.

- **What today's lifecycle work buys for that future split**: zero rework on hook locations. `HomeFolderLifecycleHook` already lives next to `FolderService`, so it moves with `oxicloud-files`. `AuthzCacheLifecycleHook` moves with `oxicloud-rebac`. The dispatcher in `oxicloud-auth` only knows the trait, never the impls.

- **Cheap things to do now that help the future split**, but are NOT bundled here:
  - Tighten visibility: prefer `pub(crate)` over `pub` wherever a type isn't intentionally part of the public surface. Catches accidental cross-module reaches at compile time.
  - Per-domain port traits: today `application/ports/file_lifecycle.rs` is a file-concern port living in the layer dir; eventually it should live under the files-domain module. Refactor when adjacent ports are touched, not as a one-shot move.
  - Avoid expanding `src/common/` — it tends to absorb anything-shared and become hard to split later.

These are convention recommendations for future PRs, not work items for this plan.
