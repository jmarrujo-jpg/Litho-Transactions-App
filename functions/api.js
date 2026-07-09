/**
 * Litho Floor App — Cloudflare Pages Function (backend entry, serves at /api).
 *
 * The browser POSTs {fn, args} here; this runs the corresponding backend function (which talks
 * to the Google Sheet via a service account) and returns {ok, result} or {ok:false, error}.
 *
 * Pages env vars / secrets (Settings > Variables and secrets):
 *   GCP_SA_EMAIL        service account email (client_email from the key JSON)
 *   GCP_SA_PRIVATE_KEY  the private_key from the key JSON (PEM)
 *   SHEET_ID            spreadsheet id (optional; defaults to the known one)
 */
import { handle } from './_lib/backend.js';

const json = (obj, status) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export async function onRequestPost(context) {
  const { request, env } = context;
  let payload;
  try {
    payload = JSON.parse((await request.text()) || '{}');
  } catch (e) {
    return json({ ok: false, error: 'Bad request body' }, 400);
  }
  try {
    const result = await handle(payload.fn, payload.args || [], env);
    return json({ ok: true, result }, 200);
  } catch (e) {
    // 200 with ok:false so the client's failure handler surfaces the message cleanly.
    return json({ ok: false, error: e && e.message ? e.message : String(e) }, 200);
  }
}

// GET /api is a health check.
export function onRequestGet() {
  return json({ ok: true, service: 'litho-api', stage: 'reads', hint: 'POST {fn,args}' }, 200);
}
