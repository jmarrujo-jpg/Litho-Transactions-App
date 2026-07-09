/**
 * Google auth + Sheets access for the Cloudflare backend.
 *
 * Uses a service account (no user login) to read/write the spreadsheet the account has been
 * shared on. The private key is signed in-Worker (Web Crypto RS256) into a JWT, exchanged for
 * an OAuth access token, which is cached in the isolate until shortly before it expires.
 *
 * Required Pages env vars / secrets:
 *   GCP_SA_EMAIL         service account email (client_email from the key JSON)
 *   GCP_SA_PRIVATE_KEY   the private_key from the key JSON (PEM). Paste it verbatim; literal
 *                        "\n" sequences are handled.
 *   SHEET_ID             the spreadsheet id (defaults to the known Traceability Test id)
 */
const DEFAULT_SHEET_ID = '12Irb-isWOO14SrlGglcgnHc8oi0mLwW54LNo7pBHKjg';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

let cachedToken = null; // { token, exp } — best-effort reuse across requests on the same isolate

function b64urlFromBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlFromString(str) {
  return b64urlFromBytes(new TextEncoder().encode(str));
}
function pemToPkcs8(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const raw = atob(body);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

async function mintToken(env) {
  const email = env.GCP_SA_EMAIL;
  const key = (env.GCP_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Service account not configured (GCP_SA_EMAIL / GCP_SA_PRIVATE_KEY).');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = b64urlFromString(JSON.stringify(header)) + '.' + b64urlFromString(JSON.stringify(claim));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', pemToPkcs8(key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsigned));
  const jwt = unsigned + '.' + b64urlFromBytes(new Uint8Array(sigBuf));

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error('Token exchange failed: ' + (data.error_description || data.error || resp.status));
  }
  return { token: data.access_token, exp: now + (data.expires_in || 3600) };
}

async function getToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  cachedToken = await mintToken(env);
  return cachedToken.token;
}

/** A thin Sheets client bound to one spreadsheet + a fresh token. */
export async function makeSheets(env) {
  const token = await getToken(env);
  const id = env.SHEET_ID || DEFAULT_SHEET_ID;
  const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + id;
  const auth = { Authorization: 'Bearer ' + token };

  async function call(url, opts) {
    const r = await fetch(url, opts);
    const t = await r.text();
    let j;
    try { j = t ? JSON.parse(t) : {}; } catch (e) { throw new Error('Sheets API non-JSON response: ' + t.slice(0, 200)); }
    if (!r.ok) throw new Error('Sheets API ' + r.status + ': ' + (j.error && j.error.message ? j.error.message : t.slice(0, 200)));
    return j;
  }

  return {
    id: id,
    /** Values of one A1 range as a 2D array (formatted strings unless unformatted=true). */
    async read(rangeA1, unformatted) {
      const q = unformatted
        ? '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER'
        : '?valueRenderOption=FORMATTED_VALUE';
      const j = await call(base + '/values/' + encodeURIComponent(rangeA1) + q, { headers: auth });
      return j.values || [];
    },
    /** Append one row to a sheet (values in header order). */
    async append(rangeA1, row) {
      return call(base + '/values/' + encodeURIComponent(rangeA1) +
        ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [row] }) });
    },
    /** Overwrite one A1 range with the given 2D values. */
    async update(rangeA1, values) {
      return call(base + '/values/' + encodeURIComponent(rangeA1) + '?valueInputOption=RAW',
        { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
    },
    /** Batch of {range, values} writes in one call. */
    async batchUpdate(data) {
      return call(base + '/values:batchUpdate',
        { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'RAW', data }) });
    },
  };
}

/** A Google serial date (days since 1899-12-30) -> yyyy-MM-dd in the given IANA tz. */
export function serialToYMD(serial, tz) {
  if (!serial && serial !== 0) return '';
  const ms = Math.round((Number(serial) - 25569) * 86400 * 1000); // 25569 = days from 1899-12-30 to 1970-01-01
  const d = new Date(ms);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch (e) {
    return d.toISOString().slice(0, 10);
  }
}
