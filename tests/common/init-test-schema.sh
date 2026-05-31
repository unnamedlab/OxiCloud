#!/usr/bin/env bash
# Apply every migration in lexical order to a test database, then seed
# the minimum `auth.users` row that integration tests need.
#
# Connection parameters come from the libpq env vars (PGHOST, PGPORT,
# PGUSER, PGPASSWORD, PGDATABASE) so the same script works against:
#
#   - the local docker-compose-test postgres on port 5433
#     (PGHOST=localhost PGPORT=5433 PGUSER=oxicloud_test
#      PGPASSWORD=oxicloud_test PGDATABASE=oxicloud_test)
#
#   - the CI postgres service on port 5432
#     (PGHOST=localhost PGPORT=5432 PGUSER=postgres
#      PGPASSWORD=postgres PGDATABASE=oxicloud_test)
#
# The seed user is purely a placeholder so `first_admin()` in the Rust
# integration tests has a UUID to attach `added_by` to. The password
# hash is not a real argon2 hash — these tests never log in as this
# user, only reference its id.

set -euo pipefail

: "${PGHOST:?PGHOST must be set}"
: "${PGPORT:?PGPORT must be set}"
: "${PGUSER:?PGUSER must be set}"
: "${PGPASSWORD:?PGPASSWORD must be set}"
: "${PGDATABASE:?PGDATABASE must be set}"
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "[init-schema] applying migrations to ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
for f in "$REPO_ROOT"/migrations/*.sql; do
    echo "[init-schema]   $(basename "$f")"
    psql -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done

echo "[init-schema] seeding ci-admin row (idempotent)"
psql -v ON_ERROR_STOP=1 -c "
    INSERT INTO auth.users (username, email, password_hash, role)
    VALUES ('ci-admin', 'ci-admin@example.test', 'placeholder-not-validated', 'admin')
    ON CONFLICT (username) DO NOTHING;
" >/dev/null

echo "[init-schema] done"
