#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Malaria Grid Trend — Single-file server (Tak, Thailand)
- Stdlib only. Serves Leaflet + TimeDimension map with Play/Pause timeline.
- Layers: Past / Current / Forecast / Δ (day-over-day change)
- Grid default: 5×5 km (change via env GRID_KM)
- Uses malaria_tak_daily.csv if present: either (date,cell_id,value) or (date,lat,lon,value)
"""

from __future__ import annotations
import csv, json, math, os, sys, webbrowser
from http.server import SimpleHTTPRequestHandler
try:
    from http.server import ThreadingHTTPServer as HTTPServer
except ImportError:
    from http.server import HTTPServer
from pathlib import Path
from datetime import date, timedelta
from typing import Dict, List, Optional

# ----------------- Region + grid -----------------
LAT_MIN, LAT_MAX = 15.6, 18.2
LON_MIN, LON_MAX = 97.5, 99.4
GRID_KM = float(os.environ.get("GRID_KM", 5.0))

MID_LAT = (LAT_MIN + LAT_MAX) / 2.0
KM_PER_DEG_LAT = 111.32
KM_PER_DEG_LON = 111.32 * math.cos(math.radians(MID_LAT))
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

# ----------------- Time axis -----------------
TODAY = date.today()
DAYS_BACK = int(os.environ.get("DAYS_BACK", 14))
DAYS_FWD  = int(os.environ.get("DAYS_FWD", 14))
DATES: List[date] = [TODAY - timedelta(days=DAYS_BACK) + timedelta(days=i)
                     for i in range(DAYS_BACK + DAYS_FWD + 1)]
DATES_ISO = [d.isoformat() for d in DATES]

# ----------------- Data (CSV or synthetic) -----------------
CSV_FILE = Path("malaria_tak_daily.csv")

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

def bin_point_to_cell(lat: float, lon: float) -> Optional[str]:
    if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
        return None
    r = int((lat - LAT_MIN) / DLAT); r = max(0, min(NROWS-1, r))
    c = int((lon - LON_MIN) / DLON); c = max(0, min(NCOLS-1, c))
    return f"r{r}c{c}"

def load_csv_or_none():
    if not CSV_FILE.exists():
        return None
    grid_map: Dict[str, Dict[str, float]] = {c["id"]: {} for c in CELLS}
    with CSV_FILE.open("r", encoding="utf-8") as f:
        rdr = csv.DictReader(f)
        headers = {h.strip().lower() for h in (rdr.fieldnames or [])}
        is_cell  = {"date", "cell_id", "value"} <= headers
        is_point = {"date", "lat", "lon", "value"} <= headers
        if not (is_cell or is_point):
            print("[WARN] CSV header not recognized; using synthetic.")
            return None
        for row in rdr:
            d = row["date"].strip()
            if d not in DATES_ISO:  # skip dates outside window
                continue
            try:
                v = float(row["value"])
            except Exception:
                continue
            if is_cell:
                cid = row["cell_id"].strip()
                if cid in grid_map:
                    grid_map[cid][d] = v
            else:
                lat = float(row["lat"]); lon = float(row["lon"])
                cid = bin_point_to_cell(lat, lon)
                if cid:
                    if d not in grid_map[cid]:
                        grid_map[cid][d] = v
                    else:
                        grid_map[cid][d] = (grid_map[cid][d] + v) / 2.0
    return grid_map

def build_values_from_grid_map(grid_map: Dict[str, Dict[str, float]]) -> List[List[float]]:
    idx_by_cell = {c["id"]: j for j, c in enumerate(CELLS)}
    values = [[0.0 for _ in CELLS] for _ in DATES]
    for di, d_iso in enumerate(DATES_ISO):
        for cid, perdate in grid_map.items():
            j = idx_by_cell[cid]
            if d_iso in perdate:
                values[di][j] = perdate[d_iso]
    return values

GRID_MAP = load_csv_or_none()
if GRID_MAP is None:
    VALUES = gen_synthetic_values()
    DATA_NOTE = "ข้อมูลสังเคราะห์เพื่อสาธิต UI"
else:
    VALUES = build_values_from_grid_map(GRID_MAP)
    DATA_NOTE = "ข้อมูลจาก malaria_tak_daily.csv"

DELTAS = []
for t in range(len(DATES)):
    if t == 0:
        DELTAS.append([0.0 for _ in CELLS])
    else:
        DELTAS.append([VALUES[t][j] - VALUES[t-1][j] for j in range(len(CELLS))])

PAST_IDX = [i for i, d in enumerate(DATES) if d < TODAY]
NOW_IDX  = [i for i, d in enumerate(DATES) if d == TODAY]
FWD_IDX  = [i for i, d in enumerate(DATES) if d > TODAY]

def cell_polygon(c):
    return [
        [round(c["lon_min"], 5), round(c["lat_min"], 5)],
        [round(c["lon_max"], 5), round(c["lat_min"], 5)],
        [round(c["lon_max"], 5), round(c["lat_max"], 5)],
        [round(c["lon_min"], 5), round(c["lat_max"], 5)],
        [round(c["lon_min"], 5), round(c["lat_min"], 5)],
    ]

def build_features(time_indices: List[int], metric: str) -> Dict:
    feats = []
    for ti in time_indices:
        d_iso = DATES_ISO[ti]
        for j, c in enumerate(CELLS):
            val = VALUES[ti][j] if metric == "value" else DELTAS[ti][j]
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [cell_polygon(c)]},
                "properties": {
                    "time": d_iso, "cell_id": c["id"], "row": c["row"], "col": c["col"],
                    "center_lat": round(c["lat_c"], 5), "center_lon": round(c["lon_c"], 5),
                    "value": round(float(val), 4)
                }
            })
    return {"type": "FeatureCollection", "features": feats}

GEO_PAST  = build_features(PAST_IDX, "value")
GEO_NOW   = build_features(NOW_IDX,  "value")
GEO_FWD   = build_features(FWD_IDX,  "value")
GEO_DELTA = build_features(list(range(len(DATES))), "delta")

# ----------------- HTML (includes iso8601-js-period) -----------------
HTML_PAGE = r"""<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8"/>
<title>Malaria Grid Trend — Tak</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>

<!-- REQUIRED for Leaflet.TimeDimension -->
<script src="https://cdn.jsdelivr.net/npm/iso8601-js-period@0.2.1/iso8601.min.js"></script>

<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet-timedimension@1.1.0/dist/leaflet.timedimension.control.min.css"/>
<script src="https://cdn.jsdelivr.net/npm/leaflet-timedimension@1.1.0/dist/leaflet.timedimension.min.js"></script>

<style>
  html, body, #map { height: 100%; margin: 0; }
  .titlebar { position:absolute; top:10px; left:10px; z-index:1000; background:rgba(255,255,255,.95); padding:8px 12px; border-radius:8px; box-shadow:0 1px 4px rgba(0,0,0,.3); font-weight:600; }
  .legend { background:#fff; padding:10px; border-radius:6px; box-shadow:0 1px 4px rgba(0,0,0,.3); line-height:1.2; }
  .legend .row { display:flex; align-items:center; gap:6px; margin:2px 0; }
  .legend .box { width:18px; height:12px; border:1px solid #999; }
  .info { position:absolute; top:10px; right:10px; z-index:1000; background:rgba(255,255,255,.95); padding:10px; border-radius:8px; box-shadow:0 1px 4px rgba(0,0,0,.3); width:300px }
  .gridnote { font-size:12px; color:#333; margin-top:6px; }
</style>
</head>
<body>
<div id="map"></div>
<script>
function valueColor(v){ return v>1.8?'#800026':v>1.2?'#BD0026':v>0.9?'#E31A1C':v>0.6?'#FC4E2A':v>0.4?'#FD8D3C':v>0.2?'#FEB24C':v>0.1?'#FED976':'#FFEDA0'; }
function deltaColor(d){ return d>0.25?'#99000d':d>0.15?'#cb181d':d>0.08?'#ef3b2c':d>0.03?'#fb6a4a':d>0?'#fcae91':d>-0.03?'#c6dbef':d>-0.08?'#9ecae1':d>-0.15?'#6baed6':d>-0.25?'#3182bd':'#08519c'; }
function styleFor(type){ return (ft)=>({weight:.9,color:'#333',opacity:1,fillColor:(type==='delta'?deltaColor(ft.properties.value):valueColor(ft.properties.value)),fillOpacity:.65}); }
function onEach(ft, layer){ const p=ft.properties; layer.bindPopup("<b>Grid:</b> "+p.cell_id+"<br><b>Date:</b> "+p.time+"<br><b>Lat,Lon:</b> "+p.center_lat+", "+p.center_lon+"<br><b>Value:</b> "+p.value); }
async function j(path){ const r=await fetch(path); return await r.json(); }

(async function(){
  const meta = await j('/api/meta');

  const map = L.map('map', {
    center:[16.8,98.8], zoom:8, zoomSnap:.25,
    timeDimension:true,
    timeDimensionOptions:{ timeInterval: meta.dates[0] + "/" + meta.dates[meta.dates.length-1], period:"P1D" },
    timeDimensionControl:true,
    timeDimensionControlOptions:{ autoPlay:false, loopButton:true, timeSliderDragUpdate:true, playerOptions:{transitionTime:200, loop:true, startOver:true} }
  });

  const base=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18,attribution:'© OpenStreetMap'}).addTo(map);
  const terrain=L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/terrain/{z}/{x}/{y}.jpg',{maxZoom:18,attribution:'Stamen Terrain'});
  const toner=L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/toner/{z}/{x}/{y}.png',{maxZoom:18,attribution:'Stamen Toner'});
  L.control.layers({"OpenStreetMap":base,"Terrain":terrain,"Toner":toner}, null, {collapsed:false}).addTo(map);

  const title=L.control({position:'topleft'}); title.onAdd=()=>{const d=L.DomUtil.create('div','titlebar'); d.innerHTML="มาลาเรีย — แผนที่แนวโน้มแบบกริด (จังหวัดตาก)"; return d;}; title.addTo(map);
  const info=L.control({position:'topright'}); info.onAdd=()=>{const d=L.DomUtil.create('div','info'); d.innerHTML="<b>ฟิลเตอร์ชั้นข้อมูล</b> (ใช้กล่อง Layers ซ้ายล่าง)<div class='gridnote'>ขนาดกริด: "+meta.grid_km+"×"+meta.grid_km+" กม. | แหล่งข้อมูล: "+meta.data_note+"</div>"; return d;}; info.addTo(map);

  const lgVal=L.control({position:'bottomright'}); lgVal.onAdd=()=>{const div=L.DomUtil.create('div','legend'); const s=[['#800026','> 1.8'],['#BD0026','1.2–1.8'],['#E31A1C','0.9–1.2'],['#FC4E2A','0.6–0.9'],['#FD8D3C','0.4–0.6'],['#FEB24C','0.2–0.4'],['#FED976','0.1–0.2'],['#FFEDA0','≤ 0.1']]; let h="<div><b>Incidence (cases / 1,000 / day)</b></div>"; for(let i=0;i<s.length;i++){h+="<div class='row'><span class='box' style='background:"+s[i][0]+"'></span>"+s[i][1]+"</div>"}; div.innerHTML=h; return div;}; lgVal.addTo(map);
  const lgDelta=L.control({position:'bottomleft'}); lgDelta.onAdd=()=>{const div=L.DomUtil.create('div','legend'); const s=[['#99000d','> 0.25'],['#cb181d','0.15–0.25'],['#ef3b2c','0.08–0.15'],['#fb6a4a','0.03–0.08'],['#fcae91','0–0.03'],['#c6dbef','-0.03–0'],['#9ecae1','-0.08–-0.03'],['#6baed6','-0.15–-0.08'],['#3182bd','-0.25–-0.15'],['#08519c','< -0.25']]; let h="<div><b>Δ Change vs previous day</b></div>"; for(let i=0;i<s.length;i++){h+="<div class='row'><span class='box' style='background:"+s[i][0]+"'></span>"+s[i][1]+"</div>"}; div.innerHTML=h; return div;}; lgDelta.addTo(map);

  const [gp,gn,gf,gd]=await Promise.all([j('/api/geo/past'), j('/api/geo/now'), j('/api/geo/forecast'), j('/api/geo/delta')]);
  function td(gj,type){ const g=L.geoJson(gj,{style:styleFor(type), onEachFeature:onEach}); return L.timeDimension.layer.geoJson(g,{updateTimeDimension:true, updateTimeDimensionMode:'replace', duration:'P1D'}); }
  const past=td(gp,'value'), now=td(gn,'value'), fwd=td(gf,'value'), delt=td(gd,'delta');
  now.addTo(map);
  L.control.layers(null, {"Malaria — Past":past,"Malaria — Current":now,"Malaria — Forecast":fwd,"Change (Δ)":delt}, {collapsed:false}).addTo(map);
  map.fitBounds([[meta.lat_min, meta.lon_min],[meta.lat_max, meta.lon_max]]);
})();
</script>
</body>
</html>
"""

# ----------------- HTTP handler -----------------
class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter
        sys.stderr.write("")

    def do_GET(self):
        # favicon -> 204 (no content) to silence 404 warning
        if self.path == "/favicon.ico":
            self.send_response(204); self.end_headers(); return

        if self.path in ("/", "/index.html"):
            data = HTML_PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data); return

        if self.path == "/api/meta":
            meta = {
                "grid_km": GRID_KM,
                "lat_min": LAT_MIN, "lat_max": LAT_MAX,
                "lon_min": LON_MIN, "lon_max": LON_MAX,
                "dates": DATES_ISO,
                "data_note": "ข้อมูลจาก malaria_tak_daily.csv" if CSV_FILE.exists() else "ข้อมูลสังเคราะห์เพื่อสาธิต UI",
            }
            self._send_json(meta); return

        if self.path == "/api/geo/past":     self._send_json(GEO_PAST);  return
        if self.path == "/api/geo/now":      self._send_json(GEO_NOW);   return
        if self.path == "/api/geo/forecast": self._send_json(GEO_FWD);   return
        if self.path == "/api/geo/delta":    self._send_json(GEO_DELTA); return

        self.send_response(404); self.end_headers(); self.wfile.write(b"404 not found")

    def _send_json(self, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

# ----------------- Server launcher (robust ports) -----------------
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

    print("[WARN] ไม่สามารถเปิดพอร์ตได้ — ลองรันใหม่หรือเปลี่ยนพอร์ตด้วย env PORT")

if __name__ == "__main__":
    print(f"[INFO] Grid {GRID_KM:.1f}×{GRID_KM:.1f} km | rows×cols={NROWS}×{NCOLS} | days={len(DATES_ISO)} | source={'CSV' if CSV_FILE.exists() else 'Synthetic'}")
    run_server()
