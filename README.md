# Merchant Countertop Scanner

The staff terminal of the multi-tenant loyalty stamp SaaS. Cashiers sign in, scan a customer's
rotating pass QR, and issue stamps or redeem rewards. **The browser never decides a stamp count:**
every mutation is a Postgres function that checks the cashier's role, tenant, the QR signature,
expiry, replay, physical presence, cooldown and daily limits, then returns the authoritative card.

Vite + React 19 + Tailwind 4 · Supabase (Postgres, RLS, Auth, Realtime) · `html5-qrcode`.

## How it works

```
Customer phone                   Merchant terminal                    Postgres (Supabase)
───────────────                  ─────────────────                    ───────────────────
LS1.<uid>.<step>.<hmac>  ──QR──▶  camera / USB scanner
 (offline, rotates 30s)           │ format pre-check only
                                  └─ rpc scan_customer(token) ──────▶  verify HMAC, ±60s window,
                                                                       one use per merchant,
                                     ◀── snapshot + presence (3 min) ─ record PRESENCE
                                  +1 STAMP
                                  └─ rpc issue_stamp_for_scan ──────▶  presence unused? role? cooldown?
                                     ◀── server card state ─────────── daily cap? → one issuance
                                  REDEEM  └─ rpc redeem_reward ─────▶  presence required
                                  UNDO    └─ rpc void_stamp_event ──▶  issuer ≤5 min / manager ≤24 h,
                                                                       latest only, no reward created
```

- **One scan authorizes one stamp issuance** (quantity ≤ the program's `max_stamps_per_scan`).
  Adding more needs a fresh scan; the pass rotates every 30 s, and a token can't be replayed.
- **Lookup and Recent Guests are view-only.** Stamping and redeeming always require a live scan.
- **Undo is server-side.** It frees the scan so the cashier can re-issue the right quantity.
- **Realtime** uses one channel filtered to the cashier's tenant (`tenant_id=eq.<id>`), which RLS
  re-checks. Events trigger refetches; the client never adds numbers itself. The channel resyncs
  on reconnect, tab focus and network return.

### Security model

| Concern | Enforcement |
|---|---|
| Who is the cashier | Supabase Auth session; `auth.uid()` inside every RPC |
| Which business | `tenant_members` membership, checked in each RPC; RLS on every read |
| Stamp/reward/card writes | Only `SECURITY DEFINER` functions; `insert/update/delete` revoked from clients |
| QR forgery, expiry, replay | HMAC-SHA256 per-customer secret (private schema), ±60 s window, `(tenant, customer, step)` unique |
| Repeated stamping off one scan | Presence row is spent by the first issuance |
| Staff stamping themselves | `SELF_STAMP_FORBIDDEN` / `SELF_SCAN_FORBIDDEN` |
| Tampering with the terminal config | Credentials are build-time only; there is no runtime override |
| Cross-tenant reads | Listings run `SECURITY INVOKER`, so RLS applies; composite foreign keys prevent cross-tenant rows |

The publishable key in the bundle is public by design. Never put a secret or `service_role` key in a
`VITE_*` variable; the app refuses to start if it detects one.

## Project layout

```
src/
  App.tsx                 config check → ErrorBoundary → AuthGate
  components/             AuthGate (session + tenant context), LoginScreen, ErrorBoundary, Shell
  terminal/Terminal.tsx   the countertop UI (original design) wired to the RPCs
  hooks/                  useQrScanner (html5-qrcode), useKeyboardWedge (USB scanners), useOnlineStatus
  lib/                    api.ts (typed RPCs, 12 s timeout), errors.ts, model.ts, env.ts, supabase.ts, sound.ts
supabase/
  migrations/             0001 schema · 0002 RLS · 0003 stamp engine · 0004 merchant terminal
  tests/                  stamp_engine_smoke.sql, terminal_flow.sql (local DB only)
scripts/                  seed-dev.mjs, customer-token.mjs (dev only)
e2e/                      full-stack browser test with a fake camera
```

## Setup

1. **Database.** Apply the migrations in order:
   - With the CLI: `supabase link --project-ref <ref>`, then `supabase db push`.
   - Or paste each file into the SQL editor.

   Then confirm that `stamp_events`, `loyalty_cards` and `rewards` are listed under
   *Database → Publications → supabase_realtime*.
2. **Environment.** (See `DEPLOY.md` for the full Supabase + Vercel checklist.) Copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY`. `VITE_CUSTOMER_APP_URL` is optional; it enables the sign-up QR
   under "+ New Member".
3. **Run.** `npm ci`, then `npm run dev`. The camera requires `localhost` or HTTPS.
4. **Demo data (dev or staging projects only).** Add `SUPABASE_SECRET_KEY` to `.env.local`, then
   run `npm run seed:dev`. It prints logins for an owner, a staff member and a customer.
   - To scan without the customer app, run `npm run token:dev -- <customer-email> <password>`. It
     shows a live rotating pass QR in your terminal; point the scanner at it.
   - On a non-local project, set `SEED_ALLOW_REMOTE=1` to allow seeding.

### Staff accounts

Staff are ordinary Supabase Auth users who are members of a tenant through `tenant_members`
(`owner | manager | staff`). Owners create the tenant with `create_tenant(name, slug)` and add
staff. An invite UI belongs in the owner portal, which is a later step. Until then, add staff with
`seed-dev.mjs`, or as the owner:
`insert into tenant_members (tenant_id, user_id, role) values (...,'staff')` (RLS allows owners
only, and never the `owner` role).

## Deploy (Vercel)

- Import the repo. `vercel.json` already sets `npm ci` / `npm run build` / `dist`, plus security
  headers: CSP limited to `*.supabase.co`, `Permissions-Policy: camera=(self)`, `frame-ancestors 'none'`.
- Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` and optionally `VITE_CUSTOMER_APP_URL`
  for Production and Preview, then redeploy. These are inlined at build time.
- Add the deployment URL to Supabase *Auth → URL Configuration*.
- On counter devices: install as a PWA (manifest included), allow the camera, and keep the
  screen awake (kiosk or guided-access mode).

`npm run build` type-checks in strict mode before bundling. The sign-in bundle is about 130 KB
gzipped; the scanner and terminal (about 131 KB gzipped) load only after sign-in.

## Testing

- **SQL** (local database only; each file says which errors are expected):
  `psql -d <db> -f supabase/tests/stamp_engine_smoke.sql` and `.../terminal_flow.sql`.
- **End-to-end:** `e2e/run.sh`. It builds the app against real Postgres with migrations
  0001–0004, PostgREST v14 and a mock Auth server. Chromium's fake camera plays a video of a
  genuinely signed QR. 20 checks cover:
  - sign-in and bad passwords
  - camera decode, then server verification
  - +1, Undo and +2 against the database
  - replay rejection
  - view-only lookup
  - the live anti-fraud self-test
  - server search and the shift ledger
  - credential lockdown
  - cross-tenant isolation
  - zero console errors

  It needs the `postgrest` binary in `e2e/`, Python with Playwright, and `E2E_PSQL` /
  `E2E_DB_ADMIN` if your `psql` defaults differ.

  The harness has no Realtime server, so check live updates on a real Supabase project: stamp on
  terminal A and watch terminal B's Recent Guests.

## Operational notes

- **Offline:** actions are disabled and labelled. Nothing is queued, because stamps need a live
  server decision.
- **Cooldown and daily limits** are per program. With a 0 s cooldown, the one-issuance-per-scan
  rule still prevents repeat clicks.
- **Clock skew** between the phone and the server is corrected by the customer pass. The server
  accepts tokens from 60 s in the past to 30 s in the future.
- **Housekeeping:** schedule `private.prune_qr_token_uses()` daily with pg_cron (see migration 0003).
- **Scanner library:** `html5-qrcode` 2.3.8 hasn't been updated since 2023. It's wrapped in one
  hook (`useQrScanner`), so replacing it touches a single file.
