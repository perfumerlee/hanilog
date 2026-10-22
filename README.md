# HaniLog

React + TypeScript + Vite PWA for shared pet health records. PostgreSQL is the source of truth; Supabase Auth, RLS and narrow database commands enforce access and record integrity.

## Local setup

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env` and provide only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from a local development Supabase project.
3. Start a local Supabase stack, then apply migrations with `supabase start` and `supabase db reset`.
4. Run `npm run dev`.

Never put a Supabase secret/service-role key, database password, or Edge Function secret in a `VITE_*` variable or browser bundle. Use synthetic data only. Do not connect this project to production data.

## Checks

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- With the Supabase CLI and Docker installed: `supabase test db`

The GitHub Actions workflow validates source changes only. It does not deploy GitHub Pages.

## GitHub Pages path

For a repository Pages site, set `PAGES_BASE_PATH` to the repository slug at build time (for example, `hanilog`). Root or custom-domain builds omit it. Hash routing keeps direct routes compatible with static hosting. Supabase Auth redirect URLs and Edge Function CORS origins must be explicitly configured for the chosen origin before a hosted auth flow is enabled.
