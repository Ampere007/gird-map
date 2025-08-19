import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import Papa from "papaparse";
import "../styles/map.css";

const CSV_URL = `${import.meta.env.BASE_URL}data/malaria_th_daily.csv`;
const GRID_KM = 10;

// ----- color scales -----
function valueColor(v){
  return v > 1.8 ? "#800026" :
         v > 1.2 ? "#BD0026" :
         v > 0.9 ? "#E31A1C" :
         v > 0.6 ? "#FC4E2A" :
         v > 0.4 ? "#FD8D3C" :
         v > 0.2 ? "#FEB24C" :
         v > 0.1 ? "#FED976" : "#FFEDA0";
}
function deltaColor(d){
  return d > 0.25 ? "#99000d" :
         d > 0.15 ? "#cb181d" :
         d > 0.08 ? "#ef3b2c" :
         d > 0.03 ? "#fb6a4a" :
         d > 0    ? "#fcae91" :
         d > -0.03 ? "#c6dbef" :
         d > -0.08 ? "#9ecae1" :
         d > -0.15 ? "#6baed6" :
         d > -0.25 ? "#3182bd" : "#08519c";
}

// ----- rectangle polygon from center (km grid) -----
function rectFromCenter(lat, lon, gridKm = GRID_KM){
  const dLat = gridKm / 110.574;
  const dLon = gridKm / (111.32 * Math.cos((lat * Math.PI)/180));
  const sw = [lat - dLat/2, lon - dLon/2];
  const ne = [lat + dLat/2, lon + dLon/2];
  return [
    [sw[0], sw[1]],
    [sw[0], ne[1]],
    [ne[0], ne[1]],
    [ne[0], sw[1]],
    [sw[0], sw[1]],
  ];
}

// ----- CSV loader (robust delimiter) -----
async function loadCsvRows(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`Fetch CSV failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  const parseWith = (opt={}) => Papa.parse(text, {header:true, dynamicTyping:true, skipEmptyLines:true, ...opt});
  let p = parseWith();
  if(!p.data?.length || Object.keys(p.data[0]||{}).length <= 1) p = parseWith({delimiter:";"});
  return p.data.map(r=>{
    const lat = r.lat_c ?? r.lat, lon = r.lon_c ?? r.lon, v = Number(r.value);
    const latn = Number(lat), lonn = Number(lon);
    let cid = r.cell_id ?? r.id ?? r.cell;
    if(!cid && Number.isFinite(latn) && Number.isFinite(lonn)) cid = `${latn.toFixed(3)}_${lonn.toFixed(3)}`;
    return {
      date: String(r.date ?? "").slice(0,10),
      cell_id: cid,
      value: Number.isFinite(v) ? v : NaN,
      lat_c: Number.isFinite(latn) ? latn : NaN,
      lon_c: Number.isFinite(lonn) ? lonn : NaN,
    };
  }).filter(r=>r.date && r.cell_id && Number.isFinite(r.value) && Number.isFinite(r.lat_c) && Number.isFinite(r.lon_c));
}

export default function ThailandGridMap(){
  const mapRef = useRef(null);

  // overlay refs
  const lyrNowRef  = useRef(null);
  const lyrPastRef = useRef(null);
  const lyrFwdRef  = useRef(null);
  const lyrDeltaRef= useRef(null);

  const [rows, setRows] = useState([]);
  const [dates, setDates] = useState([]);
  const [dateIdx, setDateIdx] = useState(0);

  // small player
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(2);

  const [loading, setLoading] = useState(true);
  const [csvErr, setCsvErr] = useState(null);

  // group by date
  const byDate = useMemo(()=>{
    const m = new Map();
    for(const r of rows){
      if(!m.has(r.date)) m.set(r.date, []);
      m.get(r.date).push(r);
    }
    return m;
  }, [rows]);

  // load CSV
  useEffect(()=>{
    (async()=>{
      try{
        setLoading(true);
        const data = await loadCsvRows(CSV_URL);
        const uniq = Array.from(new Set(data.map(d=>d.date))).sort();
        setRows(data); setDates(uniq);
        const today = new Date().toISOString().slice(0,10);
        setDateIdx(Math.max(0, uniq.indexOf(today)));
      }catch(e){ setCsvErr(String(e)); }
      finally{ setLoading(false); }
    })();
  },[]);

  // init map + base/overlay controls
  useEffect(()=>{
    if(mapRef.current) return;

    const m = L.map("map", { center:[15.5,101.0], zoom:6, preferCanvas:true });

    // base maps
    const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {maxZoom:18, attribution:"© OpenStreetMap"}).addTo(m);
    const terrain = L.tileLayer("https://stamen-tiles.a.ssl.fastly.net/terrain/{z}/{x}/{y}.jpg", {maxZoom:18, attribution:"Stamen Terrain"});
    const toner = L.tileLayer("https://stamen-tiles.a.ssl.fastly.net/toner/{z}/{x}/{y}.png", {maxZoom:18, attribution:"Stamen Toner"});

    // overlay layers (empty for now)
    const mkGeo = () => L.geoJSON([], {
      renderer: L.canvas({padding:0.5}),
      style: ft => ft.properties._style || {},
      onEachFeature: (ft, layer)=>{
        const p = ft.properties;
        layer.bindPopup(
          `<b>Cell:</b> ${p.cell_id}<br>`+
          `<b>Date:</b> ${p.date}<br>`+
          `<b>Lat,Lon:</b> ${p.lat_c?.toFixed(4)}, ${p.lon_c?.toFixed(4)}<br>`+
          `<b>Value:</b> ${p.value}<br>`+
          `<b>Δ vs prev:</b> ${Number(p.delta ?? 0).toFixed(4)}`
        );
      }
    });

    lyrNowRef.current   = mkGeo().addTo(m);   // current on by default
    lyrPastRef.current  = mkGeo();
    lyrFwdRef.current   = mkGeo();
    lyrDeltaRef.current = mkGeo();

    // layers control — move to TOP RIGHT and keep expanded
    L.control.layers(
      { "OpenStreetMap": osm, "Terrain": terrain, "Toner": toner },
      {
        "Malaria — Current":  lyrNowRef.current,
        "Malaria — Past":     lyrPastRef.current,
        "Malaria — Forecast": lyrFwdRef.current,
        "Change (Δ)":         lyrDeltaRef.current,
      },
      { collapsed:false, position:"topright" }
    ).addTo(m);

    mapRef.current = m;
  },[]);

  // helpers: build FeatureCollection + style
  function buildGeoJSON(list, paint){
    const feats = list.map(r=>{
      const coords = rectFromCenter(r.lat_c, r.lon_c, GRID_KM);
      const style = paint(r);
      return {
        type:"Feature",
        properties:{...r, _style: style},
        geometry:{ type:"Polygon", coordinates:[coords.map(([la,lo])=>[lo,la])] }
      };
    });
    return { type:"FeatureCollection", features:feats };
  }

  // refresh layers when date changes / data loaded
  useEffect(()=>{
    if(!mapRef.current || dates.length===0) return;

    const sel = dates[Math.min(Math.max(dateIdx,0), dates.length-1)];
    const curr = byDate.get(sel) || [];

    // Current
    if(lyrNowRef.current && mapRef.current.hasLayer(lyrNowRef.current)){
      const gj = buildGeoJSON(curr, r => ({
        weight:.5, color:"#333", opacity:1, fillColor:valueColor(r.value), fillOpacity:.65
      }));
      lyrNowRef.current.clearLayers(); lyrNowRef.current.addData(gj);
    }

    // Past (วันก่อน)
    if(dateIdx>0 && lyrPastRef.current && mapRef.current.hasLayer(lyrPastRef.current)){
      const prev = byDate.get(dates[dateIdx-1]) || [];
      const gj = buildGeoJSON(prev, r => ({
        weight:.5, color:"#333", opacity:1, fillColor:valueColor(r.value), fillOpacity:.4
      }));
      lyrPastRef.current.clearLayers(); lyrPastRef.current.addData(gj);
    } else if(lyrPastRef.current) { lyrPastRef.current.clearLayers(); }

    // Forecast (วันถัดไป)
    if(dateIdx < dates.length-1 && lyrFwdRef.current && mapRef.current.hasLayer(lyrFwdRef.current)){
      const fwd = byDate.get(dates[dateIdx+1]) || [];
      const gj = buildGeoJSON(fwd, r => ({
        weight:.5, color:"#333", opacity:1, fillColor:valueColor(r.value), fillOpacity:.4
      }));
      lyrFwdRef.current.clearLayers(); lyrFwdRef.current.addData(gj);
    } else if(lyrFwdRef.current) { lyrFwdRef.current.clearLayers(); }

    // Delta (เทียบวันก่อน)
    if(dateIdx>0 && lyrDeltaRef.current && mapRef.current.hasLayer(lyrDeltaRef.current)){
      const prev = byDate.get(dates[dateIdx-1]) || [];
      const prevMap = new Map(prev.map(r=>[r.cell_id, r.value]));
      const withDelta = curr.map(r => ({...r, delta: r.value - (prevMap.get(r.cell_id) ?? 0)}));
      const gj = buildGeoJSON(withDelta, r => ({
        weight:.5, color:"#333", opacity:1, fillColor:deltaColor(r.delta ?? 0), fillOpacity:.65
      }));
      lyrDeltaRef.current.clearLayers(); lyrDeltaRef.current.addData(gj);
    } else if(lyrDeltaRef.current) { lyrDeltaRef.current.clearLayers(); }

    // fit bounds by visible layer
    const visible = [lyrNowRef.current, lyrDeltaRef.current, lyrPastRef.current, lyrFwdRef.current]
      .filter(l => l && mapRef.current.hasLayer(l));
    if(visible.length){
      const b = visible[0].getBounds?.();
      if(b && b.isValid()) mapRef.current.fitBounds(b.pad(0.05));
    }
  }, [dateIdx, dates, byDate]);

  // autoplay
  useEffect(()=>{
    if(!playing || dates.length<=1) return;
    const iv = Math.max(50, 1000/ fps);
    const id = setInterval(()=> setDateIdx(i => (i+1)%dates.length), iv);
    return ()=> clearInterval(id);
  }, [playing, fps, dates.length]);

  const selDate = dates.length ? dates[Math.min(Math.max(dateIdx,0), dates.length-1)] : "-";

  return (
    <>
      <div id="map" />
      <div className="ui-card">
        <div className="ui-title">มาลาเรีย — แผนที่แนวโน้มแบบกริด (ประเทศไทย)</div>
        <div className="ui-subtle">ไฟล์: <code className="mono">{CSV_URL.replace(import.meta.env.BASE_URL,"/")}</code></div>

        <div className="ui-row">
          <label>วันที่</label>
          <div className="badge">{selDate}</div>
          <div className="spacer" />
          <label className="muted">Speed</label>
          <input type="range" min={1} max={8} value={fps} onChange={e=>setFps(+e.target.value)} />
          <button className="btn" onClick={()=>setPlaying(p=>!p)} title={playing ? "หยุด" : "เล่น"}>
            {playing ? "⏸" : "▶"}
          </button>
          <button className="btn" onClick={()=>setDateIdx(i=>Math.max(0,i-1))} title="วันก่อนหน้า">◀</button>
          <button className="btn" onClick={()=>setDateIdx(i=>Math.min(dates.length-1,i+1))} title="วันถัดไป">▶</button>
        </div>

        <div className="ui-row">
          <input
            className="slider-wide"
            type="range"
            min={0}
            max={Math.max(0, dates.length-1)}
            value={dateIdx}
            onChange={e=>setDateIdx(Number(e.target.value))}
          />
        </div>

        {loading && <div className="ui-note">กำลังโหลด CSV…</div>}
        {csvErr && <div className="ui-error">CSV error: {csvErr}</div>}

        <div className="legend">
          <div className="legend-title">Legend (Incidence & Δ)</div>
          <div className="legend-sub">Incidence</div>
          {[ ["> 1.8","#800026"],["1.2–1.8","#BD0026"],["0.9–1.2","#E31A1C"],
             ["0.6–0.9","#FC4E2A"],["0.4–0.6","#FD8D3C"],["0.2–0.4","#FEB24C"],
             ["0.1–0.2","#FED976"],["≤ 0.1","#FFEDA0"] ].map(([lab,col])=>(
            <div className="legend-row" key={`v-${lab}`}><span className="box" style={{background:col}} />{lab}</div>
          ))}
          <div className="legend-sub" style={{marginTop:6}}>Δ change vs previous day</div>
          {[
            ["> 0.25", "#99000d"], ["0.15–0.25", "#cb181d"], ["0.08–0.15", "#ef3b2c"],
            ["0.03–0.08", "#fb6a4a"], ["0–0.03", "#fcae91"], ["-0.03–0", "#c6dbef"],
            ["-0.08–-0.03", "#9ecae1"], ["-0.15–-0.08", "#6baed6"],
            ["-0.25–-0.15", "#3182bd"], ["< -0.25", "#08519c"],
          ].map(([lab,col])=>(
            <div className="legend-row" key={`d-${lab}`}><span className="box" style={{background:col}} />{lab}</div>
          ))}
        </div>
      </div>
    </>
  );
}
