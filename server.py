#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Malaria Grid Trend — Thailand-ready, fast (Minimal)
Serves:
  /             -> static/index.html
  /static/*     -> static assets
  /api/meta     -> meta (grid, extent, dates)
  /api/geo/*    -> past | now | forecast | delta  (GeoJSON, time-enabled)

Supported CSV:
  A) date,lat,lon,value
  B) date,cell_id,value,lat_c,lon_c
  (and .csv.gz)

Env:
  CSV_FILE, GRID_KM, LAT_MIN, LAT_MAX, LON_MIN, LON_MAX, DAYS_BACK, DAYS_FWD, COORD_DEC
"""
from __future__ import annotations
import csv, json, math, os, sys, webbrowser, io, gzip
from http.server import SimpleHTTPRequestHandler
try:
    from http.server import ThreadingHTTPServer as HTTPServer
except ImportError:
    from http.server import HTTPServer
from urllib.parse import urlparse, parse_qs
from pathlib import Path
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"

# ----------------- Region + grid (default = Thailand) -----------------
LAT_MIN = float(os.environ.get("LAT_MIN", 5.6))
LAT_MAX = float(os.environ.get("LAT_MAX", 20.7))
LON_MIN = float(os.environ.get("LON_MIN", 97.0))
LON_MAX = float(os.environ.get("LON_MAX", 105.9))
GRID_KM = float(os.environ.get("GRID_KM", 10.0))  # ✅ default 10 km

MID_LAT = (LAT_MIN + LAT_MAX) / 2.0
KM_PER_DEG_LAT = 110.574
KM_PER_DEG_LON = 111.320 * math.cos(math.radians(MID_LAT))
DLAT = GRID_KM / KM_PER_DEG_LAT
DLON = GRID_KM / KM_PER_DEG_LON

def build_grid():
    cells = []
    row = 0
    lat = LAT_MIN
    while lat < LAT_MAX - 1e-12:
        col = 0
        lon = LON_MIN
        while lon < LON_MAX - 1e-12:
            lat_max = min(lat + DLAT, LAT_MAX)
            lon_max = min(lon + DLON, LON_MAX)
            cells.append({
                "id": f"r{row}c{col}",
                "lat_min": lat, "lat_max": lat_max,
                "lon_min": lon, "lon_max": lon_max,
                "lat_c": (lat + lat_max)/2, "lon_c": (lon + lon_max)/2,
                "row": row, "col": col
            })
            col += 1; lon += DLON
        row += 1; lat += DLAT
    return cells, row, col

CELLS, NROWS, NCOLS = build_grid()
CELL_BY_ID = {c["id"]: c for c in CELLS}

# ----------------- Time axis (defaults; replaced if CSV present) -----------------
TODAY = date.today()
DAYS_BACK = int(os.environ.get("DAYS_BACK", 14))
DAYS_FWD  = int(os.environ.get("DAYS_FWD", 14))
DATES: List[date] = [TODAY - timedelta(days=DAYS_BACK) + timedelta(days=i)
                     for i in range(DAYS_BACK + DAYS_FWD + 1)]
DATES_ISO = [d.isoformat() for d in DATES]

# ----------------- CSV path + helpers -----------------
def guess_csv_path() -> Path:
    p_env = os.environ.get("CSV_FILE")
    if p_env: return Path(p_env)
    for name in (
        "malaria_th_daily.csv.gz",
        "malaria_th_daily.csv",
        "malaria_th_daily_cells.csv.gz",
        "malaria_th_daily_cells.csv",
        "thailand_10km_cells.csv",   # ✔ your file name
        "malaria_tak_daily.csv",
    ):
        p = ROOT / name
        if p.exists():
            return p
    return ROOT / "malaria_tak_daily.csv"  # fallback

CSV_FILE = guess_csv_path()

def open_maybe_gzip(path: Path):
    s = str(path)
    if s.endswith(".gz"):
        return io.TextIOWrapper(gzip.open(s, "r"), encoding="utf-8")
    return open(s, "r", encoding="utf-8")

# ----------------- Synthetic (if no CSV) -----------------
def gaussian(lat, lon, lat0, lon0, s):
    return math.exp(-(((lat - lat0) ** 2 + (lon - lon0) ** 2) / (2 * s * s)))

def spatial_risk(lat, lon):
    base = 0.6 * gaussian(lat, lon, 16.7, 98.6, 0.25) + 0.4 * gaussian(lat, lon, 17.2, 98.35, 0.20)
    grad = 0.15 * (1.0 - (lon - LON_MIN) / (LON_MAX - LON_MIN))
    return base + grad

def temporal_factor(day_index: int) -> float:
    x = (day_index - DAYS_BACK) / max(DAYS_BACK, DAYS_FWD)
    return 1.0 + 0.25 * math.exp(-1.5 * x * x) + 0.05 * math.sin(day_index / 2.3)

def stable_noise(seed_str: str) -> float:
    h = 2166136261
    for ch in seed_str:
        h ^= ord(ch)
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) & 0xFFFFFFFF
    return ((h / 0xFFFFFFFF) - 0.5) * 0.1

def gen_synthetic_values() -> List[List[float]]:
    vals = []
    for day_i, _ in enumerate(DATES):
        row = []
        for c in CELLS:
            base = spatial_risk(c["lat_c"], c["lon_c"])
            v = max(0.0, 2.0 * base * temporal_factor(day_i) + stable_noise(f'{c["id"]}@{day_i}'))
            row.append(v)
        vals.append(row)
    return vals

# ----------------- CSV loader -----------------
def bin_point_to_cell(lat: float, lon: float) -> Optional[str]:
    if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
        return None
    r = int((lat - LAT_MIN) / DLAT); r = max(0, min(NROWS-1, r))
    c = int((lon - LON_MIN) / DLON); c = max(0, min(NCOLS-1, c))
    return f"r{r}c{c}"

def load_csv_or_none() -> Tuple[Optional[Dict[str, Dict[str, float]]], Optional[List[str]]]:
    if not CSV_FILE.exists():
        return None, None
    grid_map: Dict[str, Dict[str, float]] = {c["id"]: {} for c in CELLS}
    all_dates: set[str] = set()

    with open_maybe_gzip(CSV_FILE) as f:
        rdr = csv.DictReader(f)
        headers = {h.strip().lower() for h in (rdr.fieldnames or [])}
        is_cell  = {"date", "cell_id", "value"} <= headers
        is_point = {"date", "lat", "lon", "value"} <= headers or {"date","lat_c","lon_c","value"} <= headers
        if not (is_cell or is_point):
            print("[WARN] CSV header not recognized; using synthetic.")
            return None, None

        for row in rdr:
            d = (row.get("date") or "").strip()
            if not d:
                continue
            all_dates.add(d)
            try:
                v = float(row["value"])
            except Exception:
                continue

            if is_cell:
                cid = (row.get("cell_id") or "").strip()
                if cid in grid_map:
                    grid_map[cid][d] = v
            else:
                try:
                    lat = float(row.get("lat") or row.get("lat_c"))
                    lon = float(row.get("lon") or row.get("lon_c"))
                except Exception:
                    continue
                cid = bin_point_to_cell(lat, lon)
                if cid:
                    # merge duplicates of same day
                    if d not in grid_map[cid]:
                        grid_map[cid][d] = v
                    else:
                        grid_map[cid][d] = (grid_map[cid][d] + v) / 2.0

    dates_sorted = sorted(all_dates)
    if not dates_sorted:
        return None, None
    return grid_map, dates_sorted

def build_values_from_grid_map(grid_map: Dict[str, Dict[str, float]], dates_iso: List[str]) -> List[List[float]]:
    idx_by_cell = {c["id"]: j for j, c in enumerate(CELLS)}
    values = [[0.0 for _ in CELLS] for _ in dates_iso]
    for di, d_iso in enumerate(dates_iso):
        for cid, perdate in grid_map.items():
            j = idx_by_cell[cid]
            if d_iso in perdate:
                values[di][j] = perdate[d_iso]
    return values

# ----------------- Build data -----------------
GRID_MAP, CSV_DATES = load_csv_or_none()
if GRID_MAP is None:
    DATA_NOTE = "synthetic demo data"
    VALUES = gen_synthetic_values()
else:
    DATA_NOTE = f"loaded: {CSV_FILE.name}"
    DATES_ISO = CSV_DATES
    DATES = [date.fromisoformat(d) for d in DATES_ISO]
    VALUES = build_values_from_grid_map(GRID_MAP, DATES_ISO)

# Deltas
DELTAS: List[List[float]] = []
for t in range(len(DATES)):
    if t == 0:
        DELTAS.append([0.0 for _ in CELLS])
    else:
        DELTAS.append([VALUES[t][j] - VALUES[t-1][j] for j in range(len(CELLS))])

# Time index groups
PAST_IDX = [i for i, d in enumerate(DATES) if d < TODAY]
NOW_IDX  = [i for i, d in enumerate(DATES) if d == TODAY]
FWD_IDX  = [i for i, d in enumerate(DATES) if d > TODAY]

# ----------------- GeoJSON builders (on-demand) -----------------
COORD_DEC = int(os.environ.get("COORD_DEC", 4))  # fewer decimals -> smaller JSON

def cell_polygon(c):
    r = COORD_DEC
    return [
        [round(c["lon_min"], r), round(c["lat_min"], r)],
        [round(c["lon_max"], r), round(c["lat_min"], r)],
        [round(c["lon_max"], r), round(c["lat_max"], r)],
        [round(c["lon_min"], r), round(c["lat_max"], r)],
        [round(c["lon_min"], r), round(c["lat_min"], r)],
    ]

def build_features(time_indices: List[int], metric: str, stride: int = 1, min_value: Optional[float] = None) -> Dict:
    feats = []
    for ti in time_indices:
        d_iso = DATES_ISO[ti]
        for j, c in enumerate(CELLS):
            if stride > 1 and ((c["row"] % stride) != 0 or (c["col"] % stride) != 0):
                continue
            val = VALUES[ti][j] if metric == "value" else DELTAS[ti][j]
            if min_value is not None and metric == "value" and val <= min_value:
                continue
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [cell_polygon(c)]},
                "properties": {
                    "time": d_iso, "cell_id": c["id"], "row": c["row"], "col": c["col"],
                    "center_lat": round(c["lat_c"], COORD_DEC), "center_lon": round(c["lon_c"], COORD_DEC),
                    "value": round(float(val), 4)
                }
            })
    return {"type": "FeatureCollection", "features": feats}

# ----------------- HTTP handler -----------------
class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter
        sys.stderr.write("")

    def do_GET(self):
        # 1) index
        if self.path in ("/", "/index.html"):
            index_path = STATIC_DIR / "index.html"
            if index_path.exists():
                data = index_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data); return

        # 2) APIs
        if self.path.startswith("/api/meta"):
            meta = {
                "grid_km": GRID_KM,
                "lat_min": LAT_MIN, "lat_max": LAT_MAX,
                "lon_min": LON_MIN, "lon_max": LON_MAX,
                "dates": DATES_ISO,
                "data_note": DATA_NOTE,
                "csv_file": str(CSV_FILE) if CSV_FILE.exists() else None,
            }
            return self._send_json(meta)

        if self.path.startswith("/api/geo/"):
            q = parse_qs(urlparse(self.path).query)
            stride = int(q.get("stride", ["2"])[0])  # default 2 = เบาขึ้น
            min_v  = q.get("min", [None])[0]
            min_v  = float(min_v) if (min_v is not None) else None

            if self.path.startswith("/api/geo/past"):
                return self._send_json(build_features(PAST_IDX, "value", stride, min_v))
            if self.path.startswith("/api/geo/now"):
                return self._send_json(build_features(NOW_IDX,  "value", stride, min_v))
            if self.path.startswith("/api/geo/forecast"):
                return self._send_json(build_features(FWD_IDX,  "value", stride, min_v))
            if self.path.startswith("/api/geo/delta"):
                return self._send_json(build_features(list(range(len(DATES))), "delta", stride, min_v))

        # 3) static
        return super().do_GET()

    def _send_json(self, obj):
        raw = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        enc = self.headers.get("Accept-Encoding", "")
        if "gzip" in enc:
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=5) as gz:
                gz.write(raw)
            data = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Encoding", "gzip")
        else:
            data = raw
            self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

# ----------------- Server launcher -----------------
def run_server():
    hosts = ["127.0.0.1", "localhost", "0.0.0.0"]
    port0 = int(os.environ.get("PORT", "8000"))
    ports = [port0] + list(range(8010, 8040)) + [0]  # 0 = ephemeral

    for h in hosts:
        for p in ports:
            try:
                httpd = HTTPServer((h, p), Handler)
                real_port = httpd.server_address[1]
                url = f"http://{h}:{real_port}"
                print(f"[SERVE] {url}")
                try: webbrowser.open(url, new=2)
                except Exception: pass
                try: httpd.serve_forever()
                except KeyboardInterrupt: print("\n[STOP] server stopped")
                return
            except (PermissionError, OSError):
                continue
    print("[WARN] cannot bind port; set env PORT")

if __name__ == "__main__":
    source = "CSV" if CSV_FILE.exists() else "Synthetic"
    print(f"[INFO] Grid {GRID_KM:.1f} km | rows×cols={NROWS}×{NCOLS} | days={len(DATES_ISO)} | source={source} | file={CSV_FILE.name if CSV_FILE.exists() else '-'}")
    os.chdir(ROOT)  # make /static resolve
    run_server()
