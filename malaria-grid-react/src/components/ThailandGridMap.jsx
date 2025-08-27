// src/components/ThailandGridMap.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import Papa from "papaparse";
import "../styles/map.css";

/* ============ CONFIG ============ */
const CSV_URL = `${import.meta.env.BASE_URL}data/malaria_th_daily.csv`;
const GRID_KM = 10;

/* ============ MOCK VILLAGE POINTS ============ */
const villagePoints = [
  { name: "อุ้มผาง", province: "ตาก", lat: 16.042, lng: 98.854, counts: { 2025: 8, 2024: 1, 2023: 0 } },
  { name: "แม่สอด", province: "ตาก", lat: 16.714, lng: 98.569, counts: { 2025: 44, 2024: 5, 2023: 2 } },
  { name: "พบพระ", province: "ตาก", lat: 16.415, lng: 98.706, counts: { 2025: 21, 2024: 2, 2023: 1 } },
  { name: "แม่ระมาด", province: "ตาก", lat: 16.981, lng: 98.36, counts: { 2025: 15, 2024: 3, 2023: 0 } },
  { name: "ท่าสองยาง", province: "ตาก", lat: 17.133, lng: 98.015, counts: { 2025: 26, 2024: 4, 2023: 1 } },
  { name: "แม่สะเรียง", province: "แม่ฮ่องสอน", lat: 18.166, lng: 97.933, counts: { 2025: 12, 2024: 0, 2023: 0 } },
  { name: "สบเมย", province: "แม่ฮ่องสอน", lat: 17.718, lng: 97.932, counts: { 2025: 19, 2024: 1, 2023: 0 } },
  { name: "ปางมะผ้า", province: "แม่ฮ่องสอน", lat: 19.565, lng: 98.248, counts: { 2025: 7, 2024: 0, 2023: 0 } },
  { name: "แม่ลาน้อย", province: "แม่ฮ่องสอน", lat: 18.286, lng: 97.941, counts: { 2025: 10, 2024: 2, 2023: 0 } },
  { name: "สังขละบุรี", province: "กาญจนบุรี", lat: 15.154, lng: 98.456, counts: { 2025: 33, 2024: 4, 2023: 1 } },
  { name: "ทองผาภูมิ", province: "กาญจนบุรี", lat: 14.735, lng: 98.642, counts: { 2025: 27, 2024: 3, 2023: 1 } },
  { name: "ไทรโยค", province: "กาญจนบุรี", lat: 14.395, lng: 98.993, counts: { 2025: 18, 2024: 2, 2023: 1 } },
  { name: "บางสะพาน", province: "ประจวบคีรีขันธ์", lat: 11.209, lng: 99.493, counts: { 2025: 9, 2024: 0, 2023: 0 } },
  { name: "ทับสะแก", province: "ประจวบคีรีขันธ์", lat: 11.273, lng: 99.608, counts: { 2025: 6, 2024: 0, 2023: 0 } },
  { name: "ระนอง", province: "ระนอง", lat: 9.963, lng: 98.638, counts: { 2025: 17, 2024: 1, 2023: 0 } },
  { name: "หลังสวน", province: "ชุมพร", lat: 10.109, lng: 99.21, counts: { 2025: 13, 2024: 1, 2023: 0 } },
  { name: "คีรีรัฐนิคม", province: "สุราษฎร์ธานี", lat: 8.914, lng: 99.178, counts: { 2025: 11, 2024: 0, 2023: 0 } },
  { name: "พังงา", province: "พังงา", lat: 8.45, lng: 98.525, counts: { 2025: 7, 2024: 0, 2023: 0 } },
  { name: "คลองท่อม", province: "กระบี่", lat: 7.93, lng: 99.142, counts: { 2025: 8, 2024: 0, 2023: 0 } },
  { name: "ควนโดน", province: "สตูล", lat: 6.939, lng: 100.083, counts: { 2025: 5, 2024: 0, 2023: 0 } },
];

/* ========= TARGET TOTAL + SCALER ========= */
const TARGET_TOTAL = 7850;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function scaleVillageCounts(points, target) {
  const baseArr = points.map((p) => p.counts?.[2025] || 0);
  const baseSum = baseArr.reduce((a, b) => a + b, 0);
  if (baseSum <= 0) {
    const m = new Map();
    points.forEach((p) => m.set(p.name, 0));
    return { scaled: m, total: 0 };
  }
  const scaledFloat = baseArr.map((v) => (v * target) / baseSum);
  const floors = scaledFloat.map((x) => Math.floor(x));
  let remainder = target - floors.reduce((a, b) => a + b, 0);

  const order = scaledFloat
    .map((x, i) => ({ i, frac: x - floors[i] }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && remainder > 0; k++) {
    floors[order[k].i]++;
    remainder--;
  }

  const m = new Map();
  points.forEach((p, idx) => m.set(p.name, floors[idx]));
  return { scaled: m, total: target };
}

/* ===== กระจายค่าเป็น 2023/2024 (ไว้โชว์ในโมดัล) ===== */
function buildYearSpreadMap(points, scaledMap) {
  const spread = new Map();
  for (const p of points) {
    const s25 = scaledMap.get(p.name) || 0;
    const c23 = p.counts?.[2023] || 0;
    const c24 = p.counts?.[2024] || 0;
    const r24base = (c24 + 0.5) / (s25 + 1);
    const r23base = (c23 + 0.5) / (s25 + 1);
    const r24 = clamp(0.18 + 0.6 * r24base, 0.12, 0.45);
    const r23 = clamp(0.1 + 0.5 * r23base, 0.05, 0.3);
    let y24 = Math.round(s25 * r24);
    let y23 = Math.round(s25 * r23);
    y24 = Math.max(Math.min(y24, s25), c24);
    y23 = Math.max(Math.min(y23, y24), c23);
    spread.set(p.name, { 2023: y23, 2024: y24, 2025: s25 });
  }
  return spread;
}

function top5ByProvinceScaled(countMap) {
  const byProv = new Map();
  for (const p of villagePoints) {
    const v = countMap.get(p.name) || 0;
    byProv.set(p.province, (byProv.get(p.province) || 0) + v);
  }
  return [...byProv.entries()]
    .map(([province, value]) => ({ province, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
}

const fmt = (n) => Number(n || 0).toLocaleString("th-TH");

/* ============ COLOR SCALES ============ */
function valueColor(v) {
  return v > 1.8
    ? "#800026"
    : v > 1.2
    ? "#BD0026"
    : v > 0.9
    ? "#E31A1C"
    : v > 0.6
    ? "#FC4E2A"
    : v > 0.4
    ? "#FD8D3C"
    : v > 0.2
    ? "#FEB24C"
    : v > 0.1
    ? "#FED976"
    : "#FFEDA0";
}
function deltaColor(d) {
  return d > 0.25
    ? "#99000d"
    : d > 0.15
    ? "#cb181d"
    : d > 0.08
    ? "#ef3b2c"
    : d > 0.03
    ? "#fb6a4a"
    : d > 0
    ? "#fcae91"
    : d > -0.03
    ? "#c6dbef"
    : d > -0.08
    ? "#9ecae1"
    : d > -0.15
    ? "#6baed6"
    : d > -0.25
    ? "#3182bd"
    : "#08519c";
}

/* ============ RECT FROM CENTER (KM GRID) ============ */
function rectFromCenter(lat, lon, gridKm = GRID_KM) {
  const dLat = gridKm / 110.574;
  const dLon = gridKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const sw = [lat - dLat / 2, lon - dLon / 2];
  const ne = [lat + dLat / 2, lon + dLon / 2];
  return [
    [sw[0], sw[1]],
    [sw[0], ne[1]],
    [ne[0], ne[1]],
    [ne[0], sw[1]],
    [sw[0], sw[1]],
  ];
}

/* ============ CSV LOADER ============ */
async function loadCsvRows(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch CSV failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const parseWith = (opt = {}) =>
    Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: true, ...opt });
  let p = parseWith();
  if (!p.data?.length || Object.keys(p.data[0] || {}).length <= 1) p = parseWith({ delimiter: ";" });
  return p.data
    .map((r) => {
      const lat = r.lat_c ?? r.lat,
        lon = r.lon_c ?? r.lon,
        v = Number(r.value);
      const latn = Number(lat),
        lonn = Number(lon);
      let cid = r.cell_id ?? r.id ?? r.cell;
      if (!cid && Number.isFinite(latn) && Number.isFinite(lonn)) cid = `${latn.toFixed(3)}_${lonn.toFixed(3)}`;
      return {
        date: String(r.date ?? "").slice(0, 10),
        cell_id: cid,
        value: Number.isFinite(v) ? v : NaN,
        lat_c: Number.isFinite(latn) ? latn : NaN,
        lon_c: Number.isFinite(lonn) ? lonn : NaN,
      };
    })
    .filter((r) => r.date && r.cell_id && Number.isFinite(r.value) && Number.isFinite(r.lat_c) && Number.isFinite(r.lon_c));
}

export default function ThailandGridMap() {
  const mapRef = useRef(null);
  const lyrNowRef = useRef(null);
  const lyrPastRef = useRef(null);
  const lyrFwdRef = useRef(null);
  const lyrDeltaRef = useRef(null);
  const villagesLayerRef = useRef(null);

  const [rows, setRows] = useState([]);
  const [dates, setDates] = useState([]);
  const [dateIdx, setDateIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(2);
  const [loading, setLoading] = useState(true);
  const [csvErr, setCsvErr] = useState(null);
  const [selectedVillage, setSelectedVillage] = useState(null);

  /* ===== สรุป 7,850 + กระจายย้อนหลัง ===== */
  const { scaled: scaledMap, total: scaledTotal } = useMemo(() => scaleVillageCounts(villagePoints, TARGET_TOTAL), []);
  const yearSpreadMap = useMemo(() => buildYearSpreadMap(villagePoints, scaledMap), [scaledMap]);
  const top5 = useMemo(() => top5ByProvinceScaled(scaledMap), [scaledMap]);
  const topMax = Math.max(...top5.map((d) => d.value), 1);

  const byDate = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.date)) m.set(r.date, []);
      m.get(r.date).push(r);
    }
    return m;
  }, [rows]);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const data = await loadCsvRows(CSV_URL);
        const uniq = Array.from(new Set(data.map((d) => d.date))).sort();
        setRows(data);
        setDates(uniq);
        const today = new Date().toISOString().slice(0, 10);
        setDateIdx(Math.max(0, uniq.indexOf(today)));
      } catch (e) {
        setCsvErr(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (mapRef.current) return;

    const m = L.map("map", { center: [15.5, 101.0], zoom: 6, preferCanvas: true });

    const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "© OpenStreetMap",
    }).addTo(m);
    const terrain = L.tileLayer("https://stamen-tiles.a.ssl.fastly.net/terrain/{z}/{x}/{y}.jpg", {
      maxZoom: 18,
      attribution: "Stamen Terrain",
    });
    const toner = L.tileLayer("https://stamen-tiles.a.ssl.fastly.net/toner/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "Stamen Toner",
    });

    const mkGeo = () =>
      L.geoJSON([], {
        renderer: L.canvas({ padding: 0.5 }),
        style: (ft) => ft.properties._style || {},
        onEachFeature: (ft, layer) => {
          const p = ft.properties;
          layer.bindPopup(
            `<b>Cell:</b> ${p.cell_id}<br>` +
              `<b>Date:</b> ${p.date}<br>` +
              `<b>Lat,Lon:</b> ${p.lat_c?.toFixed(4)}, ${p.lon_c?.toFixed(4)}<br>` +
              `<b>Value:</b> ${p.value}<br>` +
              `<b>Δ vs prev:</b> ${Number(p.delta ?? 0).toFixed(4)}`
          );
        },
      });

    lyrNowRef.current = mkGeo().addTo(m);
    lyrPastRef.current = mkGeo();
    lyrFwdRef.current = mkGeo();
    lyrDeltaRef.current = mkGeo();

    villagesLayerRef.current = L.layerGroup().addTo(m);

    L.control
      .layers(
        { OpenStreetMap: osm, Terrain: terrain, Toner: toner },
        {
          "Malaria — Current": lyrNowRef.current,
          "Malaria — Past": lyrPastRef.current,
          "Malaria — Forecast": lyrFwdRef.current,
          "Change (Δ)": lyrDeltaRef.current,
        },
        { collapsed: false, position: "topright" }
      )
      .addTo(m);

    mapRef.current = m;
  }, []);

  function buildGeoJSON(list, paint) {
    const feats = list.map((r) => {
      const coords = rectFromCenter(r.lat_c, r.lon_c, GRID_KM);
      const style = paint(r);
      return {
        type: "Feature",
        properties: { ...r, _style: style },
        geometry: { type: "Polygon", coordinates: [coords.map(([la, lo]) => [lo, la])] },
      };
    });
    return { type: "FeatureCollection", features: feats };
  }

  useEffect(() => {
    if (!mapRef.current || dates.length === 0) return;

    const sel = dates[Math.min(Math.max(dateIdx, 0), dates.length - 1)];
    const curr = byDate.get(sel) || [];

    if (lyrNowRef.current && mapRef.current.hasLayer(lyrNowRef.current)) {
      const gj = buildGeoJSON(curr, (r) => ({
        weight: 0.5,
        color: "#333",
        opacity: 1,
        fillColor: valueColor(r.value),
        fillOpacity: 0.65,
      }));
      lyrNowRef.current.clearLayers();
      lyrNowRef.current.addData(gj);
    }

    if (dateIdx > 0 && lyrPastRef.current && mapRef.current.hasLayer(lyrPastRef.current)) {
      const prev = byDate.get(dates[dateIdx - 1]) || [];
      const gj = buildGeoJSON(prev, (r) => ({
        weight: 0.5,
        color: "#333",
        opacity: 1,
        fillColor: valueColor(r.value),
        fillOpacity: 0.4,
      }));
      lyrPastRef.current.clearLayers();
      lyrPastRef.current.addData(gj);
    } else if (lyrPastRef.current) {
      lyrPastRef.current.clearLayers();
    }

    if (dateIdx < dates.length - 1 && lyrFwdRef.current && mapRef.current.hasLayer(lyrFwdRef.current)) {
      const fwd = byDate.get(dates[dateIdx + 1]) || [];
      const gj = buildGeoJSON(fwd, (r) => ({
        weight: 0.5,
        color: "#333",
        opacity: 1,
        fillColor: valueColor(r.value),
        fillOpacity: 0.4,
      }));
      lyrFwdRef.current.clearLayers();
      lyrFwdRef.current.addData(gj);
    } else if (lyrFwdRef.current) {
      lyrFwdRef.current.clearLayers();
    }

    if (dateIdx > 0 && lyrDeltaRef.current && mapRef.current.hasLayer(lyrDeltaRef.current)) {
      const prev = byDate.get(dates[dateIdx - 1]) || [];
      const prevMap = new Map(prev.map((r) => [r.cell_id, r.value]));
      const withDelta = curr.map((r) => ({ ...r, delta: r.value - (prevMap.get(r.cell_id) ?? 0) }));
      const gj = buildGeoJSON(withDelta, (r) => ({
        weight: 0.5,
        color: "#333",
        opacity: 1,
        fillColor: deltaColor(r.delta ?? 0),
        fillOpacity: 0.65,
      }));
      lyrDeltaRef.current.clearLayers();
      lyrDeltaRef.current.addData(gj);
    } else if (lyrDeltaRef.current) {
      lyrDeltaRef.current.clearLayers();
    }

    const visible = [lyrNowRef.current, lyrDeltaRef.current, lyrPastRef.current, lyrFwdRef.current].filter(
      (l) => l && mapRef.current.hasLayer(l)
    );
    if (visible.length) {
      const b = visible[0].getBounds?.();
      if (b && b.isValid()) mapRef.current.fitBounds(b.pad(0.05));
    }
  }, [dateIdx, dates, byDate]);

  /* ===== วาดจุดแดง (ใช้ค่าหลังสเกลปี 2025) ===== */
  useEffect(() => {
    if (!mapRef.current || !villagesLayerRef.current) return;

    villagesLayerRef.current.clearLayers();

    const ranked = [...villagePoints].sort(
      (a, b) => (scaledMap.get(b.name) || 0) - (scaledMap.get(a.name) || 0)
    );
    const top3Names = new Set(ranked.slice(0, 3).map((v) => v.name));

    for (const v of villagePoints) {
      const n = scaledMap.get(v.name) || 0;

      const html = `
        <div class="vp-bubble ${top3Names.has(v.name) ? "vp-top3" : ""}">
          <span>${n}</span>
        </div>`;
      const icon = L.divIcon({
        className: "vp-icon",
        html,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
      });

      const marker = L.marker([v.lat, v.lng], { icon });
      marker.bindTooltip(v.name, {
        direction: "right",
        offset: [10, 0],
        permanent: false,
        className: "vp-tooltip",
      });
      marker.on("click", () => setSelectedVillage(v));
      marker.addTo(villagesLayerRef.current);
    }
  }, [scaledMap]);

  // ===== ไปหน้า risk-assessment พร้อม query =====
  function handleNext(village) {
    if (!village) return;

    const risk = scaledMap.get(village.name) || 0;
    const level = risk > 20 ? "urgent" : risk > 10 ? "medium" : "normal";

    const payload = {
      name: village.name || "ไม่ระบุ",
      lat: String(village.lat ?? ""),
      lng: String(village.lng ?? village.lon ?? ""),
      level,
      risk: String(risk),
    };

    localStorage.setItem("selectedVillage", JSON.stringify(payload));

    // 🔗 ชี้ไปโดเมนใหม่ malariax.health
    const ORIGIN = import.meta.env.VITE_RISK_APP_ORIGIN || "https://www.malariax.health";
    const PATH = "/risk-assessment";
    const url = new URL(PATH, ORIGIN);
    url.search = new URLSearchParams(payload).toString();

    window.location.href = url.toString();
  }

  const selDate = dates.length ? dates[Math.min(Math.max(dateIdx, 0), dates.length - 1)] : "-";

  return (
    <>
      <div id="map" />

      {/* ===== กล่องซ้าย (UI Card + Legend) ===== */}
      <div className="ui-card">
        <div className="ui-title">มาลาเรีย — แผนที่แนวโน้มแบบกริด (ประเทศไทย)</div>
        <div className="ui-subtle">
          ไฟล์: <code className="mono">{CSV_URL.replace(import.meta.env.BASE_URL, "/")}</code>
        </div>

        <div className="ui-row">
          <label>วันที่</label>
          <div className="badge">{selDate}</div>
          <div className="spacer" />
          <label className="muted">Speed</label>
          <input type="range" min={1} max={8} value={fps} onChange={(e) => setFps(+e.target.value)} />
          <button className="btn" onClick={() => setPlaying((p) => !p)} title={playing ? "หยุด" : "เล่น"}>
            {playing ? "⏸" : "▶"}
          </button>
          <button className="btn" onClick={() => setDateIdx((i) => Math.max(0, i - 1))} title="วันก่อนหน้า">
            ◀
          </button>
          <button className="btn" onClick={() => setDateIdx((i) => Math.min(dates.length - 1, i + 1))} title="วันถัดไป">
            ▶
          </button>
        </div>

        <div className="ui-row">
          <input
            className="slider-wide"
            type="range"
            min={0}
            max={Math.max(0, dates.length - 1)}
            value={dateIdx}
            onChange={(e) => setDateIdx(Number(e.target.value))}
          />
        </div>

        {loading && <div className="ui-note">กำลังโหลด CSV…</div>}
        {csvErr && <div className="ui-error">CSV error: {csvErr}</div>}

        <div className="legend">
          <div className="legend-title">Legend (Incidence & Δ)</div>
          <div className="legend-sub">Incidence</div>
          {[
            ["> 1.8", "#800026"],
            ["1.2–1.8", "#BD0026"],
            ["0.9–1.2", "#E31A1C"],
            ["0.6–0.9", "#FC4E2A"],
            ["0.4–0.6", "#FD8D3C"],
            ["0.2–0.4", "#FEB24C"],
            ["0.1–0.2", "#FED976"],
            ["≤ 0.1", "#FFEDA0"],
          ].map(([lab, col]) => (
            <div className="legend-row" key={`v-${lab}`}>
              <span className="box" style={{ background: col }} />
              {lab}
            </div>
          ))}
          <div className="legend-sub" style={{ marginTop: 6 }}>
            Δ change vs previous day
          </div>
          {[
            ["> 0.25", "#99000d"],
            ["0.15–0.25", "#cb181d"],
            ["0.08–0.15", "#ef3b2c"],
            ["0.03–0.08", "#fb6a4a"],
            ["0–0.03", "#fcae91"],
            ["-0.03–0", "#c6dbef"],
            ["-0.08–-0.03", "#9ecae1"],
            ["-0.15–-0.08", "#6baed6"],
            ["-0.25–-0.15", "#3182bd"],
            ["< -0.25", "#08519c"],
          ].map(([lab, col]) => (
            <div className="legend-row" key={`d-${lab}`}>
              <span className="box" style={{ background: col }} />
              {lab}
            </div>
          ))}
        </div>
      </div>

      {/* ===== กล่องขวา (สรุป/Top5/Marker Info) ===== */}
      <div className="right-panel">
        <div className="card">
          <div className="card-header">
            <span>ผู้เสี่ยงติดเชื้อ</span>
            <span className="caret">▾</span>
          </div>
          <div className="summary-box">
            <div className="summary-value">{fmt(scaledTotal)}</div>
            <div className="summary-year">2025</div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span>Top5</span>
            <span className="caret">▾</span>
          </div>
        <div className="bars">
            {top5.map((d) => (
              <div className="bar-row" key={d.province}>
                <div className="bar-label">{d.province}</div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(d.value / topMax) * 100}%` }} />
                  <div className="bar-value">{fmt(d.value)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="marker-info card">
          <div className="card-header">
            <span>Marker Info</span>
            <span className="caret">▾</span>
          </div>
          <div className="mi-row">
            <span className="mi-dot" /> CaseInVillage
            <span className="mi-spacer" />
            <span className="mi-top3" /> Top3
          </div>
        </div>
      </div>

      {/* ===== โมดัลเลือกหมู่บ้าน ===== */}
      {selectedVillage && (
        <div className="modal-mask" onClick={() => setSelectedVillage(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">
              Village: {selectedVillage.name}
              <button className="modal-close" onClick={() => setSelectedVillage(null)}>
                ✕
              </button>
            </div>

            <div className="modal-body">
              <div className="detail-box">
                <div className="detail-title">
                  Detail | <span className="detail-date">25-Feb</span> <span className="arrow">→</span>{" "}
                  <span className="detail-date green">10-Dec</span>
                </div>
                <div className="detail-lines">
                  <div>
                    Year: 2025 = <b>{yearSpreadMap.get(selectedVillage.name)?.[2025] || 0}</b>
                  </div>
                  <div>
                    Year: 2024 = <b>{yearSpreadMap.get(selectedVillage.name)?.[2024] || 0}</b>
                  </div>
                  <div>
                    Year: 2023 = <b>{yearSpreadMap.get(selectedVillage.name)?.[2023] || 0}</b>
                  </div>
                </div>
              </div>

              <div className="mini-bars">
                {[2025, 2024, 2023].map((y) => {
                  const ys = yearSpreadMap.get(selectedVillage.name) || { 2025: 0, 2024: 0, 2023: 0 };
                  const show = ys[y] || 0;
                  const maxv = Math.max(ys[2025], ys[2024], ys[2023], 1);
                  const h = (show / maxv) * 120;
                  return (
                    <div className="mb-col" key={y}>
                      <div className="mb-bar" style={{ height: `${h}px` }}>
                        {show}
                      </div>
                      <div className="mb-year">{y}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="modal-footer">
              <button id="next-button" className="btn-primary" onClick={() => handleNext(selectedVillage)}>
                ต่อไป
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
