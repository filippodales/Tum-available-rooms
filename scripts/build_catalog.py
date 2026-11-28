"""Builds and verifies the static TUM room catalog from NavigaTUM."""

from __future__ import annotations

import json
import re
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests

BASE_URL = "https://nav.tum.de"
USAGES = [
    "Hörsaal",
    "Seminarraum",
    "Übungsraum",
    "Unterrichtsraum",
    "Studentenarbeitsraum",
    "Lesesaal",
    "Zeichensaal",
    "EDV-Raum",
]

ROOT_DIR = Path(__file__).resolve().parent.parent
OUTPUT_PATH = ROOT_DIR / "data" / "rooms.json"

PUBLIC_OPERATOR_CODES = {
    "TUZVZA4",  # Immobilien (ZA 4) — central TUM lecture halls & classrooms
    "TUZEBIB",  # Universitätsbibliothek — library reading/study rooms
    "TUVBSBV",  # Studentische Vertretung — student council study rooms
    "TUCS000",  # TUM Campus Straubing
    "TUCSVRW",  # TUMCS Office
    "TUWIH01",  # TUM Campus Heilbronn
}

CHAIR_KEYWORDS = (
    "lehrstuhl",
    "professur",
    "museum",
    "design factory",
    "werkfeuerwehr",
    "core facility",
    "greenhouses",
)

SCHOOL_KEYWORDS = (
    "tum school",
    "department of",
    "fakultät",
    "school office",
    "studienverwaltung",
    "sprachenzentrum",
    "dekanat",
)

_thread_local = threading.local()
_ROOM_ERR_RE = re.compile(r"(?:Room|Requested id)\s+([^\s/]+)")


def classify_access(op_code: str, op_name: str) -> str:
    """Classifies likely student access level based on NavigaTUM operator metadata."""
    code = (op_code or "").strip().upper()
    name_l = (op_name or "").strip().lower()

    if code in PUBLIC_OPERATOR_CODES or any(
        k in name_l for k in ("immobilien (za 4)", "universitätsbibliothek", "studentische vertretung")
    ):
        return "public"
    if any(k in name_l for k in CHAIR_KEYWORDS):
        return "chair"
    if any(k in name_l for k in SCHOOL_KEYWORDS):
        return "school"
    return "chair"


def get_session() -> requests.Session:
    """Returns a thread-local requests.Session."""
    sess = getattr(_thread_local, "session", None)
    if sess is None:
        sess = requests.Session()
        sess.headers.update({"User-Agent": "TUM-Free-Rooms-CatalogBuilder/1.0"})
        _thread_local.session = sess
    return sess


def request_with_retry(method: str, url: str, max_attempts: int = 4, **kwargs) -> requests.Response:
    """Performs an HTTP request with exponential backoff on 429/5xx or timeouts."""
    sess = get_session()
    delay = 0.6
    last_exc: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            resp = sess.request(method, url, timeout=20, **kwargs)
            if resp.status_code in (429, 500, 502, 504):
                if attempt < max_attempts:
                    retry_after = resp.headers.get("Retry-After")
                    wait = float(retry_after) if retry_after and retry_after.isdigit() else delay
                    time.sleep(wait)
                    delay *= 2
                    continue
            return resp
        except requests.RequestException as exc:
            last_exc = exc
            if attempt < max_attempts:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    if last_exc:
        raise last_exc
    raise RuntimeError(f"Request failed for {url}")


def discover_room_ids() -> dict[str, str]:
    """Queries /api/search for all target usages and deduplicates room IDs."""
    discovered: dict[str, str] = {}
    for usage in USAGES:
        resp = request_with_retry(
            "GET",
            f"{BASE_URL}/api/search",
            params=[
                ("q", ""),
                ("type", "room"),
                ("usage", usage),
                ("limit_rooms", "1000"),
                ("limit_all", "1000"),
            ],
        )
        resp.raise_for_status()
        payload = resp.json()
        count = 0
        for section in payload.get("sections", []):
            if section.get("facet") == "rooms":
                for entry in section.get("entries", []):
                    rid = entry.get("id")
                    if rid and rid not in discovered:
                        discovered[rid] = usage
                    count += 1
        print(f"  - {usage:22s}: {count} results")
    return discovered


def derive_short_name(room_id: str, full_name: str) -> str:
    """Extracts a readable room name by stripping the leading room code and outer parentheses."""
    name = (full_name or "").strip()
    prefix = f"{room_id} "
    if name.startswith(prefix):
        rest = name[len(prefix) :].strip()
        if rest.startswith("(") and rest.endswith(")") and len(rest) > 2:
            return rest[1:-1].strip()
        if rest:
            return rest
    return name or room_id


def fetch_room_detail(room_id: str, fallback_usage: str) -> dict | None:
    """Fetches room details and normalizes them if coordinates and calendar_url are present."""
    resp = request_with_retry("GET", f"{BASE_URL}/api/locations/{room_id}")
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    loc = resp.json()

    coords = loc.get("coords") or {}
    lat = coords.get("lat")
    lon = coords.get("lon")
    props = loc.get("props") or {}
    cal_url = props.get("calendar_url")
    if lat is None or lon is None or not cal_url:
        return None

    computed_map = {
        item.get("name"): (item.get("text") or "").strip()
        for item in (props.get("computed") or [])
        if isinstance(item, dict) and item.get("name")
    }

    parents = loc.get("parents") or []
    parent_names = loc.get("parent_names") or []
    campus_id = parents[1] if len(parents) > 1 else "other"
    campus = parent_names[1] if len(parent_names) > 1 else "Other"
    building = parent_names[-1] if len(parent_names) > 1 else ""

    type_common = loc.get("type_common_name")
    usage = type_common if type_common in USAGES else fallback_usage

    rid = loc.get("id") or room_id
    id_parts = rid.split(".")
    floor_code = id_parts[1] if len(id_parts) >= 2 else ""

    op = props.get("operator") or {}
    op_code = (op.get("code") or "").strip()
    op_name = (op.get("name") or "").strip()

    return {
        "id": rid,
        "name": loc.get("name") or rid,
        "short_name": derive_short_name(rid, loc.get("name") or rid),
        "arch": computed_map.get("Architekten-Name", ""),
        "usage": usage,
        "campus_id": campus_id,
        "campus": campus,
        "building": building,
        "floor": computed_map.get("Stockwerk", ""),
        "floor_code": floor_code,
        "address": computed_map.get("Adresse", ""),
        "lat": round(float(lat), 5),
        "lon": round(float(lon), 5),
        "cal_url": cal_url,
        "op_code": op_code,
        "op_name": op_name,
        "access": classify_access(op_code, op_name),
    }


def verify_calendar_batch(ids: list[str], start_iso: str, end_iso: str) -> set[str]:
    """Verifies which IDs in a batch (<=10) return 200 on POST /api/calendar."""
    if not ids:
        return set()

    resp = request_with_retry(
        "POST",
        f"{BASE_URL}/api/calendar",
        json={"ids": ids, "start_after": start_iso, "end_before": end_iso},
    )
    if resp.status_code == 200:
        return set(ids)

    if resp.status_code in (400, 404, 503):
        body = resp.text or ""
        match = _ROOM_ERR_RE.search(body)
        if match:
            bad_id = match.group(1).strip()
            if bad_id in ids:
                remaining = [rid for rid in ids if rid != bad_id]
                return verify_calendar_batch(remaining, start_iso, end_iso)
        if len(ids) == 1:
            return set()
        mid = len(ids) // 2
        return verify_calendar_batch(ids[:mid], start_iso, end_iso) | verify_calendar_batch(
            ids[mid:], start_iso, end_iso
        )

    resp.raise_for_status()
    return set()


def main() -> None:
    started = time.time()
    print("1/3 Searching rooms by usage on NavigaTUM...")
    discovered = discover_room_ids()
    print(f"Total unique room IDs found: {len(discovered)}")

    print("2/3 Fetching metadata and coordinates (/api/locations/{id})...")
    candidates: list[dict] = []
    with ThreadPoolExecutor(max_workers=12) as pool:
        futures = {
            pool.submit(fetch_room_detail, rid, usage): rid
            for rid, usage in discovered.items()
        }
        done = 0
        for fut in as_completed(futures):
            done += 1
            item = fut.result()
            if item is not None:
                candidates.append(item)
            if done % 200 == 0 or done == len(futures):
                print(f"  Metadata progress: {done}/{len(futures)} (with coords+cal_url: {len(candidates)})")

    print(f"3/3 Verifying live /api/calendar endpoint for {len(candidates)} rooms...")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    start_iso = f"{today}T10:00:00Z"
    end_iso = f"{today}T11:00:00Z"

    batches = [
        [c["id"] for c in candidates[i : i + 10]]
        for i in range(0, len(candidates), 10)
    ]
    verified_ids: set[str] = set()
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(verify_calendar_batch, batch, start_iso, end_iso) for batch in batches]
        for idx, fut in enumerate(as_completed(futures), 1):
            verified_ids.update(fut.result())
            if idx % 20 == 0 or idx == len(futures):
                print(f"  Verified batches: {idx}/{len(futures)} (active: {len(verified_ids)})")

    verified_rooms = sorted(
        (c for c in candidates if c["id"] in verified_ids),
        key=lambda r: (r["campus_id"], r["id"]),
    )

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(verified_rooms),
        "rooms": verified_rooms,
    }
    with OUTPUT_PATH.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    by_campus = Counter(r["campus_id"] for r in verified_rooms)
    by_usage = Counter(r["usage"] for r in verified_rooms)
    by_access = Counter(r["access"] for r in verified_rooms)

    print("\n=== CATALOG SUMMARY ===")
    print(f"Found on /api/search:        {len(discovered)}")
    print(f"With coords + calendar_url:  {len(candidates)}")
    print(f"With verified calendar:      {len(verified_rooms)}")
    print(f"Output saved:                {OUTPUT_PATH} ({size_kb:.1f} KB)")
    print(f"Total time:                  {time.time() - started:.1f}s")
    print("By access:", dict(by_access.most_common()))
    print("By campus:", dict(by_campus.most_common()))
    print("By usage:", dict(by_usage.most_common()))


if __name__ == "__main__":
    main()
