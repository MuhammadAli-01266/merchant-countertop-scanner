# Rules for editing this project in Google AI Studio

This code was security-reviewed and tested end to end. The AI Studio model can rewrite whole files when
asked for a change; that is how demo data and hard-coded keys came back before. Follow these rules for
every future update.

## Protected files: never let the model change these
`src/lib/api.ts`, `src/lib/auth.ts`, `src/lib/env.ts`, `src/lib/errors.ts`, `src/lib/supabase.ts`, `src/components/AuthGate.tsx`, `src/hooks/useQrScanner.ts`, `vite.config.ts`, `vercel.json`, `supabase/migrations/*`

They contain the security model: stamps are written only by database functions, sessions are checked,
and configuration comes only from environment variables. To change them, edit them by hand in the code
editor, or bring the change back for review.

## Files safe to restyle
`src/terminal/Terminal.tsx` (layout and styling only), `src/components/LoginScreen.tsx` (text and styling only), `src/index.css`

## Hard rules
1. **No keys or project URLs in code.** Configuration comes only from `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY` (merchant: optionally `VITE_CUSTOMER_APP_URL`). No fallbacks, no `define` in vite.config.ts.
2. **No demo or mock data.** No sample customers, preset members, fake stamp counts or "simulate" buttons.
3. **No direct writes to loyalty tables.** Never `.insert/.update/.upsert/.delete` on `loyalty_cards`,
   `stamp_events` or `rewards` from the browser. Use the RPCs in `src/lib/api.ts`.
4. **Don't change the auth flow.** Nothing renders before `AuthGate` confirms a session.
5. **Don't re-add** `fetchPolyfill.ts`, inline `<script>` blocks in `index.html`, `@google/genai`, `express`
   or `esbuild`, and never restore the old `supabase/schema.sql`.
6. After every change, the build must pass: `npm run build` (strict TypeScript).

## Paste this before every request to the AI Studio model
> Constraints for this change: Edit ONLY the files I name. Do not modify any file listed under "Protected
> files" in AI_STUDIO_RULES.md. Do not add API keys, URLs, fallback credentials, demo/mock/sample data, or
> simulated actions. Do not write to loyalty_cards, stamp_events or rewards from the client; use existing
> functions in src/lib/api.ts. Keep environment variables limited to VITE_SUPABASE_URL and
> VITE_SUPABASE_PUBLISHABLE_KEY. Do not rename, move or delete files. Show me the diff before applying.

## Quick self-check after any change
In the code editor, search the project for `sb_publishable_`, `sb_secret_`, `eyJhbGci`, `supabase.co`,
`Elena`, `mock`, `demo`, `.upsert(`. None should appear in `src/`, `index.html` or `vite.config.ts`.
