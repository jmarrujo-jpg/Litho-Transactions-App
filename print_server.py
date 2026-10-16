"""
Zebra print server for Windows.

Your web app sends a label (ZPL) to this PC, and this PC sends it to the
Zebra printer over the network. No print dialog, no AirPrint.

The printer is tracked by its MAC address, which never changes. If the
printer's IP address changes, the server scans the network, finds the
printer again by its MAC address, and keeps printing.

Setup:
  1. Change TOKEN below (any password you like).
  2. Run:  python print_server.py
  3. On your iPhone, open  http://192.168.1.214:8000  and tap "Print test label".

Web app print button should POST to:  http://192.168.1.214:8000/print

The Litho app's "Print skid traveler" button opens  http://192.168.1.214:8000/label#<label>
instead: the app is https and this server is plain http, so browsers won't let the app POST here
in the background — but they do let it open a tab. The /label page sends the label to /print
(same server, so nothing is blocked), says "Printed", and closes itself.

Uses only the Python standard library, so there is nothing else to install.
"""

import json
import re
import socket
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---- Settings -------------------------------------------------------------
PRINTER_MAC = "60-95-32-0b-e0-1f"  # the printer's permanent hardware ID
PRINTER_IP = "192.168.1.118"       # last known address; updated automatically
PRINTER_PORT = 9100                # standard raw printing port on Zebra printers
SERVER_PORT = 8000                 # port your web app connects to on this PC
TOKEN = "change-me"                # shared secret; your web app must send this
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_current_ip = PRINTER_IP


def normalize_mac(mac: str) -> str:
    """'60:95:32:B:E0:1F' or '60-95-32-0b-e0-1f' -> '60-95-32-0b-e0-1f'."""
    parts = re.split(r"[:-]", mac.strip())
    return "-".join(p.zfill(2).lower() for p in parts)


TARGET_MAC = normalize_mac(PRINTER_MAC)


def read_arp_table() -> dict:
    """Return {ip: mac} from the computer's ARP table (works on Windows, Mac, Linux)."""
    try:
        out = subprocess.run(["arp", "-a"], capture_output=True, text=True,
                             errors="ignore", timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    return parse_arp(out)


def parse_arp(text: str) -> dict:
    table = {}
    for line in text.splitlines():
        ip = re.search(r"(\d{1,3}(?:\.\d{1,3}){3})", line)
        mac = re.search(r"([0-9a-fA-F]{1,2}(?:[:-][0-9a-fA-F]{1,2}){5})", line)
        if ip and mac:
            table[ip.group(1)] = normalize_mac(mac.group(1))
    return table


def mac_of(ip: str) -> str:
    return read_arp_table().get(ip, "")


def local_network_prefix() -> str:
    """Work out this PC's network, e.g. '192.168.1.' (ignores virtual adapters)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((_current_ip, PRINTER_PORT))  # no data is sent
        my_ip = s.getsockname()[0]
    finally:
        s.close()
    return my_ip.rsplit(".", 1)[0] + "."


def _poke(ip: str) -> None:
    """Briefly contact an address so it shows up in the ARP table."""
    try:
        socket.create_connection((ip, PRINTER_PORT), timeout=0.5).close()
    except OSError:
        pass


def find_printer() -> str:
    """Scan the local network and return the printer's current IP, or ''."""
    prefix = local_network_prefix()
    print(f"Looking for printer {TARGET_MAC} on {prefix}0/24 ...")
    with ThreadPoolExecutor(max_workers=100) as pool:
        pool.map(_poke, [f"{prefix}{n}" for n in range(1, 255)])
    for ip, mac in read_arp_table().items():
        if mac == TARGET_MAC:
            print(f"Found printer at {ip}")
            return ip
    print("Printer not found. Is it turned on and connected to the network?")
    return ""


def _send(ip: str, zpl: str) -> None:
    with socket.create_connection((ip, PRINTER_PORT), timeout=5) as s:
        # Make sure this address is still OUR printer before sending anything.
        if mac_of(ip) != TARGET_MAC:
            raise LookupError(f"{ip} is no longer the printer")
        s.sendall(zpl.encode("utf-8"))


def send_to_printer(zpl: str) -> str:
    """Send ZPL to the printer, re-finding it by MAC if its IP has changed.
    Returns the IP that was used."""
    global _current_ip
    with _lock:
        try:
            _send(_current_ip, zpl)
            return _current_ip
        except (OSError, LookupError) as first_error:
            print(f"Couldn't use {_current_ip} ({first_error}); searching for printer...")
            new_ip = find_printer()
            if not new_ip:
                raise ConnectionError("Printer not found on the network. "
                                      "Check that it is on and plugged in.")
            _current_ip = new_ip
            _send(_current_ip, zpl)
            return _current_ip


SAMPLE_ZPL = """^XA
^FO50,50^A0N,40,40^FDHello from the web app^FS
^FO50,110^BY2^BCN,80,Y,N,N^FD12345678^FS
^XZ"""

TEST_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Label printer</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0;
         padding: 24px; max-width: 520px; color: #1d1d1f; background: #fff; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  p { color: #555; margin: 0 0 16px; }
  textarea { width: 100%; box-sizing: border-box; height: 150px;
             font: 14px/1.4 ui-monospace, Menlo, Consolas, monospace;
             padding: 10px; border: 1px solid #ccc; border-radius: 8px; }
  button { margin-top: 12px; width: 100%; padding: 16px; font-size: 1.1rem;
           font-weight: 600; border: 0; border-radius: 10px;
           background: #1f6feb; color: #fff; }
  button:disabled { opacity: .6; }
  #status { margin-top: 12px; font-weight: 600; min-height: 1.4em; }
  .ok { color: #1a7f37; } .err { color: #c62828; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee; } p { color: #aaa; }
    textarea { background: #1c1c1e; color: #eee; border-color: #444; }
  }
</style>
</head>
<body>
<h1>Label printer</h1>
<p>Sends this label straight to the Zebra printer.</p>
<textarea id="zpl">__SAMPLE__</textarea>
<button id="go">Print test label</button>
<div id="status"></div>
<script>
const btn = document.getElementById("go");
const status = document.getElementById("status");
btn.onclick = async () => {
  btn.disabled = true; status.textContent = "Printing..."; status.className = "";
  try {
    const r = await fetch("/print", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Print-Token": "__TOKEN__" },
      body: JSON.stringify({ zpl: document.getElementById("zpl").value })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Print failed");
    status.textContent = "Printed (printer at " + data.printer_ip + ").";
    status.className = "ok";
  } catch (e) {
    status.textContent = e.message; status.className = "err";
  }
  btn.disabled = false;
};
</script>
</body>
</html>"""


# Opened by the Litho app's Print button with the label after the # (base64url ZPL; the part after
# # never reaches the server). Prints it, then closes the tab. On a problem it stays open and says so.
LABEL_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Printing…</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 0; padding: 32px 24px;
         max-width: 520px; color: #1d1d1f; background: #fff; text-align: center; }
  #msg { font-size: 1.6rem; font-weight: 700; margin-top: 30vh; }
  #more { color: #555; margin-top: 12px; font-size: 1.05rem; }
  button { margin-top: 20px; padding: 14px 28px; font-size: 1.1rem; font-weight: 600;
           border: 0; border-radius: 10px; background: #1f6feb; color: #fff; display: none; }
  .ok { color: #1a7f37; } .err { color: #c62828; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } #more { color: #aaa; } }
</style>
</head>
<body>
<div id="msg">Printing…</div>
<div id="more"></div>
<button id="close" onclick="window.close()">Close</button>
<script>
const msg = document.getElementById("msg"), more = document.getElementById("more"), closeBtn = document.getElementById("close");
function fail(text) {
  msg.textContent = text; msg.className = "err";
  more.textContent = "Nothing was printed. Close this tab, then in the app tap \\u201cPrint with the print dialog instead\\u201d.";
  closeBtn.style.display = "inline-block";
}
(async () => {
  const h = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);   // a reload won't print it twice
  if (!h) return fail("No label was sent. Press Print in the app.");
  let zpl;
  try { zpl = atob(h.replace(/-/g, "+").replace(/_/g, "/")); }
  catch (e) { return fail("The label didn\\u2019t come through whole. Press Print in the app again."); }
  try {
    const r = await fetch("/print", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Print-Token": "__TOKEN__" },
      body: JSON.stringify({ zpl })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Print failed");
  } catch (e) {
    return fail(/not found|reach|refused|timed out/i.test(e.message) ? "Can\\u2019t reach the Zebra printer \\u2014 is it on and plugged in?" : e.message);
  }
  msg.textContent = "\\u2713 Printed"; msg.className = "ok";
  setTimeout(() => window.close(), 400);
  // Some browsers won't let a page close a tab it didn't open itself.
  setTimeout(() => { more.textContent = "You can close this tab."; closeBtn.style.display = "inline-block"; }, 1500);
})();
</script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        # Lets a web app hosted elsewhere call this server.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Print-Token")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/label":
            page = LABEL_PAGE.replace("__TOKEN__", TOKEN).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(page)
            return
        if self.path == "/status":
            return self._json(200, {"printer_ip": _current_ip, "printer_mac": TARGET_MAC})
        if self.path != "/":
            return self._json(404, {"error": "Not found"})
        page = (TEST_PAGE.replace("__SAMPLE__", SAMPLE_ZPL)
                         .replace("__TOKEN__", TOKEN)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def do_POST(self):
        if self.path != "/print":
            return self._json(404, {"error": "Not found"})
        if self.headers.get("X-Print-Token") != TOKEN:
            return self._json(401, {"error": "Wrong or missing token"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "Body must be JSON like {\"zpl\": \"^XA...^XZ\"}"})
        zpl = str(data.get("zpl", "")).strip()
        if not zpl:
            return self._json(400, {"error": "No label data (zpl) sent"})
        try:
            ip = send_to_printer(zpl)
            print(f"Printed job from {self.client_address[0]} on printer at {ip}")
            return self._json(200, {"ok": True, "printer_ip": ip})
        except (OSError, LookupError) as e:
            return self._json(502, {"error": str(e)})


if __name__ == "__main__":
    # Confirm the printer's location at startup.
    if mac_of(_current_ip) != TARGET_MAC:
        _poke(_current_ip)
        if mac_of(_current_ip) != TARGET_MAC:
            _current_ip = find_printer() or _current_ip
    print(f"Printer {TARGET_MAC} is at {_current_ip}")
    server = ThreadingHTTPServer(("0.0.0.0", SERVER_PORT), Handler)
    print(f"Print server running on port {SERVER_PORT}.")
    print("Open http://192.168.1.214:%d on your phone to test. Ctrl+C to stop." % SERVER_PORT)
    server.serve_forever()
