# Supabase setup and Cloudflare Pages deployment

This guide takes the app from local development to a hosted, synced PWA. Do the security checks in
step 4 before entering real financial records.

## 1. Local development

```bash
npm install
npx supabase start          # local Postgres, Auth, Realtime and Studio in Docker
npx supabase db reset       # apply supabase/migrations to the local database
```

Create `.env.local` (git-ignored) from `.env.example`. For the local stack, use the URL and
publishable key printed by `npx supabase status`:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

```bash
npm run dev                 # http://localhost:5173 — sign-in screen, then the app
```

Leave both variables empty to run the app local-only (no sign-in, no sync). The dev server allows
that, but `npm run build` stops with an error unless you also set `ALLOW_LOCAL_ONLY_BUILD=true` (see
step 5). Local Studio is at
http://127.0.0.1:54323 and test emails (password resets) arrive in Mailpit at http://127.0.0.1:54324.

## 2. Tests

| Command                             | Needs                                                                                      | What it covers                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                          | nothing                                                                                    | Calculations, imports and duplicates, persistence, backup/restore, row mapping, sync engine (two devices, conflicts, offline, lost responses), sign-in UI |
| `npm run test:db`                   | `npx supabase start` + `db reset`                                                          | Real RLS isolation between users and anonymous visitors, sync protocol, constraints, and two devices syncing through the real API                         |
| `npm run check:pwa`                 | `npm run build` + `npx vite preview --port 4173`, Microsoft Edge (or `PWA_BROWSER=chrome`) | Service worker, manifest, iOS tags, offline shell, CSP. Set `PWA_TEST_EMAIL`/`PWA_TEST_PASSWORD` (a test account) to also check signed-in offline use     |
| `npm run check:supabase`            | `.env.local` with your project's URL and publishable key                                   | Read-only: project reachable, auth settings, migrations applied, anonymous access denied                                                                  |
| `npm run typecheck`, `npm run lint` | nothing                                                                                    | Types and lint                                                                                                                                            |

Database tests only ever use the publishable key and refuse to run against a non-local URL.

## 3. Create the hosted Supabase project

1. Create a project at https://supabase.com/dashboard. Pick the closest available region. Your data
   may be stored outside South Africa; consider your POPIA obligations (see requirements §7.3).
2. Apply the migrations from this repository:
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
3. **Authentication → URL Configuration**
   - Site URL: your production URL, e.g. `https://finance-hub.pages.dev` (or custom domain).
   - Redirect URLs: the production URL, plus `http://localhost:5173` if you test password resets
     locally.
4. **Authentication → Sign In / Providers → Email**: keep _Confirm email_ on. Set the minimum
   password length to at least 10 and require lower-case, upper-case letters and digits (matching
   `supabase/config.toml`).
5. Create your own account by opening the deployed app and choosing _Create an account_.
6. **Then turn off sign-ups**: Authentication → Sign In / Providers → disable _Allow new users to
   sign up_. This is a single-user app; RLS already isolates users, but nobody else needs an account.
7. Supabase's built-in email sender is heavily rate-limited. For reliable password-reset emails,
   configure custom SMTP (Authentication → Emails → SMTP settings).
8. Copy the **publishable key** (Project Settings → API keys). Never use the secret/service-role
   key in this app; the build stops if you try.

Realtime needs no extra setup: the migration adds the tables to the `supabase_realtime` publication.

## 4. Verify security and recovery before real data

- Run `npm run test:db` locally (same migrations as production).
- In the hosted project, open **Advisors → Security** and confirm there are no RLS warnings.
- Sign in on two devices with test data, make a change on one and confirm it appears on the other.
- Export a backup (Settings → Copy backup text or Download backup file), delete all data on a test
  account, restore the backup, and confirm everything returns on both devices.
- Only then import real statements.

## 5. Deploy to Cloudflare Pages

1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → choose this repository.
2. Build settings:

   | Setting                | Value           |
   | ---------------------- | --------------- |
   | Production branch      | `main`          |
   | Framework preset       | None (or Vite)  |
   | Build command          | `npm run build` |
   | Build output directory | `dist`          |
   | Root directory         | `/`             |

3. Environment variables (Settings → Variables and Secrets), for **Production** (and Preview if you
   use preview deployments):

   | Name                            | Value                               |
   | ------------------------------- | ----------------------------------- |
   | `VITE_SUPABASE_URL`             | `https://<project-ref>.supabase.co` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | the publishable key                 |

   These are build-time values embedded in the JavaScript. They are public by design; RLS protects
   the data. There are no server secrets in this project. The Node version comes from `.nvmrc`
   (20.19.0), so `NODE_VERSION` isn't needed.

   **The build fails on purpose** if either variable is missing, if only one is set, or if the key is
   a secret/service-role key, so a misconfigured deployment can't ship an app without sign-in and
   sync. If a Preview build fails this way, add the variables to the Preview environment too. To
   build the local-only app deliberately, set `ALLOW_LOCAL_ONLY_BUILD=true` instead.

4. Deploy. `public/_headers` adds HSTS, `nosniff`, framing protection, strict referrer and
   permissions policies, no-cache for the service worker and manifest, and long-lived caching for
   hashed assets; the build injects a Content-Security-Policy that only allows your Supabase project.
   Unknown paths fall back to `index.html` (no `404.html`), which the app's routes need.
5. Put the final URL (and any custom domain) into Supabase's Site URL / Redirect URLs (step 3.3).

**Preview deployments** use the same Supabase project, so they can read your real data once you sign
in. Either don't sign in on previews, protect them with Cloudflare Access, or use a separate Supabase
project for Preview variables.

## 6. Install on iPhone and Windows

- **iPhone (Safari):** open the site → Share → _Add to Home Screen_. The installed app has its own
  storage separate from Safari, so sign in once inside it.
- **Windows (Edge/Chrome):** open the site → the install icon in the address bar (or menu → Apps →
  Install).
- Both devices sign in with the same account; changes appear on the other device within seconds while online and queue
  while offline.

## Troubleshooting

| Symptom                                                    | Likely cause                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Build fails with `BuildEnvError`                           | A Supabase variable is missing (or only one is set, or it's a secret key) in that environment; set both in Cloudflare and retry |
| Sign-in works but nothing syncs, console shows a CSP error | `VITE_SUPABASE_URL` at build time differs from the project you use; rebuild                                                     |
| "This device needs to download your data once"             | First sign-in on a device while offline; connect and press Try again                                                            |
| Password-reset link opens the wrong site                   | Site URL / Redirect URLs in Supabase don't match the deployed URL                                                               |
| "Sync problem" with a constraint message                   | A record the server rejected; see Settings → Sync for the record and reason                                                     |
