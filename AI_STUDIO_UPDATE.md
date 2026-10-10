# Updating the live deployment (from Google AI Studio)

**Why the live site still shows the prototype:** the Vercel project deploys the code held in
Google AI Studio, and AI Studio still holds the original prototype. The ported app in this zip has
never been deployed. Its demo users, member switcher and direct-to-scanner behaviour don't exist
in this code, so the fix is to deploy **this** codebase.

## Recommended path: GitHub → Vercel (bypasses AI Studio)

1. Create a new GitHub repo. Extract this zip into it and commit everything, including
   `package-lock.json`. Push.
2. In Vercel, open the existing project → *Settings → Git* → connect the new repo (or create a new
   project). Set the Framework Preset to **Vite**.
3. Set the environment variables (see `.env.example` and `DEPLOY.md` step C3), then **Redeploy
   with "Use existing Build Cache" unticked**.
4. Confirm the deploy took effect: open the site and *View Source*. The `<title>` must be the one
   listed below, not the prototype's.

## If you must stay in AI Studio

Apply **every** change below; a partial copy leaves prototype code in the bundle. Then:

- Don't ask the AI Studio model to "fix" or "improve" these files afterwards. It regenerates code
  and can reintroduce demo data, hard-coded keys or the `fetch` patch.
- AI Studio does not run `npm install` from `package-lock.json` the way Vercel does. Make sure its
  `package.json` matches this zip exactly (dependencies were added and removed).
- After deploying, run `node --env-file=.env.local scripts/check-backend.mjs` (merchant repo) with
  `DEPLOY_URL=<the live URL>`. It fails if the live bundle doesn't target your project/key.

### Merchant Countertop Scanner: file changes vs. the AI Studio prototype

**Live check after deploy:** page source must contain
`content="Countertop QR scanner and loyalty stamp terminal for merchant staff."` and the viewport must
**not** contain `user-scalable=no`. The first screen must be **Staff Sign-in**.

**DELETE:** `bun.lock`, `metadata.json`

**REPLACE (overwrite entirely):** `.env.example`, `.gitignore`, `README.md`, `index.html`, `package.json`,
`src/App.tsx` (the 100 KB prototype becomes a small root; the UI moved to `src/terminal/Terminal.tsx`),
`src/index.css`, `src/lib/supabase.ts`, `src/main.tsx`, `tsconfig.json`, `vite.config.ts`

**ADD:** `package-lock.json`, `vercel.json`, `DEPLOY.md`, `public/manifest.webmanifest`, `public/icons/icon.svg`,
`src/vite-env.d.ts`, `src/components/{AuthGate,ErrorBoundary,LoginScreen,Shell}.tsx`,
`src/hooks/{useKeyboardWedge,useOnlineStatus,useQrScanner}.ts`,
`src/lib/{api,auth,env,errors,model,sound}.ts`, `src/terminal/Terminal.tsx`,
`scripts/{check-backend,customer-token,seed-dev}.mjs`,
`supabase/migrations/2026093000000{1,2,3}_*.sql`, `supabase/migrations/2026100200000{4,5}_*.sql`,
`supabase/tests/{stamp_engine_smoke,terminal_flow,verify_deployment}.sql`, `e2e/*` (optional)
