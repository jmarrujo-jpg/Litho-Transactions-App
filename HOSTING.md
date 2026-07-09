# Hosting the Litho Floor App on your own domain (GitHub Pages + Cloudflare)

The app can run two ways. Both use the **same** `Code.gs` and the same UI.

1. **Apps Script hosting (current):** open the Apps Script `/exec` URL directly. Nothing else
   needed. This is the simplest and stays the fallback.
2. **GitHub Pages + Cloudflare (this doc):** the UI is a static page on your own domain; a
   Cloudflare Worker forwards its calls to a JSON version of the Apps Script backend, and
   Cloudflare Access gates it to cscmfg.com Google logins.

```
Browser ──▶ litho.cscmfg.com            (static UI, served via GitHub Pages)
        ──▶ litho.cscmfg.com/api        (Cloudflare Worker — holds the secret Apps Script URL)
        ──▶ Apps Script /exec (doPost)  ("Anyone" JSON API; URL never shown to the browser)
   ▲
   └── Cloudflare Access (Google SSO, cscmfg.com) gates the whole domain before anything loads.
```

Why a custom domain (`litho.cscmfg.com`) instead of the raw `*.github.io`? Because Cloudflare
Access needs the UI **and** the `/api` Worker to be on the **same domain** — then the browser's
Access login cookie is sent on the `/api` calls and there's no cross-site problem.

---

## What's already in the repo

- `Code.gs` — now has a `doPost(e)` JSON API (a whitelist of exactly the functions the UI calls).
- `docs/index.html` — the UI for GitHub Pages (a copy of `Index.HTML`). It contains a hosting
  shim that recreates `google.script.run` on top of `fetch` when it's *not* served by Apps
  Script. **Set `LITHO_API_URL` near the top of this file to your Worker URL** (see step 4).
- `cloudflare-worker.js` — the Worker that forwards `/api` calls to Apps Script.

> Keeping `docs/index.html` in sync: it's a copy of `Index.HTML`. After any UI change, run
> `cp Index.HTML docs/index.html` (and re-apply your `LITHO_API_URL` value), or just ask and
> it'll be regenerated for you.

---

## Step 1 — Deploy Apps Script as an "Anyone" JSON API

Your current deployment is restricted to cscmfg.com (`/a/macros/cscmfg.com/...`), which a Worker
can't call. Make a **second** deployment for the API:

1. Apps Script editor → **Deploy → New deployment → Web app**.
2. **Execute as:** Me. **Who has access:** **Anyone**.
3. Deploy, authorize, and copy the new URL — it looks like
   `https://script.google.com/macros/s/AKfyc.../exec` (note: **no** `/a/macros/cscmfg.com/`).
4. (Optional, recommended) Add a shared secret: Apps Script → **Project Settings → Script
   Properties → Add** `API_SECRET` = a long random string. If set, the Worker must send it
   (step 4) — `doPost` rejects calls without it.

Keep this URL private — it goes into the Worker only, never into the page.

## Step 2 — Create the Cloudflare Worker

1. Cloudflare dashboard → **Workers & Pages → Create → Worker**. Name it e.g. `litho-api`.
2. Paste the contents of `cloudflare-worker.js` and **Deploy**.
3. **Settings → Variables and Secrets:**
   - `APPS_SCRIPT_URL` = the "Anyone" `/exec` URL from step 1 (add as **Secret**).
   - `API_SECRET` = the same value as the script property, if you set one (**Secret**).
   - `ALLOWED_ORIGIN` — leave unset if the UI and `/api` share a domain (recommended). Set it to
     your site origin only if you host the UI on a different origin.

## Step 3 — Put the UI on GitHub Pages behind your domain

1. GitHub repo → **Settings → Pages** → Source: **Deploy from a branch**, folder **/docs**.
   (Merge this branch to your default branch first, or point Pages at this branch.)
2. Set the custom domain to `litho.cscmfg.com` (GitHub adds a `CNAME` file). GitHub will want a
   DNS record — you'll create it in Cloudflare next.
3. In **Cloudflare DNS** for cscmfg.com, add a **CNAME** `litho` → `<youruser>.github.io`,
   **Proxied (orange cloud)**. Set SSL/TLS mode to **Full**.

## Step 4 — Route `/api` to the Worker and point the UI at it

1. Cloudflare → your `litho-api` Worker → **Settings → Domains & Routes → Add route**:
   `litho.cscmfg.com/api*` (zone cscmfg.com).
2. In `docs/index.html`, set near the top:
   ```js
   var LITHO_API_URL = 'https://litho.cscmfg.com/api';
   var LITHO_API_SECRET = '';   // leave blank — the Worker injects the secret for you
   ```
   Commit and let Pages redeploy.

## Step 5 — Gate it with Cloudflare Access (Google SSO, cscmfg.com)

1. Cloudflare **Zero Trust → Access → Applications → Add a self-hosted application**.
2. Application domain: `litho.cscmfg.com` (covers both the UI and `/api`).
3. Identity provider: **Google Workspace** (add it under Zero Trust → Settings →
   Authentication if you haven't).
4. Policy: **Allow** where **emails ending in** `@cscmfg.com`.
5. Save. Now every visit to `litho.cscmfg.com` requires a cscmfg.com Google login, and the
   `/api` calls ride the same session — no separate login.

---

## Verify

1. Open `https://litho.cscmfg.com` in a fresh browser → you're sent to Google sign-in →
   after a cscmfg.com login the app loads and the ticket list appears.
2. Log a coating / add a job → confirm it writes to the sheet (the Worker is reaching Apps
   Script). If a call fails, open dev-tools Network: a 401/redirect on `/api` means Access
   isn't covering `/api` (check the domain in step 5); a 500 "APPS_SCRIPT_URL missing" means
   the Worker secret isn't set (step 2).
3. Try opening the raw Worker URL or the Apps Script URL without signing in — Access should
   block the domain, and the Apps Script URL isn't discoverable from the page source.

## Security notes

- The Apps Script API is technically "Anyone," but its URL lives only in the Worker secret and
  the human gate is Cloudflare Access. Rotate by redeploying Apps Script (new URL) + updating
  the Worker secret, and/or changing `API_SECRET`.
- The UI still works unchanged when opened via the plain Apps Script `/exec` URL (the shim
  detects the real `google.script.run` and stays out of the way), so you always have a fallback.
