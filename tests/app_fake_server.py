"""Runs app.py's web page with a fake printer and a fake Google Sheet, for tests/app_test.mjs.
Usage: python tests/app_fake_server.py PORT   (needs: pip install flask)
POST /__state returns what was printed and what's on the fake sheet; POST /__fail {n, after} makes
N sheet reads fail, after `after` good ones."""
import os, sys, json
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import app

HEADERS = ["Ticket", "Row", "Supplier", "Skid ID", "Status", "QTY/LOAD", "C/S", "Weight"]
sheet = [HEADERS, ["111326-001", "", "", "SKD-000007", "Current", "", "", ""]]
printed = []
fail = {"n": 0, "after": 0}

class FakeWS:
    def col_values(self, i):
        if fail["after"] > 0:
            fail["after"] -= 1
        elif fail["n"] > 0:
            fail["n"] -= 1
            raise RuntimeError("Google said no (test)")
        return [r[i - 1] if i - 1 < len(r) else "" for r in sheet]
    def append_rows(self, rows, value_input_option=None):
        sheet.extend(rows)

app._get_worksheet = lambda: (FakeWS(), HEADERS)
app.print_raw = lambda data: printed.append(len(data))
import time as _t
_sleep = _t.sleep
_t.sleep = lambda s: None   # no waiting between retries in tests

from flask import request, jsonify

@app.app_flask.route("/__state", methods=["POST"])
def _state():
    return jsonify(printed=len(printed), sheet=[r[0] for r in sheet[1:]], skids=[r[3] for r in sheet[1:]])

@app.app_flask.route("/__fail", methods=["POST"])
def _fail():
    j = request.get_json(force=True, silent=True) or {}
    fail["n"], fail["after"] = int(j.get("n", 0)), int(j.get("after", 0))
    return jsonify(ok=True)

if __name__ == "__main__":
    app.app_flask.run(host="127.0.0.1", port=int(sys.argv[1]), threaded=True)
