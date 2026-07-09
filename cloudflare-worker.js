/**
 * Litho Floor App — Cloudflare Worker (API proxy)
 *
 * Sits between the static UI (GitHub Pages) and the Apps Script JSON API (doPost). It's the
 * only thing that knows the Apps Script URL — that stays a Worker secret and never reaches the
 * browser. Human access is gated in front of this Worker by Cloudflare Access (Google SSO,
 * restricted to cscmfg.com), so a request only reaches here after the user has signed in.
 *
 * Bindings to set in the Cloudflare dashboard (Settings > Variables):
 *   APPS_SCRIPT_URL  (Secret)   the "Anyone" Apps Script /exec URL, e.g.
 *                               https://script.google.com/macros/s/AKfyc.../exec
 *   ALLOWED_ORIGIN   (Variable) optional; the site origin allowed to call this. Only needed if
 *                               the UI is on a DIFFERENT origin than the Worker (cross-origin).
 *                               If the site and /api share one domain, leave it unset.
 *   API_SECRET       (Secret)   optional; if the Apps Script has an API_SECRET script property,
 *                               set the same value here and it's forwarded on every call.
 *
 * The browser sends a text/plain JSON body ({fn, args, secret}) so no CORS preflight is needed;
 * this Worker forwards it verbatim to Apps Script (also text/plain, which Apps Script accepts),
 * follows Google's redirect, and returns the JSON.
 */
export default {
  async fetch(request, env) {
    const allowOrigin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (obj, status) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);
    if (!env.APPS_SCRIPT_URL) return json({ ok: false, error: 'Worker not configured: APPS_SCRIPT_URL missing' }, 500);

    let payload;
    try {
      payload = JSON.parse((await request.text()) || '{}');
    } catch (e) {
      return json({ ok: false, error: 'Bad request body' }, 400);
    }
    // Inject the shared secret from the Worker so it never has to live in the public page.
    if (env.API_SECRET) payload.secret = env.API_SECRET;

    try {
      const upstream = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow',
      });
      const text = await upstream.text();
      // Apps Script returns the JSON body from doPost; pass it straight through.
      return new Response(text, { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    } catch (e) {
      return json({ ok: false, error: 'Upstream error: ' + (e && e.message ? e.message : String(e)) }, 502);
    }
  },
};
