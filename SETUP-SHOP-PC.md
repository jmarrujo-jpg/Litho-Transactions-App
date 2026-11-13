# Setting up a new shop PC (ticket printer + Zebra labels)

Use this when the shop PC dies or gets replaced. It sets up the two programs that run on it:

| Program | What it does | Printer |
|---|---|---|
| `app.py` — **ticket printer** | The page where the office types steel tickets. Prints the Metal ID ticket and adds the ticket to the Google Sheet. | Lexmark Forms 2580, plugged in by **USB** |
| `print_server.py` — **Zebra label server** | Lets the Litho app print skid travelers on the Zebra. | Zebra, on the **network** (found automatically) |

If both run on the same PC, do every part. If they're on different PCs, do Parts 1–2 on each, then
the part for the program that PC runs.

Plan on about 30 minutes. You need:
- the new PC (Windows 10 or 11), on the shop network;
- the **service account key file** (`service_account.json`) from your safe copy;
- a GitHub login that can see this repository;
- the Lexmark 2580 and its USB cable.

---

## Part 1 — Install Python (once per PC)

1. Go to **python.org/downloads** and click the big yellow **Download Python** button.
2. Run the file you downloaded.
3. On the first screen, **tick "Add python.exe to PATH"** at the bottom. This matters — without it
   nothing below works.
4. Click **Install Now**, wait, then **Close**.
5. Check it: press the **Windows key**, type `cmd`, press **Enter**. In the black window type:
   ```
   py --version
   ```
   You should see `Python 3.something`. If it says it's not recognized, run the installer again
   and pick **Modify** / tick **Add to PATH**.

## Part 2 — Get the program files (once per PC)

1. Make a folder: **`C:\CSC-Printing`**.
2. Open this repository on GitHub. Check the branch drop-down (top left, above the file list)
   shows the branch the live app is published from.
3. Click the green **Code** button → **Download ZIP**.
4. Open the ZIP and copy these into `C:\CSC-Printing`:
   - `app.py`
   - `print_server.py`
   - `start-ticket-printer.bat`
   - `start-zebra-printer.bat`
5. Copy your **`service_account.json`** into `C:\CSC-Printing` too. The name must be exactly
   `service_account.json` (Windows may hide the `.json` part — that's fine).

> Keep the key file only on the shop PC and in your safe copy. Anyone who has it can change the sheet.
> Never upload it to GitHub.

## Part 3 — Ticket printer (`app.py`)

### 3a. Install its add-ons
In the black `cmd` window, paste this and press **Enter**:
```
py -m pip install flask waitress pywin32 gspread google-auth
```
Wait until it says `Successfully installed …`.

### 3b. Plug in the Lexmark 2580
1. Plug the USB cable into the PC and turn the printer on.
2. Open **Settings → Bluetooth & devices → Printers & scanners**. After a minute you should see a
   printer with **2580** in its name.
3. **If it doesn't show up:** download the 2580 driver from **lexmark.com** (search "Forms Printer
   2580 driver") and install it.
   **If there's no driver for your Windows:** click **Add device → Add manually → "Add a local
   printer … with manual settings"**, pick the **USB** port the printer is on, choose
   **Generic → Generic / Text Only**, and name it **`Lexmark Forms Printer 2580`**. The program
   sends the printer its own commands, so this basic driver works fine.

The program finds the printer by itself — any printer with "2580" in its name — so it doesn't
matter if Windows calls it "… (Copy 1)".

### 3c. Start it
1. Double-click **`start-ticket-printer.bat`** in `C:\CSC-Printing`. A black window opens — **leave
   it open** (you can minimize it).
2. If Windows asks **"Allow Python to access networks?"**, tick **Private networks** and click
   **Allow**. (Without this, other computers can't open the page.)
3. On the PC, open a browser and go to **`http://localhost:5000`**.
   - Under the title it says **Printer: …** with the 2580's name.
   - If there's a **red "Setup problem" box**, it says exactly what's wrong (printer not found, key
     file missing or wrong) — fix that, then close the black window and double-click the `.bat` again.

### 3d. Check the print lines up
1. Load ticket forms in the printer.
2. Click **Calibration sheet** on the page. It prints a grid.
3. Print one real ticket with **Print only** (so nothing goes on the sheet) and check the values sit
   in their boxes.
4. If they're off, the alignment settings near the top of `app.py` (`VERTICAL_NUDGE`, `COL_OFFSET`,
   `EDGE_L/M/R`, `GRAPHIC_DPI`) need adjusting. These should already match the old PC **if the
   copy on GitHub is up to date** — see "Keep GitHub up to date" below.

## Part 4 — Zebra label server (`print_server.py`)

No add-ons needed — it only uses what comes with Python.

1. Double-click **`start-zebra-printer.bat`**. Leave the black window open.
2. If Windows asks about network access, tick **Private networks** → **Allow**.
3. The window says **"Printer … is at 192.168.1.…"** once it finds the Zebra on the network.
4. On a phone or iPad on the shop Wi-Fi, open **`http://<this PC's address>:8000`** (Part 5 shows
   how to find it) and tap **Print test label**.

## Part 5 — Give the PC the old PC's network address

Other computers and the Litho app find these programs by the PC's network address. The Litho app
opens the Zebra at **`192.168.1.214`**, and the office opens the ticket printer at the address they
have bookmarked (it was `192.168.1.162`). The new PC has to use the **same address** as the PC it
replaces.

**Find the current address:** in `cmd` type `ipconfig` and look for **IPv4 Address**.

**Set it — pick one:**
- **Router (best):** in the router's settings, find the address reservation (often "DHCP
  reservation" or "static lease") for the old PC and change it to the new PC. Restart the new PC.
- **On the PC:** **Settings → Network & internet → Ethernet** (or Wi-Fi → the network) →
  **IP assignment → Edit → Manual → IPv4 on**:
  - **IP address:** the old PC's address (e.g. `192.168.1.214`)
  - **Subnet mask / prefix:** `255.255.255.0` (prefix `24`)
  - **Gateway** and **DNS:** copy them from `ipconfig` (**Default Gateway**) before you change anything
  - Save. Make sure the old PC is off or unplugged, or the two will fight over the address.

**If you can't use the old address:** in the Litho app's code (`Index.HTML`, `ZEBRA_LABEL_URL`) the
Zebra address has to be changed to the new one, and the office's bookmark updated.

## Part 6 — Start both programs automatically

So they come back after a restart or power cut:
1. Press **Windows key + R**, type `shell:startup`, press **Enter**. A folder opens.
2. In `C:\CSC-Printing`, **right-click** `start-ticket-printer.bat` → **Show more options** →
   **Create shortcut**. Drag the shortcut into the startup folder.
3. Do the same for `start-zebra-printer.bat` (if this PC runs it).
4. Restart the PC and check the black windows open by themselves.

The `.bat` files also restart a program by themselves if it crashes.

## Part 7 — Final check
- [ ] `http://localhost:5000` shows the right printer and **no red box**.
- [ ] A **Print only** ticket lines up on the form.
- [ ] A real ticket with **Print + save to sheet** shows "Saved 1 to the sheet", and the ticket
      appears in the Litho app.
- [ ] From another office computer, `http://<this PC's address>:5000` opens the page.
- [ ] **Print skid traveler** in the Litho app prints on the Zebra.
- [ ] After a restart, both black windows come back on their own.

---

## Something's wrong

| You see | What to do |
|---|---|
| `'py' is not recognized` | Python isn't installed with "Add to PATH". Run the Python installer again → Modify → tick it. |
| `No module named flask` (or `win32print`, `gspread`) | Do step 3a again. |
| **Printer: NOT FOUND** / "No Lexmark 2580 printer found" | Printer off, unplugged, or not in Windows → step 3b. |
| "The service account key file is missing / isn't a valid key" | Copy `service_account.json` into `C:\CSC-Printing` (exact name), then restart the `.bat`. |
| "NOT saved to the sheet: … 403 / permission" | The Google Sheet isn't shared with the key's email. Open the key file in Notepad, copy the `client_email`, and share the sheet with it as **Editor**. |
| "NOT saved to the sheet" with a network error | Internet is down. When it's back, select those tickets and use **Save to sheet only**. |
| "Already on the sheet: …" | That ticket number was already printed and saved. Change the number, or use **Print only** for a reprint. |
| Other computers can't open the page | Windows Firewall: **Settings → Privacy & security → Windows Security → Firewall → Allow an app** → tick **Python** for **Private**. Also check the address (Part 5). |
| `Address already in use` / port 5000 or 8000 | The program is already running (look for another black window), or close all of them and restart the PC. |
| Zebra window keeps saying it can't find the printer | The Zebra is off or not on the network. Turn it on and wait a minute — it's found by its hardware ID, even if its address changed. |
| Print is shifted on the form | Part 3d. |

## Keep GitHub up to date

This guide only works if the files on GitHub match what's running on the shop PC. If anyone changes
`app.py` on the shop PC itself (for example the alignment settings), copy that change to GitHub
too — otherwise a new PC gets the old settings.
