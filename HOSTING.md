# Hosting the Litho Floor App

The app can run two ways, both from the **same** `Code.gs` and UI:

1. **Apps Script hosting** — open the Apps Script `/exec` URL directly. Nothing else needed;
   this stays the fallback.
2. **Cloudflare Pages (recommended)** — the UI is a static page on Cloudflare Pages (built from
   this GitHub repo); a bundled Pages Function forwards its calls to a JSON version of the
   backend; Cloudflare Access gates the whole thing to cscmfg.com Google logins.

```
Browser ──▶ your-site.pages.dev          (static UI from /docs)
        ──▶ your-site.pages.dev/api       (Pages Function — holds the secret Apps Script URL)
        ──▶ Apps Script /exec (doPost)    ("Anyone" JSON API; URL never shown to the browser)
   ▲
   └── Cloudflare Access (Google SSO, @cscmfg.com) gates the site before anything loads.
```

Everything is on one Cloudflare domain, so the page and `/api` are same-origin — no CORS, no
DNS dance, and Access covers both.

## What's already in the repo
- `Code.gs` — has a `doPost(e)` JSON API (whitelist of exactly the functions the UI calls).
- `docs/index.html` — the UI for Pages (copy of `Index.HTML`). Its hosting shim recreates
  `google.script.run` over `fetch` to `/api` when not served by Apps Script.
- `functions/api.js` — the Pages Function that proxies `/api` → Apps Script.
- `cloudflare-worker.js` — a standalone-Worker version (only if you ever want a separate Worker
  on a custom domain instead of the Pages Function; not needed for the steps below).

> `docs/index.html` is a copy of `Index.HTML`. After a UI change, run
> `cp Index.HTML docs/index.html` (or ask and it'll be regenerated).

---

## Step 1 — Deploy Apps Script as an "Anyone" JSON API
Your cscmfg.com-restricted deployment can't be called by a server, so make a second one:
1. Spreadsheet → **Extensions → Apps Script**, make sure the latest `Code.gs` is pasted, **Save**.
2. **Deploy → New deployment → ⚙ → Web app.**
3. **Execute as: Me** · **Who has access: Anyone** → **Deploy** → authorize.
4. Copy the URL — `https://script.google.com/macros/s/AKfyc.../exec` (**no** `/a/macros/cscmfg.com/`).
   Keep it private; it only goes into Cloudflare.
5. *(Optional)* Apps Script → **Project Settings → Script Properties** → add `API_SECRET` = a long
   random string. If set, add the same value in Step 2.

## Step 2 — Create the Cloudflare Pages project
1. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → authorize GitHub, pick
   `jmarrujo-jpg/litho-transactions-app`.
2. **Production branch:** `claude/litho-transactions-review-m1m762` (or your default branch if you
   merge this one first).
3. Build settings: **Framework preset: None** · **Build command:** *(leave empty)* ·
   **Build output directory:** `docs`.
4. **Save and Deploy.** You get a URL like `https://litho-transactions-app.pages.dev`.
5. Project → **Settings → Variables and secrets → Add** (Production):
   - `APPS_SCRIPT_URL` = the "Anyone" `/exec` URL from Step 1 (mark as **Secret / Encrypt**).
   - `API_SECRET` = same value as Step 1, only if you set one (**Secret**).
   - **Save**, then **Deployments → Retry deployment** (so the function picks up the variables).

## Step 3 — Confirm it works (before locking it down)
1. Open `https://<your-site>.pages.dev/api` → you should see
   `{"ok":true,"service":"litho-api",...}` (the function is live).
2. Open `https://<your-site>.pages.dev` → the app loads and the ticket list appears.
3. Log a coating / create a job → confirm it writes to the sheet (the proxy is reaching Apps
   Script). `LITHO_API_URL` is already set to `/api` in the code, so nothing to edit.

## Step 4 — Gate it with Google SSO (Cloudflare Access)
1. Cloudflare → **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. **Application domain:** your `*.pages.dev` hostname (covers the page and `/api`).
3. **Identity providers:** add **Google Workspace** if not present (Zero Trust → Settings →
   Authentication).
4. **Policy:** Action **Allow**, rule **Emails ending in** `@cscmfg.com` → **Save.**
5. Reopen the site in a fresh browser → Google sign-in → after a cscmfg.com login it loads.

## Step 5 (optional) — Nicer URL
Pages project → **Custom domains → Set up a domain** → `litho.cscmfg.com`. Because the domain is
in your Cloudflare account, DNS + HTTPS are created automatically (no GitHub-Pages DNS dance).
Then point the Access application at `litho.cscmfg.com` too.

---

## Troubleshooting
- `/api` returns **500 "APPS_SCRIPT_URL not set"** → the env var didn't save, or you didn't
  redeploy after adding it (Step 2.5).
- App loads but every action errors → open dev-tools Network on an `/api` call: a login
  redirect/401 means Access isn't covering `/api` (use the bare hostname in Step 4, not a path);
  a 502 means the Apps Script URL is wrong or still cscmfg-restricted (must be the "Anyone" one).
- Still works on the plain Apps Script `/exec` URL — the shim detects the real bridge and stays
  out of the way, so that remains a fallback.
