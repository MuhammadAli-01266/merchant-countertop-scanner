# Clean Deployment Checklist (Supabase + Vercel)

Applies to both apps (merchant terminal and customer pass); they share one Supabase project.
Work top to bottom. Each step says how to verify it.

## Why you saw 400 / 404

| Symptom | What it actually means | Fix |
|---|---|---|
| `400` on `POST /auth/v1/token?grant_type=password` | Supabase Auth rejected the login. The response body has `error_code`: `invalid_credentials` (wrong password, **or the user doesn't exist in this project**; a new project has no users), `email_not_confirmed`, or `email_provider_disabled` | Steps B4–B5 |
| `404` on `POST /rest/v1/rpc/get_merchant_context` | PostgREST can't find the function: **migrations not applied to this project**, a stale schema cache, or a URL with a path (`…/rest/v1/rest/v1/…`) | Steps B1–B3, C2 |
| App builds but has no config / wrong project | This is a **Vite** app: it reads only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, inlined **at build time**. `NEXT_PUBLIC_*` names are ignored. Env changes need a rebuild without cache | Steps C2–C5 |

Neither error comes from client code. The app now names the exact cause on screen (code plus
project ref), and `npm run check:backend` confirms it from your machine.

---

## A. Before you start

- [ ] **A1.** Use one Supabase project: `uovotzsbepqufgcxewkt`. Both apps point to it.
- [ ] **A2.** Under *Project Settings → API Keys*, copy the **Project URL** (`https://uovotzsbepqufgcxewkt.supabase.co`)
      and the **Publishable key** (`sb_publishable_…`). The legacy `anon` JWT also works.
      **Never** use `sb_secret_…` / `service_role` in the app.
- [ ] **A3.** If a secret or service_role key was ever placed in a `VITE_` variable or
      committed, **rotate it now** (API Keys → roll or create a new secret key).

## B. Supabase backend

- [ ] **B0. Projects that ever ran the AI Studio prototype** (this includes `uovotzsbepqufgcxewkt`): take a backup
      (*Database → Backups*), then run `supabase/migrations/20260929000000_retire_prototype.sql` **first**.
      It moves the prototype's tables (`tenants`, `customers`, `cards`, `stamps`, …) and functions into a locked
      `legacy_prototype` schema. No data is deleted, the `USING (true)` exposure ends, and 0001 can then create
      its own `tenants` table. The undo is in the file header. On a brand-new project it finds nothing and does nothing.
- [ ] **B1. Apply migrations 0001–0005, in order.**
  - CLI: `supabase link --project-ref uovotzsbepqufgcxewkt`, then `supabase db push`.
  - Or SQL editor: run each file in `supabase/migrations/` in filename order.
- [ ] **B2. Reload the API schema cache:** run `NOTIFY pgrst, 'reload schema';` in the SQL editor.
- [ ] **B3. Verify the database:** run `supabase/tests/verify_deployment.sql`. Queries 1–3 must return **0 rows**:
  1. missing functions
  2. bad grants
  3. tables missing from Realtime (if any, add `stamp_events`, `loyalty_cards` and `rewards` under *Database → Publications → supabase_realtime*)
- [ ] **B4. Auth settings:**
  - *Authentication → Sign In / Providers → Email* is **enabled**.
  - Staff accounts: create them under *Authentication → Users → Add user* with **Auto Confirm User** ticked,
    or invite them (they must confirm before they can sign in).
  - *URL Configuration*: set the Site URL and add both Vercel URLs (plus `https://<customer-app>/join/*`) to the redirect URLs.
  - Customer app: include `{{ .Token }}` in the *Magic Link* email template (customers sign in with a code).
- [ ] **B5. Business data for each terminal:**
  1. The owner creates the tenant: `select public.create_tenant('Shop Name', 'shop-slug');` while signed in.
     For a one-off admin setup, insert as `postgres` and add the owner to `tenant_members`.
  2. Add at least one **location** and one **active program**.
  3. Add staff: `insert into tenant_members (tenant_id, user_id, role) values ('<tenant>', '<auth user id>', 'staff');`
  4. Production tenants: `update tenants set status = 'active' where slug = 'shop-slug';`. Trials expire after 14 days, after which stamping returns `TENANT_INACTIVE`.

  Then run query 4 of `verify_deployment.sql` with the staff email. It must say **OK**.
- [ ] **B6. Housekeeping:** schedule `select private.prune_qr_token_uses();` daily with pg_cron.

## C. GitHub → Vercel (fresh project)

- [ ] **C1. Commit hygiene:**
  - `.env*` is git-ignored (only `.env.example` is committed).
  - `node_modules/` and `dist/` are ignored.
  - `package-lock.json` **is** committed (Vercel runs `npm ci`).
  - Run `git grep -nE "sb_secret_|service_role|eyJhbGci"` before pushing; it should find nothing.
- [ ] **C2. Create a new Vercel project per app.** Import the repo, use Framework Preset **Vite**, and leave
      the Build/Install/Output settings at their defaults (`vercel.json` sets `npm ci`, `npm run build`, `dist`).
      If one GitHub repo holds both apps, set **Root Directory** to the app's folder.
- [ ] **C3. Environment variables** (*Settings → Environment Variables*). Tick **Production, Preview and
      Development** for each:

      | Name | Value |
      |---|---|
      | `VITE_SUPABASE_URL` | `https://uovotzsbepqufgcxewkt.supabase.co`. No trailing slash, no `/rest/v1`, no quotes |
      | `VITE_SUPABASE_PUBLISHABLE_KEY` | the `sb_publishable_…` key (or the legacy anon key) |
      | `VITE_CUSTOMER_APP_URL` | merchant project only: the customer app's URL |

      These are the **only** names the apps read. Delete any other Supabase variables
      (`NEXT_PUBLIC_*`, `VITE_SUPABASE_ANON_KEY`, old duplicates) so nothing stale lingers.
      Paste plain values: the app refuses values containing quotes, spaces or `[link](…)` formatting.
      Do **not** add `SUPABASE_SECRET_KEY` to Vercel.
- [ ] **C4. Deploy without cache.** Env values are compiled into the JS at build time. After any env change:
      *Deployments → ⋯ → Redeploy → untick "Use existing Build Cache"*.
      CLI alternative: `vercel --prod --force`.
- [ ] **C5. Verify the live bundle** from your machine:
      ```bash
      cp .env.example .env.local   # fill in URL + publishable key
      STAFF_EMAIL=staff@shop.com STAFF_PASSWORD='…' DEPLOY_URL=https://<merchant>.vercel.app \
        npm run check:backend
      ```
      This checks, in order:
      1. URL and key shape, and that both belong to the same project
      2. the email provider
      3. that every RPC exists and anon is denied
      4. a real staff login, then `get_merchant_context`
      5. that **the deployed JS targets this project with this key** (catches stale builds)

      It must end with **All checks passed**.
- [ ] **C6. Clear stale clients:**
  - Terminals that ran an older build may hold an old service worker or session. In Chrome, open
    *Site settings → Clear data* for the domain, or use DevTools → Application → Storage → **Clear site data**.
  - The terminal stores its session under `merchant-terminal-auth`; the customer app uses `customer-pass-auth`.
- [ ] **C7. Smoke test on a real device:**
  1. Sign in on the terminal.
  2. Open the customer pass on a phone and scan it. The modal shows the customer and "Valid for …s".
  3. Tap **+1**. The pass phone animates live (Realtime) and the terminal toast says "Confirmed by server".
  4. Tap **Undo**, then scan again to confirm the stamp re-issues.
  5. Run the **Expired Token** tile: it should report "Fraud Guard Verified".

## D. Reading errors on screen

The sign-in and error screens show `code · project · key type`:

| Code | Meaning |
|---|---|
| `INVALID_CREDENTIALS` | wrong password, or the user doesn't exist in this project |
| `EMAIL_NOT_CONFIRMED` | the user hasn't confirmed their email (B4) |
| `EMAIL_LOGIN_DISABLED` | the Email provider is off (B4) |
| `BACKEND_NOT_MIGRATED` | the functions are missing; run B1–B2 |
| `SCHEMA_NOT_EXPOSED` | *Settings → API → Exposed schemas* must include `public` |
| `INVALID_API_KEY` | wrong or rotated key in the build; fix C3, then C4 |
| `NO_MEMBERSHIP` | the user isn't staff anywhere (B5) |
| `TENANT_INACTIVE` | the trial expired or the tenant is suspended (B5) |
