---
description: Test Environment Requirements (Postgres)
---

# Test Environment Requirements

When running tests locally (e.g. `npm run check` or `vitest`), you MUST ensure that the local PostgreSQL container is running and the `DATABASE_URL` is set, otherwise the database tests will be silently skipped and might fail later in CI.

1. **Check / Start Container:**

   ```bash
   docker start kolonie-pg
   ```

   _(If it doesn't exist, create it with: `docker run -d --name kolonie-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=kolonie_test -p 5432:5432 postgres:16`)_

2. **Set Environment Variable:**
   Always prefix test commands or export the variable before running:
   ```bash
   export DATABASE_URL=postgres://postgres:postgres@localhost:5432/kolonie_test
   ```
