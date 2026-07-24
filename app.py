"""
Container Supply Co. — Metal Identification Ticket printer
Lexmark Forms 2580 (USB, IBM/Proprinter emulation, 3.5" x 8.5" forms).

DARKNESS APPROACH (this version):
  Uses only ESC E (emphasized) + ESC G (double-strike) — the two simple
  single-byte style commands confirmed working in IBM Proprinter mode.
  ESC I is NOT used here (its bit definitions differ between Proprinter
  variants and caused layout corruption in earlier versions).

Setup:
  1. pip install flask pywin32
  2. python app.py  (lists printers — paste exact name into PRINTER_NAME)
  3. http://localhost:5000  or  http://192.168.1.162:5000 on the LAN

Alignment knobs:
  VERTICAL_NUDGE : n/216". 36=one line, 9=quarter. Negative=up. Default -9.
  COL_OFFSET     : whole-ticket left(-)/right(+) in chars.
  COL_L/M/R      : value column starts. R1..R5 : the five field rows.
"""

# ===========================================================================
# CONFIG
# ===========================================================================
PRINTER_NAME   = "Lexmark Forms Printer 2580"

# -------- GOOGLE SHEET LOGGING (service account) ------------------------
# Logs every printed ticket to the Google Sheet using a service account.
# To enable, set all three below. Leave SHEET_ID blank ("") to disable.
#
#   SHEET_ID        : the long id from the sheet URL, between /d/ and /edit
#   SHEET_TAB       : the tab name to append rows to
#   SHEET_CREDS_FILE: path to the service account JSON key file on THIS PC
#
# One-time setup:
#   1) pip install gspread google-auth
#   2) Put the service account JSON key file next to app.py (or give full path)
#   3) Share the Google Sheet with the service account's email (Editor access)
#   4) Make sure the Google Sheets API is enabled in that service account's
#      Google Cloud project (console.cloud.google.com -> APIs & Services)
SHEET_ID         = "12Irb-isWOO14SrlGglcgnHc8oi0mLwW54LNo7pBHKjg"
SHEET_TAB        = "Steel Tickets"
SHEET_CREDS_FILE = "service_account.json"   # filename next to app.py, or full path

FORM_LINES     = 21
VERTICAL_NUDGE = 18        # 1/216" fine nudge. 36=line,18=half,9=quarter. (+)=down
ROW_OFFSET     = 0
COL_OFFSET     = 0

# -------- PITCH ----------------------------------------------------------
# Narrow-carriage 2580: 10 cpi tops out at 80 cols (8.0") and the 8.5" form
# wraps; 12 cpi gives ~96 usable columns and covers the form. Pitch is set
# explicitly so it never depends on the printer's saved default.
CPI = 12
MAX_COL = int(8.0 * CPI) - 1     # 95 — hard wrap guard

# -------- RIGHT-ALIGN COLUMN LINES --------------------------------------
# Each value is RIGHT-aligned so its LAST character lands on the column line
# below (three invisible vertical lines down the sheet). Read off the grid
# ruler: grid number N = column N*10.
#   Section L line = grid 3.3 -> col 33 (shifted +5 from original 28)
#   Section M line = grid 6.2 -> col 62
#   Section R line = grid 9.1 -> col 91
EDGE_L = 33            # left section right-edge   (Row, B/C, Type, Length, Mill)
EDGE_M = 62            # middle section right-edge (Ticket, Basis Wt, ...)
EDGE_R = 91            # right section right-edge  (Supplier, Temper, ...)

# -------- ROWS ----------------------------------------------------------
# Requested rows are half-lines: 7.5, 10.5, 13.5, 16.5, 19.5. We print at the
# integer row and push down a half line via VERTICAL_NUDGE so text centers on
# the .5 line.
R1, R2, R3, R4, R5 = 7, 10, 13, 16, 19
VERTICAL_NUDGE = 18        # 1/216". +18 = half line down (centers on the .5 row)
ROW_OFFSET = 0
COL_OFFSET = 3             # printer lands ~3 cols left of target; shift all right

# Back-compat names used elsewhere; now they mean the right-edge line per section
COL_L, COL_M, COL_R = EDGE_L, EDGE_M, EDGE_R

BIG_TICKET_FROM = "ticket"
BIG_TICKET_ROW  = 3        # top row of the big number block
BIG_TICKET_EDGE = EDGE_R   # big number right-aligns to the section-R line
# BIG_STYLE options for the big ticket number:
#   "graphic" = bit-image graphics (ESC K). Smooth, ~2 rows tall, drawn dot by
#               dot so it does NOT depend on font commands the printer ignores.
#               This is the reliable way to get a genuinely larger number.
#   "wide"    = single-row double-wide text (shorter, plain).
#   "tall"    = double-height text (only works if printer supports ESC w).
#   "block"   = block-character number (guaranteed but blocky).
BIG_STYLE = "graphic"
BIG_GRAPHIC_ROW = 2      # text-row where the graphic number starts (rows 2-4ish)
BIG_GRAPHIC_GAP = 3      # dot columns between digits
BIG_GRAPHIC_PASSES = 2   # overstrike passes: 1=normal, 2=darker, 3=boldest

# QTY (sheet count) graphic number — same row/style as the ticket number,
# right-aligned to this column line (5.6 on the grid = column 56). Blank for coils.
QTY_FROM = "qty"
QTY_GRAPHIC_EDGE = 56

BIG_FONT_24 = {
    '0': "003fe000fff801fffc03c01e03000603000603000603e03e01fffc00fff8003fe0",
    '1': "00e00600c00601c00601800603fffe03fffe03fffe03fffe000006000006000006000006",
    '2': "00601e01e03e01e07e03c0fe0301f60303e60307c603ff8601ff0601fe06007806",
    '3': "00603801e03c01e03c03800e030606030606030e0603ff8e01fffc01f9fc0070f8",
    '4': "0000600001e00007e0000f60003e6000786001e06003806003fffe03fffe03fffe000060000060",
    '5': "003f3803ff3c03ff3c03ff0e030c06030c06030c06030e0e030ffc0307fc0003f8",
    '6': "003fe000fff801fffc03c71e030c06030c06030c0603ce0e01cffc01c7fc0043f0",
    '7': "03000003000003000603007e0303fe030ffe033fc0037e0003f00003e000038000",
    '8': "00f0f801f9fc01fffc03df0e03060603060603060603ff0e01fffc01f9fc00f1f8",
    '9': "00fe1801ff1c01ff9e03838e03018603018603018e03c71e01fffc00fff8003fe0",
    '-': "0001c00001c00001c00001c00001c00001c0",
}


# 4-row tall block-character font for the big ticket number (digits, dash, space).
# Each glyph is 4 rows x 4 cols; rendered with the CP437 solid block (chr 0xDB).
_BLOCK = '\u2588'   # full block U+2588 -> CP437 byte 0xDB on the printer
BIG_FONT = {
 '0':['####','#  #','#  #','####'],
 '1':['  ##','   #','   #','   #'],
 '2':['####','  ##','##  ','####'],
 '3':['####','  ##','  ##','####'],
 '4':['#  #','####','   #','   #'],
 '5':['####','##  ','  ##','####'],
 '6':['####','#   ','#  #','####'],
 '7':['####','   #','  # ','  # '],
 '8':['####','####','#  #','####'],
 '9':['####','#  #','  ##','####'],
 '-':['    ','####','    ','    '],
 ' ':['    ','    ','    ','    '],
}

ESC_K = b"\x1bK"   # single-density 8-dot bit-image graphics

def _glyph_columns(text):
    """Return list of (band0,band1,band2) dot-column triples for `text`."""
    cols = []
    for ch in str(text):
        hexs = BIG_FONT_24.get(ch)
        if hexs is None:
            cols += [(0, 0, 0)] * 6
            continue
        raw = bytes.fromhex(hexs)
        for k in range(len(raw) // 3):
            cols.append((raw[k*3], raw[k*3+1], raw[k*3+2]))
        cols += [(0, 0, 0)] * BIG_GRAPHIC_GAP
    # drop the trailing inter-digit gap
    if cols:
        cols = cols[:-BIG_GRAPHIC_GAP] if BIG_GRAPHIC_GAP else cols
    return cols


def big_graphic_bytes(items):
    """Render one or more numbers on the SAME 24-dot-tall graphic line.
    `items` = list of (text, edge_col) pairs; each number is right-aligned so
    its last dot lands on edge_col. Returns (bytes, used_rows)."""
    # Build a single wide dot canvas spanning to the right-most edge needed.
    placed = []   # (start_dot, cols)
    max_dot = 0
    for text, edge_col in items:
        text = str(text).strip()
        if not text:
            continue
        cols = _glyph_columns(text)
        if not cols:
            continue
        edge_dots = int(round((edge_col + COL_OFFSET) / CPI * 60))
        start_dot = edge_dots - len(cols)
        if start_dot < 0:
            start_dot = 0
        placed.append((start_dot, cols))
        max_dot = max(max_dot, start_dot + len(cols))
    if not placed:
        return b"", 0

    # Compose the full-width canvas (list of triples), gaps = blank dots.
    canvas = [(0, 0, 0)] * max_dot
    for start_dot, cols in placed:
        for k, triple in enumerate(cols):
            canvas[start_dot + k] = triple

    ncols = max_dot
    n1, n2 = ncols & 0xFF, (ncols >> 8) & 0xFF

    out = bytearray()
    out += LINE_216(24)                      # 8-dot line spacing
    CR = b"\r"
    for b in range(3):
        data = bytes(canvas[c][b] for c in range(ncols))
        band_cmd = ESC_K + bytes([n1, n2]) + data
        passes = max(1, BIG_GRAPHIC_PASSES)
        for p in range(passes):
            out += band_cmd
            out += CR if p < passes - 1 else CRLF
    out += LINE_216(SPACING_6)
    return bytes(out), 3


def big_block_rows(text):
    """Return the 4 text rows that draw `text` as large block characters."""
    rows = ['', '', '', '']
    for ch in str(text):
        g = BIG_FONT.get(ch, BIG_FONT[' '])
        for i in range(4):
            rows[i] += g[i].replace('#', _BLOCK) + ' '
    return [r.rstrip() for r in rows]

# Dummy data pre-loaded into the first table row for quick testing.
# Set USE_DUMMY_DATA = False to start with blank rows instead.
USE_DUMMY_DATA = True
DUMMY_DATA = {
    "row": "R1",
    "ticket": "062626-001",
    "supplier": "PST",
    "bc": "D",
    "basis_weight": "95",
    "temper": "DR-8",
    "type": ".20",
    "coil_sheet": "S",
    "width": "36",
    "length": "38.281",
    "weight": "19435",
    "mill": "12345",
    "end_use": "603X700",
    "comments": "RECTANGULAR",
    "qty": "1500",          # sheet count; prints as graphic; blank for coils
    "cost": "$66.00",       # sheet-only, not printed
    "litho": "",            # app-only, not printed, NOT sent to sheet
    "po_number": "7756-DC", # sheet-only, not printed
}


def BASE_BOXES_FORMULA(v):
    """Base Boxes = Weight / Basis Weight.  Confirmed: 19435/95 = 204.579"""
    try:
        weight = float(str(v.get("weight", "")).replace(",", ""))
        bw     = float(str(v.get("basis_weight", "")).replace(",", ""))
        return f"{weight / bw:.3f}" if bw else ""
    except Exception:
        return ""


def format_weight_for_print(w):
    """Add a thousands-separator comma for the PRINTED ticket only.
    Called from build_form_text() on its own local copy of `values` — never
    on the ticket dict itself, so the value sent to send_to_sheet()/Google
    Sheets stays plain digits (numeric), not a comma-containing string.
    '19435' -> '19,435'. Values under 1000, blanks, or anything that isn't a
    plain number are returned unchanged."""
    s = str(w).strip()
    if not s:
        return s
    neg = s.startswith("-")
    body = s[1:] if neg else s
    int_part, dec_part = (body.split(".", 1) + [None])[:2] if "." in body else (body, None)
    if not int_part.isdigit():
        return s   # not a plain number (e.g. already has odd chars) -- leave as-is
    out = f"{int(int_part):,}"
    if dec_part is not None:
        out += "." + dec_part
    return ("-" if neg else "") + out


# Each field's "edge" is the right-align column line its value ends on.
# row = integer row (the half-line centering is handled by VERTICAL_NUDGE).
FIELDS = [
    {"key": "row",          "label": "Row",       "row": R1, "edge": EDGE_L},
    {"key": "ticket",       "label": "Ticket",    "row": R1, "edge": EDGE_M},
    {"key": "supplier",     "label": "Supplier",  "row": R1, "edge": EDGE_R},
    {"key": "bc",           "label": "B/C",       "row": R2, "edge": EDGE_L},
    {"key": "basis_weight", "label": "Basis Wt",  "row": R2, "edge": EDGE_M, "wide": True},
    {"key": "temper",       "label": "Temper",    "row": R2, "edge": EDGE_R, "wide": True},
    {"key": "type",         "label": "Type",      "row": R3, "edge": EDGE_L, "wide": True},
    {"key": "coil_sheet",   "label": "Coil/Sht",  "row": R3, "edge": EDGE_M},
    {"key": "width",        "label": "Width",     "row": R3, "edge": EDGE_R, "wide": True},
    {"key": "length",       "label": "Length",    "row": R4, "edge": EDGE_L, "wide": True},
    # base_boxes auto-placed at R4 / EDGE_M
    {"key": "weight",       "label": "Weight",    "row": R4, "edge": EDGE_R},
    {"key": "mill",         "label": "Mill",      "row": R5, "edge": EDGE_L},
    {"key": "end_use",      "label": "End Use",   "row": R5, "edge": EDGE_M, "wide": True},
    {"key": "comments",     "label": "Comments",  "row": R5, "edge": EDGE_R},
]
# Fields marked "wide": True print via ESC W (double-wide) for size/emphasis.
# Double-wide DOUBLES the column-width each value needs (values stay right-
# aligned to the same edge column), so longer values now reach further left
# into the field's pre-printed box than before. TEST PRINT AND CHECK AGAINST
# THE CALIBRATION GRID before trusting this on real forms -- especially for
# longer values (e.g. End Use codes, decimal Length values) which have the
# most room to run into a neighboring field's space.

# Entry-only fields shown in the table but handled specially:
#   qty  -> printed as a graphic number (not a normal text field)
#   cost, litho, po_number -> NOT printed; shown in a distinct color in the table
# "sheet" = does this field get sent to the Google Sheet?
EXTRA_FIELDS = [
    {"key": "qty",       "label": "Qty/Load",  "sheet": True,  "color": "qty"},
    {"key": "cost",      "label": "Cost",      "sheet": True,  "color": "sheetonly"},
    {"key": "litho",     "label": "Litho",     "sheet": False, "color": "sheetonly"},
    {"key": "po_number", "label": "PO Number", "sheet": True,  "color": "sheetonly"},
]

# ===========================================================================
# IBM/Proprinter escape codes — ONLY commands confirmed for 2580
# Reference: Forms Printer 258x/259x Technical Reference, Aug 2008
# ===========================================================================
ESC = b"\x1b"

# Layout
SET_LEN  = lambda n: ESC + b"C" + bytes([n])    # Set Form Length in Lines (p2-15)
LINE_216 = lambda n: ESC + b"3" + bytes([n])    # Set Graphics Line Spacing n/216" (p2-36)
SPACING_6 = 36                                   # 36/216" = 1/6" = 6 LPI

# Darkness — simple single-byte commands, confirmed IBM Proprinter compatible
# ESC E = Select Emphasized Mode  (p2-29)
# ESC F = Cancel Emphasized Mode  (p2-29)
# ESC G = Select Double-Strike Mode  (p2-29)
# ESC H = Cancel Double-Strike Mode  (p2-29)
EMPH_ON    = ESC + b"E"
EMPH_OFF   = ESC + b"F"
DSTRIKE_ON  = ESC + b"G"
DSTRIKE_OFF = ESC + b"H"

# Width — double-wide at default 10 cpi (effective 5 cpi), no pitch change
# ESC W chr(1) = Continuous Double-Wide on  (p2-6)
# ESC W chr(0) = Continuous Double-Wide off
WIDE_ON  = ESC + b"W\x01"
WIDE_OFF = ESC + b"W\x00"
# Double-height (Epson-style ESC w). Single self-contained command; if the
# printer ignores it, it cannot reset the printer the way ESC[ (SIC) did.
TALL_ON  = ESC + b"w\x01"
TALL_OFF = ESC + b"w\x00"

# Pitch: IBM 2580 — ESC : selects 12 cpi (tech ref "Select 12 cpi"),
# ESC P / DC2 returns to 10 cpi.
PITCH_12 = ESC + b":"
PITCH_10 = ESC + b"P"
def set_pitch():
    return PITCH_12 if CPI == 12 else PITCH_10

FORM_FEED = b"\x0c"
CRLF      = b"\r\n"
LF        = b"\n"
ENCODING  = "cp437"


def build_form_text(values):
    values = dict(values)
    values["base_boxes"] = BASE_BOXES_FORMULA(values)     # uses raw (uncommaed) weight
    values["weight"] = format_weight_for_print(values.get("weight", ""))  # print-only comma

    out = bytearray()
    out += SET_LEN(FORM_LINES)
    out += set_pitch()                    # lock pitch (12 cpi to fit 8.5" width)
    out += EMPH_ON + DSTRIKE_ON          # darkness: emphasized + double-strike

    by_row = {}

    def place(row, edge, text, wide=False, raw=False):
        """Right-align: the LAST character of text lands on column `edge`.
        raw=True keeps the text exactly (for pre-built block rows)."""
        text = str(text) if raw else str(text).rstrip()
        if not text:
            return
        width_cols = len(text) * (2 if wide else 1)
        start = edge - width_cols + 1          # column where text begins
        if start < 1:
            start = 1
        by_row.setdefault(row + ROW_OFFSET, []).append(
            (start + COL_OFFSET, text, wide))

    for f in FIELDS:
        place(f["row"], f["edge"], values.get(f["key"], ""), wide=f.get("wide", False))
    place(R4, EDGE_M, values.get("base_boxes", ""))
    big_text = str(values.get(BIG_TICKET_FROM, "")).rstrip()
    qty_text = str(values.get(QTY_FROM, "")).strip()
    big_tall_row = None        # row that gets the special tall rendering
    big_graphic = b""          # pre-rendered bit-image graphic bytes (if used)
    if big_text or (qty_text and BIG_STYLE == "graphic"):
        if BIG_STYLE == "graphic":
            # Ticket number (right-aligned to EDGE_R) + optional QTY count
            # (right-aligned to QTY_GRAPHIC_EDGE) on the SAME graphic line.
            items = []
            if big_text:
                items.append((big_text, BIG_TICKET_EDGE))
            if qty_text:
                items.append((qty_text, QTY_GRAPHIC_EDGE))
            big_graphic, _ = big_graphic_bytes(items)
        elif BIG_STYLE == "block":
            for i, brow in enumerate(big_block_rows(big_text)):
                place(BIG_TICKET_ROW + i, BIG_TICKET_EDGE, brow, wide=False, raw=True)
        elif BIG_STYLE == "tall":
            # Double-height + double-wide. Each char is 2 cols wide; right-align
            # so the last char ends on EDGE_R. Emitted specially in the row loop
            # so we can wrap it in TALL_ON/WIDE_ON and reset after.
            big_tall_row = BIG_TICKET_ROW + ROW_OFFSET
            width_cols = len(big_text) * 2
            big_tall_start = (BIG_TICKET_EDGE - width_cols + 1) + COL_OFFSET
            if big_tall_start < 1:
                big_tall_start = 1
            # reserve the row so first_row/last_row include it
            by_row.setdefault(big_tall_row, [])
        else:  # "wide"
            place(BIG_TICKET_ROW, BIG_TICKET_EDGE, big_text, wide=True)

    if not by_row:
        out += EMPH_OFF + DSTRIKE_OFF + FORM_FEED
        return bytes(out)

    first_row, last_row = min(by_row), max(by_row)

    if big_graphic:
        # Emit the bit-image number near the top, then feed the rest of the way
        # down to the first field row. The graphic itself advances the paper.
        pre = (BIG_GRAPHIC_ROW - 1) * SPACING_6 + VERTICAL_NUDGE   # feed to graphic top
        pre = max(pre, 0)
        while pre > 0:
            n = min(pre, 255); out += LINE_216(n) + LF; pre -= n
        out += big_graphic                      # 3 ESC K bands; advances ~2 lines
        # Graphic consumed BIG_GRAPHIC_ROW..(+2 lines). Feed down to first_row.
        graphic_end_line = BIG_GRAPHIC_ROW + 2
        remain = (first_row - graphic_end_line) * SPACING_6
        remain = max(remain, 0)
        while remain > 0:
            n = min(remain, 255); out += LINE_216(n) + LF; remain -= n
        out += LINE_216(SPACING_6)
    else:
        # Fine top feed: advance (first_row-1) lines + fractional nudge
        top_dots = (first_row - 1) * SPACING_6 + VERTICAL_NUDGE
        top_dots = max(top_dots, 0)
        while top_dots > 0:
            n = min(top_dots, 255)
            out += LINE_216(n) + LF
            top_dots -= n
        out += LINE_216(SPACING_6)          # restore 6 LPI for body

    for r in range(first_row, last_row + 1):
        # Special tall big-number row: emit double-height + double-wide directly.
        if big_tall_row is not None and r == big_tall_row:
            pad = b" " * (big_tall_start - 1)
            seg = big_text.encode(ENCODING, errors="replace")
            # Double-height + double-wide. Fields below sit at rows 7+ with
            # rows 4-6 as natural clearance, so no feed compensation needed.
            out += (pad + TALL_ON + WIDE_ON + seg + WIDE_OFF + TALL_OFF) + CRLF
            continue
        line = bytearray()
        col = 1
        for c, text, wide in sorted(by_row.get(r, [])):
            if c > col:
                line += b" " * (c - col)
                col = c
            width_cols = len(text) * (2 if wide else 1)
            # Wrap guard: never let a field push past the printable width
            if col + width_cols - 1 > MAX_COL:
                avail = MAX_COL - col + 1
                if avail <= 0:
                    continue
                if wide:
                    text = text[: max(0, avail // 2)]
                else:
                    text = text[:avail]
                if not text:
                    continue
            seg = text.encode(ENCODING, errors="replace")
            if wide:
                # Big ticket number: double-wide + emphasis for a bigger, bolder
                # look. Optionally double-height via DOUBLE_HEIGHT_BIG below.
                # (Renders the number a second time one line down, half-offset,
                #  to fake double-height safely without risky ESC[ commands.)
                line += WIDE_ON + seg + WIDE_OFF
                col += len(text) * 2
            else:
                line += seg
                col += len(text)
        out += bytes(line) + CRLF

    out += EMPH_OFF + DSTRIKE_OFF
    out += FORM_FEED
    return bytes(out)


def build_calibration_text():
    """
    Calibration sheet sized for the form at the active pitch (CPI).
    Width = MAX_COL columns (fills 8.0" printable area without wrapping).
    Height = FORM_LINES rows (3.5" x 6 LPI = 21). Row 1 at top edge.
    """
    W = MAX_COL   # never exceed the printable width -> no wrapping

    out = bytearray()
    out += EMPH_OFF + DSTRIKE_OFF
    out += WIDE_OFF
    out += set_pitch()                   # lock pitch so columns are consistent
    out += SET_LEN(FORM_LINES)
    out += LINE_216(SPACING_6)           # 6 LPI from the top edge

    # Row 1: tens digit at every 10th column
    tens = "".join(str((i // 10) % 10) if i % 10 == 0 else " "
                   for i in range(1, W - 3))
    # Row 2: units, with | at every 10th and . at every 5th
    units = "".join("|" if i % 10 == 0 else ("." if i % 5 == 0 else str(i % 10))
                    for i in range(1, W - 3))
    out += (f"R1 |" + tens).encode(ENCODING) + CRLF
    out += (f"R2 |" + units).encode(ENCODING) + CRLF

    def guide(n):
        return "".join("|" if i % 10 == 0 else ("+" if i % 5 == 0 else "-")
                       for i in range(1, n + 1))

    for r in range(3, FORM_LINES + 1):
        out += (f"R{r:<2}|" + guide(W - 4)).encode(ENCODING) + CRLF

    out += EMPH_OFF + DSTRIKE_OFF
    out += FORM_FEED
    return bytes(out)


def print_raw(data_bytes):
    import win32print
    h = win32print.OpenPrinter(PRINTER_NAME)
    try:
        win32print.StartDocPrinter(h, 1, ("Tickets", None, "RAW"))
        win32print.StartPagePrinter(h)
        win32print.WritePrinter(h, data_bytes)
        win32print.EndPagePrinter(h)
        win32print.EndDocPrinter(h)
    finally:
        win32print.ClosePrinter(h)


def list_printers():
    try:
        import win32print
        flags = win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS
        return [p[2] for p in win32print.EnumPrinters(flags)]
    except Exception as e:
        return [f"(could not list printers: {e})"]


# ===========================================================================
# Web UI
# ===========================================================================
import os
import json
import re
import threading
from flask import Flask, request, jsonify, Response

# Maps app field keys -> sheet header names (must match row 1 of the tab).
# Litho and base_boxes are intentionally excluded (not sent).
SHEET_HEADER_MAP = {
    "ticket": "Ticket", "row": "Row", "supplier": "Supplier", "bc": "B/C",
    "basis_weight": "BW", "temper": "TM", "type": "TC", "coil_sheet": "C/S",
    "width": "Width", "length": "Length", "weight": "Weight", "cost": "Cost",
    "mill": "Mill", "end_use": "End Use", "comments": "Comments",
    "qty": "QTY/LOAD", "po_number": "PO Number",
}

# Cache the worksheet handle so we don't re-authenticate on every print.
_sheet_ws = None
_sheet_headers = None
_sheet_lock = threading.Lock()   # serialize Skid-ID read+append across users


def _next_skid_ids(ws, headers, count):
    """Return `count` new sequential Skid IDs (SKD-000001 format), based on the
    highest existing SKD- number in the sheet's 'Skid ID' column. Matches the
    tracker app's format (SKD- + 6 zero-padded digits) exactly. Returns blanks
    if the sheet has no 'Skid ID' column, so we never write to a missing column."""
    if "Skid ID" not in headers:
        return [""] * count
    col_idx = headers.index("Skid ID") + 1          # gspread columns are 1-based
    max_n = 0
    for v in ws.col_values(col_idx)[1:]:            # skip the header cell
        m = re.match(r"\s*SKD-0*(\d+)\s*$", str(v), re.I)
        if m:
            max_n = max(max_n, int(m.group(1)))
    return [f"SKD-{max_n + i:06d}" for i in range(1, count + 1)]

def _resolve_creds_path():
    p = SHEET_CREDS_FILE
    if not os.path.isabs(p):
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), p)
    return p

def _get_worksheet():
    """Open (and cache) the target worksheet via the service account."""
    global _sheet_ws, _sheet_headers
    if _sheet_ws is not None:
        return _sheet_ws, _sheet_headers
    import gspread
    from google.oauth2.service_account import Credentials
    scopes = ["https://www.googleapis.com/auth/spreadsheets"]
    creds = Credentials.from_service_account_file(_resolve_creds_path(), scopes=scopes)
    gc = gspread.authorize(creds)
    ws = gc.open_by_key(SHEET_ID).worksheet(SHEET_TAB)
    headers = ws.row_values(1)            # row 1 header names
    _sheet_ws, _sheet_headers = ws, headers
    return ws, headers


def send_to_sheet(tickets):
    """Best-effort: append printed tickets to the Google Sheet via a service
    account. Assigns each new row a Skid ID + Status='Current' so it shows up as
    inventory in the tracker. Runs in a background thread so it never delays or
    blocks printing."""
    if not SHEET_ID or not tickets:
        return

    def _post():
        try:
            with _sheet_lock:                         # one batch numbers at a time
                ws, headers = _get_worksheet()
                skids = _next_skid_ids(ws, headers, len(tickets))
                # Build one row per ticket, ordered to match the sheet's headers.
                rows = []
                for t, skid in zip(tickets, skids):
                    # value-by-header: place each mapped field under its column
                    by_header = {}
                    for key, header in SHEET_HEADER_MAP.items():
                        by_header[header] = t.get(key, "")
                    if skid:
                        by_header["Skid ID"] = skid    # e.g. SKD-000042
                    if "Status" in headers:
                        by_header["Status"] = "Current"  # new stock enters as Current
                    rows.append([by_header.get(h, "") for h in headers])
                ws.append_rows(rows, value_input_option="USER_ENTERED")
            tag = f" ({skids[0]}..{skids[-1]})" if skids and skids[0] else ""
            print(f"Sheet logging succeeded: appended {len(rows)} row(s){tag}.", flush=True)
        except Exception as exc:
            print("Sheet logging failed (printing was unaffected):", exc, flush=True)

    threading.Thread(target=_post, daemon=True).start()

app_flask = Flask(__name__)

PAGE = r"""<!doctype html><html><head><meta charset="utf-8">
<title>Metal ID Tickets</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;}
  body{font-family:system-ui,sans-serif;margin:20px;color:#1a1a1a;background:#f5f5f5;}
  h1{font-size:20px;margin:0 0 2px;}
  .printer{font-size:12px;color:#666;margin-bottom:14px;}
  .scroll{overflow-x:auto;border:1px solid #ccc;border-radius:8px;background:#fff;}
  table{border-collapse:collapse;width:100%;}
  thead tr{background:#001f4e;}
  th{color:#fff;font-size:12px;font-weight:600;padding:8px 5px;text-align:left;white-space:nowrap;}
  tr.data-row{background:#fff;}
  tr.data-row:nth-child(even){background:#f0f4ff;}
  tr.data-row:hover{background:#e8eeff;}
  td{padding:2px;border-bottom:1px solid #e8e8e8;vertical-align:middle;}
  td input{width:100%;padding:5px 6px;font-size:13px;border:1px solid #d0d0d0;
           border-radius:4px;background:transparent;}
  td input:focus{outline:2px solid #001f4e;border-color:#001f4e;background:#fff;}
  td.sheetonly input{background:#fff4e0;border-color:#e0b870;color:#9a5b00;}
  td.sheetonly{background:#fff9f0;}
  td.qtycol input{background:#eef0ff;border-color:#9aa6e0;}
  th{}
  td.bb{background:#e9f5e9;font-size:13px;padding:5px 7px;white-space:nowrap;
        color:#1a6b1a;font-weight:600;min-width:80px;text-align:right;}
  td.act-col{width:66px;text-align:center;white-space:nowrap;}
  .cp-btn{cursor:pointer;border:0;background:#0d3a7a;color:#fff;font-size:11px;
          padding:3px 7px;border-radius:4px;margin-right:2px;}
  .cp-btn:hover{background:#001f4e;}
  .x{cursor:pointer;color:#b00;border:0;background:none;font-size:18px;line-height:1;padding:0 2px;}
  .bar{margin:14px 0;display:flex;gap:10px;flex-wrap:wrap;align-items:center;}
  button.act{padding:10px 18px;font-size:14px;border:0;border-radius:6px;cursor:pointer;}
  .primary{background:#001f4e;color:#fff;} .ghost{background:#ddd;color:#222;}
  #status{font-size:14px;min-height:20px;}
  .ok{color:#137333;font-weight:600;} .err{color:#c5221f;font-weight:600;}
  .note{font-size:11px;color:#888;margin-top:6px;}

  /* ---- Review modal ---- */
  #reviewOverlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);
    z-index:1000;align-items:center;justify-content:center;padding:20px;}
  #reviewOverlay.open{display:flex;}
  #reviewModal{background:#fff;border-radius:10px;max-width:1100px;width:100%;
    max-height:88vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.3);}
  #reviewModal h2{margin:0;padding:16px 20px;font-size:17px;border-bottom:1px solid #eee;
    background:#001f4e;color:#fff;border-radius:10px 10px 0 0;}
  #reviewBody{overflow:auto;padding:14px 20px;}
  #reviewBody table{border-collapse:collapse;width:100%;}
  #reviewBody th{background:#f0f0f0;color:#333;font-size:11px;padding:6px 4px;
    text-align:left;white-space:nowrap;border-bottom:2px solid #ddd;}
  #reviewBody td{padding:2px;border-bottom:1px solid #eee;}
  #reviewBody input{width:100%;min-width:70px;padding:5px 6px;font-size:12px;
    border:1px solid #d0d0d0;border-radius:4px;}
  #reviewBody input:focus{outline:2px solid #001f4e;border-color:#001f4e;}
  #reviewFooter{padding:14px 20px;border-top:1px solid #eee;display:flex;
    gap:10px;justify-content:flex-end;align-items:center;}
  #reviewFooter .hint{font-size:12px;color:#888;margin-right:auto;}
</style></head><body>
<h1>Metal Identification Tickets — Container Supply Co.</h1>
<div class="printer">Printer: __PRINTER__</div>
<div class="scroll"><table>
  <thead><tr>__HEAD__</tr></thead>
  <tbody id="tbody"></tbody>
</table></div>
<div class="bar">
  <button class="act primary" onclick="printAll()">&#x1F5A8; Print all tickets</button>
  <button class="act ghost" onclick="addRow()">+ Add row</button>
  <button class="act ghost" onclick="calibrate()">Calibration sheet</button>
  <span id="status"></span>
</div>
<div class="note">Base Boxes (green) = Weight ÷ Basis Weight, auto-calculated. Copy duplicates a row for small edits.</div>

<div id="reviewOverlay">
  <div id="reviewModal">
    <h2>Review before printing &amp; adding to inventory</h2>
    <div id="reviewBody"></div>
    <div id="reviewFooter">
      <span class="hint">Edits here apply only to what's printed/saved — not the table behind this window.</span>
      <button class="act ghost" onclick="closeReviewModal()">Cancel</button>
      <button class="act primary" onclick="confirmPrint()">Print and Add to Inventory</button>
    </div>
  </div>
</div>

<script>
const KEYS = __KEYS__;
const COLORS = __COLORS__;
const LABELS = __LABELS__;

function calcBB(vals){
  try{
    const w=parseFloat((vals.weight||'').replace(/,/g,''));
    const bw=parseFloat((vals.basis_weight||'').replace(/,/g,''));
    if(!w||!bw) return '';
    return (w/bw).toFixed(3);
  }catch(e){return '';}
}
/* Force every field to uppercase as the person types, preserving cursor pos. */
function uppercaseInput(el){
  const upper=el.value.toUpperCase();
  if(upper!==el.value){
    const start=el.selectionStart, end=el.selectionEnd;
    el.value=upper;
    try{ el.setSelectionRange(start,end); }catch(e){}
  }
}
/* Coil/Sheet <-> QTY/Load rule: C must have no QTY; S must have a QTY.
   Returns an array of human-readable error strings (empty = all good). */
function coilSheetQtyErrors(rows){
  const errs=[];
  rows.forEach((r,i)=>{
    const cs=(r.coil_sheet||'').trim().toUpperCase();
    const qty=(r.qty||'').trim();
    const label = (r.row||'').trim() ? `Row ${r.row}` : `Ticket #${i+1}`;
    if(cs==='C' && qty){
      errs.push(`${label}: Coil/Sht is C but QTY/Load has a value ("${qty}") — coils shouldn't have a sheet count.`);
    }else if(cs==='S' && !qty){
      errs.push(`${label}: Coil/Sht is S but QTY/Load is empty — sheets need a count.`);
    }else if(cs && cs!=='C' && cs!=='S'){
      errs.push(`${label}: Coil/Sht must be C or S (got "${cs}").`);
    }
  });
  return errs;
}
function getRowValues(tr){
  const o={};
  tr.querySelectorAll('input[data-key]').forEach(i=>o[i.dataset.key]=i.value);
  return o;
}
function updateBB(tr){
  const cell=tr.querySelector('.bb');
  if(cell) cell.textContent=calcBB(getRowValues(tr))||'—';
}
function addRow(values,insertAfter){
  values=values||{};
  const tr=document.createElement('tr'); tr.className='data-row';
  KEYS.forEach(k=>{
    const td=document.createElement('td');
    if(k==='base_boxes'){td.className='bb';td.textContent='—';}
    else{
      const inp=document.createElement('input');
      inp.dataset.key=k; inp.autocomplete='off'; inp.value=(values[k]||'').toUpperCase();
      inp.addEventListener('input',()=>{ uppercaseInput(inp); updateBB(tr); });
      const col=COLORS[k];
      if(col==='sheetonly') td.className='sheetonly';
      else if(col==='qty') td.className='qtycol';
      td.appendChild(inp);
    }
    tr.appendChild(td);
  });
  const td=document.createElement('td'); td.className='act-col';
  const cp=document.createElement('button'); cp.className='cp-btn'; cp.textContent='Copy';
  cp.title='Duplicate this row below';
  cp.onclick=()=>addRow(getRowValues(tr),tr);
  const x=document.createElement('button'); x.className='x'; x.textContent='\u00d7';
  x.title='Delete'; x.onclick=()=>tr.remove();
  td.appendChild(cp); td.appendChild(x); tr.appendChild(td);
  if(insertAfter&&insertAfter.parentNode)
    insertAfter.parentNode.insertBefore(tr,insertAfter.nextSibling);
  else document.getElementById('tbody').appendChild(tr);
  updateBB(tr); return tr;
}
function collect(){
  const rows=[];
  document.querySelectorAll('#tbody tr').forEach(tr=>{
    const o={}; let any=false;
    tr.querySelectorAll('input[data-key]').forEach(i=>{o[i.dataset.key]=i.value;if(i.value.trim())any=true;});
    if(any) rows.push(o);
  });
  return rows;
}
function status(msg,cls){const s=document.getElementById('status');s.textContent=msg;s.className=cls||'';}
async function post(url,body){
  status('Sending\u2026');
  try{
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});
    const j=await r.json(); status(j.message,j.ok?'ok':'err');
  }catch(e){status('Error: '+e,'err');}
}

/* ---- Review modal: shows the whole batch, editable, before commit ---- */
let reviewRows = [];   // working copy of tickets currently being reviewed

function reviewKeys(){
  // Same fields as the main table, minus the computed base_boxes column.
  return KEYS.filter(k=>k!=='base_boxes');
}
function renderReviewTable(){
  const keys = reviewKeys();
  let html = '<table><thead><tr>' +
    keys.map(k=>`<th>${LABELS[k]||k}</th>`).join('') + '</tr></thead><tbody>';
  reviewRows.forEach((row,ri)=>{
    html += '<tr>' + keys.map(k=>
      `<td><input data-ri="${ri}" data-key="${k}" value="${(row[k]||'').toUpperCase().replace(/"/g,'&quot;')}"></td>`
    ).join('') + '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('reviewBody').innerHTML = html;
  document.getElementById('reviewBody').querySelectorAll('input').forEach(inp=>{
    inp.addEventListener('input', e=>{
      uppercaseInput(e.target);
      const ri = +e.target.dataset.ri, key = e.target.dataset.key;
      reviewRows[ri][key] = e.target.value;
    });
  });
}
function openReviewModal(rows){
  reviewRows = rows.map(r=>({...r}));   // copy so edits don't touch the main table
  renderReviewTable();
  const b=document.getElementById('reviewErr'); if(b) b.remove();
  document.getElementById('reviewOverlay').classList.add('open');
}
function closeReviewModal(){
  document.getElementById('reviewOverlay').classList.remove('open');
  reviewRows = [];
}
function showReviewError(msg){
  let banner=document.getElementById('reviewErr');
  if(!banner){
    banner=document.createElement('div'); banner.id='reviewErr';
    banner.style.cssText='color:#c5221f;font-weight:600;font-size:12px;padding:8px 20px 0;';
    document.getElementById('reviewBody').before(banner);
  }
  banner.textContent = msg;
}
async function confirmPrint(){
  const errs = coilSheetQtyErrors(reviewRows);
  if(errs.length){ showReviewError(errs.join('  |  ')); return; }
  const rows = reviewRows;
  closeReviewModal();
  await post('/print_batch',{tickets:rows});
}

function printAll(){
  const rows=collect();
  if(!rows.length){status('Nothing to print — fill in at least one row.','err');return;}
  const errs = coilSheetQtyErrors(rows);
  if(errs.length){ status(errs.join('  |  '),'err'); return; }
  openReviewModal(rows);
}
function calibrate(){post('/calibrate');}
const DUMMY = __DUMMY__;
// First row prefilled with dummy data (if enabled) for quick testing
addRow(DUMMY);
for(let i=0;i<4;i++) addRow();
</script></body></html>"""


def render_page():
    all_keys = [f["key"] for f in FIELDS]
    length_idx = all_keys.index("length")
    all_keys.insert(length_idx + 1, "base_boxes")
    labels = {f["key"]: f["label"] for f in FIELDS}
    labels["base_boxes"] = "Base Boxes*"
    # Append the entry-only extra fields (qty, cost, litho, po_number)
    color_map = {}
    for f in EXTRA_FIELDS:
        all_keys.append(f["key"])
        labels[f["key"]] = f["label"]
        color_map[f["key"]] = f.get("color", "")
    head = "".join(f'<th>{labels[k]}</th>' for k in all_keys) + "<th></th>"
    dummy = DUMMY_DATA if USE_DUMMY_DATA else {}
    return (PAGE
            .replace("__HEAD__", head)
            .replace("__KEYS__", json.dumps(all_keys))
            .replace("__COLORS__", json.dumps(color_map))
            .replace("__LABELS__", json.dumps(labels))
            .replace("__DUMMY__", json.dumps(dummy))
            .replace("__PRINTER__", PRINTER_NAME))


@app_flask.route("/")
def index():
    return Response(render_page(), mimetype="text/html")


@app_flask.route("/print_batch", methods=["POST"])
def do_batch():
    data = request.get_json(force=True, silent=True) or {}
    tickets = [t for t in data.get("tickets", [])
               if any(str(v).strip() for v in t.values())]
    try:
        blob = b"".join(build_form_text(t) for t in tickets)
        if blob:
            print_raw(blob)
            send_to_sheet(tickets)          # log to Google Sheet (best-effort)
        return jsonify(ok=True, message=f"Printed {len(tickets)} ticket(s).")
    except Exception as e:
        return jsonify(ok=False, message=f"Print failed: {e}")


@app_flask.route("/calibrate", methods=["POST"])
def do_calibrate():
    try:
        print_raw(build_calibration_text())
        return jsonify(ok=True, message="Calibration sheet sent.")
    except Exception as e:
        return jsonify(ok=False, message=f"Print failed: {e}")


# Server port — change here if 5000 is taken by something else.
SERVER_PORT = 5000

if __name__ == "__main__":
    print("\nInstalled printers:")
    for name in list_printers():
        print("   -", name)
    print(f"\nCurrently set to: {PRINTER_NAME}")
    print(f"Open http://localhost:{SERVER_PORT}  or  http://<this-pc-ip>:{SERVER_PORT}\n")
    # Use the production-grade 'waitress' server (stable for always-on, multi-user
    # office use). Falls back to Flask's dev server if waitress isn't installed.
    try:
        from waitress import serve
        serve(app_flask, host="0.0.0.0", port=SERVER_PORT, threads=8)
    except ImportError:
        app_flask.run(host="0.0.0.0", port=SERVER_PORT)
