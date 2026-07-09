/**
 * Litho Floor App — Cloudflare Pages Function (API proxy)
 *
 * Deploys automatically with the Pages site and serves at  <your-site>/api .
 * It's the only thing that knows the Apps Script URL (kept as a Pages secret,
 * never sent to the browser). Because it's the same origin as the page, no CORS
 * is needed, and Cloudflare Access protects it along with the rest of the site.
 *
 * Set these in the Pages project (Settings > Variables and secrets):
 *   APPS_SCRIPT_URL  (secret)  the "Anyone" Apps Script /exec URL
 *   API_SECRET       (secret)  optional; matches the API_SECRET script property if you set one
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.APPS_SCRIPT_URL) return json({ ok: false, error: 'APPS_SCRIPT_URL not set' }, 500);

  let payload;
  try {
    payload = JSON.parse((await request.text()) || '{}');
  } catch (e) {
    return json({ ok: false, error: 'Bad request body' }, 400);
  }
  // Inject the shared secret server-side so it never lives in the public page.
  if (env.API_SECRET) payload.secret = env.API_SECRET;

  try {
    const upstream = await fetch(env.APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
    const text = await upstream.text();
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return json({ ok: false, error: 'Upstream error: ' + (e && e.message ? e.message : String(e)) }, 502);
  }
}

// A GET to /api just confirms the function is deployed (handy for a quick check).
export function onRequestGet() {
  return json({ ok: true, service: 'litho-api', hint: 'POST {fn,args} here' }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
