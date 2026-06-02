-- ════════════════════════════════════════════════════════════════════════════
-- Email-verified signal (PR 23)
-- ════════════════════════════════════════════════════════════════════════════
-- Tracks when the user demonstrated control of their email address.
--
--   NULL     — unverified. Classic password-only signup whose user
--              never clicked any magic-link, or admin-created user
--              who hasn't logged in via magic-link.
--   non-NULL — timestamp of the FIRST proof of control. Stamped on:
--                * successful magic-link redemption (invitation OR
--                  login-via-email — clicking the link IS the proof).
--                * OIDC JIT-provisioning when the IdP's claim
--                  `email_verified` was true. The OIDC callback already
--                  refuses to proceed without that claim, so the
--                  timestamp is set unconditionally at JIT creation.
--                * Retroactive OIDC upgrade: existing user whose
--                  email_verified_at is NULL but whose next OIDC login
--                  carries a verified claim gets the stamp at that
--                  login.
--
-- PR 23 introduces the signal only — no policy gates yet. Future
-- env (e.g. OXICLOUD_REQUIRE_EMAIL_VERIFICATION) will block uploads /
-- shares / etc. for unverified users.
--
-- Backfill rules:
--   * OIDC-linked users — the IdP already vetted the email at
--     provisioning time. Use last_login_at if set (typical), else
--     created_at as the verification timestamp.
--   * External users who have logged in at least once — they must have
--     clicked their invitation link to land last_login_at. Use the
--     last login time as a conservative lower bound on when the
--     verification proof happened.
--   * Everyone else stays NULL — including OIDC-less external users
--     who got invited but never clicked (the magic-link is still
--     sitting in their inbox), and classic password users who never
--     went through a magic-link flow.

ALTER TABLE auth.users
    ADD COLUMN email_verified_at TIMESTAMPTZ NULL;

UPDATE auth.users
   SET email_verified_at = COALESCE(last_login_at, created_at)
 WHERE oidc_subject IS NOT NULL
    OR (is_external = TRUE AND last_login_at IS NOT NULL);

COMMENT ON COLUMN auth.users.email_verified_at IS
    'When the user demonstrated control of their email address.
     NULL = unverified. Set on successful magic-link redemption OR
     OIDC JIT with email_verified=true claim. Idempotent — the first
     verification timestamp is preserved. PR 23 ships the signal;
     future policy PRs gate features on it.';
