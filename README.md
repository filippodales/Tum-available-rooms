# TUM Free Rooms

A **mobile-first Progressive Web App (PWA)** to quickly find the nearest free rooms across **Technical University of Munich (TUM)** campuses, complete with free time windows, daily availability bars, full lecture timelines, and an interactive Leaflet map.

All schedule and coordinate data comes directly from the public, unauthenticated **NavigaTUM** API (`https://nav.tum.de/api/`), synced with TUMonline. No backend server or login required.

---

## 1. Run Locally (Windows)

Only **Python 3.10+** is required (no Node/npm).

1. Double-click **`Start TUM Free Rooms.bat`**.
2. Your browser will automatically open `http://127.0.0.1:8765/`. Leave the small window open while using the app; double-clicking again reopens the browser tab.

*(On macOS / Linux, run `python3 run_local.py`.)*

---

## 2. Publish Online for Free on GitHub Pages

Because this app is **100% static**, it runs directly on **GitHub Pages** with automatic **HTTPS** (required for smartphone GPS and PWA installation).

With the **GitHub Student Developer Pack** (GitHub Pro), you can even host GitHub Pages from a **private repository** so only you and the friends you share the link with have it:

1. Create a new repository on GitHub (e.g. `tum-free-rooms`, **Public** or **Private**).
2. Upload all files and folders from `tum-aule-libere` (drag-and-drop on GitHub via **Add file → Upload files**, or push with Git).
3. Go to **Settings → Pages**:
   - **Source:** Deploy from a branch
   - **Branch:** `main` / `/ (root)` → click **Save**.
4. After ~30–60 seconds, your app will be live at `https://<your-username>.github.io/<repo-name>/` (or a custom domain from the Student Pack).

---

## 3. Install on Your Phone (PWA)

Open your GitHub Pages HTTPS link on your smartphone:

- **iPhone / iPad (Safari):** tap **Share** → **Add to Home Screen**.
- **Android (Chrome):** tap **⋮** → **Install app** / **Add to Home screen**.

---

## 4. Updating the Room Catalog

`data/rooms.json` includes **755 verified rooms** across all TUM campuses (`Hörsaal`, `Seminarraum`, `Übungsraum`, `Unterrichtsraum`, `Studentenarbeitsraum`, `Lesesaal`, `Zeichensaal`, `EDV-Raum`).

To refresh the list at the start of a new semester:
- **Locally on Windows:** double-click **`Update Room Catalog.bat`** (requires `requests`).
- **On GitHub:** go to the **Actions** tab → **Update Room Catalog** → **Run workflow** (also runs automatically on the 1st of every month).

---

## Notes

- Schedules reflect public TUMonline calendars synced by NavigaTUM (`Last TUMonline sync` is shown in each room's details).
- Some study rooms or department rooms may require badge/keycard access or have last-minute bookings; enable **"Only rooms with ≥1 event today"** in **Filters** to focus on active teaching rooms.
