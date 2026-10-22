# Phase 1 implementation notes

This code is an initial local development foundation. It is not a production release and must use synthetic data only.

## Implemented

- React, TypeScript, Vite 7, Tailwind CSS 4, HashRouter, and a prompt-update PWA worker.
- GitHub Pages project path support through `PAGES_BASE_PATH`; CI uses a synthetic path to check asset URLs and does not deploy Pages.
- Supabase client reads only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
- Initial SQL schema for the 16 Phase 0.6 entities, row-level security, household/Pet creation, caregiver Pet grants, event recording, correction/void revisions, audit records, evaluation records, and idempotency.
- Health event creation is a server-side RPC. It checks the current caregiver membership and Pet grant, serializes writes for a supplied routine occurrence, and returns `DUPLICATE_POSSIBLE` while preserving separate event rows.
- The application lets a caregiver enter an actual occurrence time and optional user-observed value/unit. No treatment values or thresholds are prefilled.
- Vitest unit tests and a pgTAP database test script using synthetic accounts and records.

## Not implemented in this phase slice

- Household email invitations and acceptance/revocation UI. Membership and Pet grant tables are read-protected; only the owner bootstrap path is currently exposed. Do not add collaborators by directly writing rows from a client.
- Care Plan/Routine authoring or occurrence generation UI. The database can link a supplied occurrence; a missing occurrence deliberately does not infer a treatment slot or duplicate.
- Revision review/projection UI, offline draft sync, clinician portal, notifications, storage, reports, and export/delete workflows.
- Supabase Edge Functions. Database RPCs currently provide the narrow authenticated command boundary for implemented operations.
- Production Supabase configuration, GitHub Pages deployment workflow, and any hosted data.

## Local verification

Run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. For database tests, install Docker and the Supabase CLI, then run `supabase start`, `supabase db reset`, and `supabase test db`. `supabase/tests/database.test.sql` covers RLS isolation, caregiver visibility, an unverified personal plan, missing meal-record state, separate duplicate events, and idempotent retries. Parallel transaction behavior still requires a live multi-session PostgreSQL test.

The current migration has not been applied to a local PostgreSQL/Supabase instance in this environment. Review SQL syntax and security-definer/RLS behavior through the local database suite before treating it as a usable foundation.
