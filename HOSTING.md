# Hosting: GitHub Pages front end + Cloudflare Worker backend

```
Browser (github.io page)  ──fetch {fn,args}──▶  Cloudflare Worker  ──▶  Google Sheet
   docs/index.html                                worker.js              (service account)
```

- **GitHub Pages** serves the UI (`docs/index.html`) — a plain `*.github.io` URL, no custom
  domain needed.
- **Cloudflare Worker** (`worker.js`) is the backend: it reads/writes the spreadsheet directly
  with a **Google service account** (no Apps Script). Self-contained — paste it into a dashboard
  Worker, no build step.
- The Apps Script app keeps working as a fallback the whole time. **Stage 1 = reads only** on the
  new backend; writes still go through Apps Script until Stage 2 is finished.

> Not using Cloudflare Pages for this. If you started a Pages project earlier, you can delete it.

---

## Step 1 — Service account can reach the sheet
1. Share the **Traceability Test** spreadsheet with the service account's email
   (`…@…iam.gserviceaccount.com`, the `client_email` in the key JSON) — give it **Editor**.
2. Google Cloud Console → the service account's project → **APIs & Services → Library →
   Google Sheets API → Enable**.

## Step 2 — Create the Cloudflare Worker
1. Cloudflare → **Workers & Pages → Create → Create Worker** → name it e.g. `litho-api` → Deploy.
2. **Edit code** → delete the template → paste all of **`worker.js`** → **Deploy**.
3. **Settings → Variables and Secrets → Add:**
   - `GCP_SA_EMAIL` (Secret) = the service account email.
   - `GCP_SA_PRIVATE_KEY` (Secret) = the `private_key` value from the key JSON (paste verbatim;
     the `\n`s are fine).
   - `SHEET_ID` (optional) — only if it's ever not the default.
   - `ALLOWED_ORIGIN` (optional) = `https://<youruser>.github.io` to lock CORS to your page.
   - `API_TOKEN` (optional Secret) = a long random string, if you want a shared-token gate.
   - Deploy again after adding variables.
4. Copy the Worker URL, e.g. `https://litho-api.<subdomain>.workers.dev`.
5. Test: open that URL in a browser → `{"ok":true,"service":"litho-api","stage":"reads"}`.

## Step 3 — Point the front end at the Worker
In `docs/index.html`, set near the top:
```js
var LITHO_API_URL = 'https://litho-api.<subdomain>.workers.dev';  // your Worker URL
var LITHO_API_SECRET = '';   // set only if you added API_TOKEN in Step 2
```
Commit. (Or paste me the Worker URL and I'll set it and push.)

## Step 4 — Turn on GitHub Pages
1. GitHub repo → **Settings → Pages**.
2. **Custom domain:** clear it if anything is there (we're using the plain github.io URL).
3. **Source: Deploy from a branch** → Branch `claude/litho-transactions-review-m1m762`,
   Folder **`/docs`** → Save. *(The repo root has `Index.HTML` with a capital I, which Pages
   won't serve as an index — `/docs` has the correct lowercase `index.html`.)*
4. Wait ~1 min → open the `https://<youruser>.github.io/litho-transactions-app/` URL.

## Step 5 — Verify
- The app loads the ticket list **from the sheet, fast**, and you can browse tickets and the
  Review tab.
- Actions (log coating, jobs, edits) show "not on the new backend yet (Stage 2)" — expected.
  Keep using Apps Script for real work until Stage 2 ships.

## Troubleshooting
- App shows **"Service account not configured"** → the Worker secrets didn't save, or you didn't
  redeploy after adding them.
- **"Sheets API 403"** → the sheet isn't shared with the service account email, or the Sheets API
  isn't enabled on its project.
- **Nothing loads / CORS error in dev-tools** → `LITHO_API_URL` in `docs/index.html` doesn't
  match the Worker URL, or `ALLOWED_ORIGIN` doesn't match your github.io origin (or leave it
  unset to allow all).
- Page 404 "provide an index.html" → Pages Source is the repo root; switch it to **`/docs`**.

## Security note
With a plain github.io page, the optional `API_TOKEN` lives in the page source, so it only
deters casual access. It's fine for an internal floor tool; if you later want a real login gate,
we can move the page onto a Cloudflare-proxied domain and add Cloudflare Access (Google SSO).

## Stage 2 (next)
Writes — logging coatings, jobs/approval, edits — added to `worker.js`, with a Durable Object
handling the Skid/Job ID counters and one-operator-at-a-time safety. Only after you've tested
Stage 2 do you switch the floor off Apps Script.
