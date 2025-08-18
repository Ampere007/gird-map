import React, { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// ----- helpers -----
async function getJSON(path){ const r = await fetch(path); if(!r.ok) throw new Error(`${r.status}`); return r.json(); }
function withQuery(u, p={}){ const url = new URL(u, location.origin); Object.entries(p).forEach(([k,v])=>url.searchParams.set(k,v)); return url.toString(); }
const valueColor = v => v>1.8?'#800026':v>1.2?'#BD0026':v>0.9?'#E31A1C':v>0.6?'#FC4E2A':v>0.4?'#FD8D3C':v>0.2?'#FEB24C':v>0.1?'#FED976':'#FFEDA0';
const deltaColor = d => d>0.25?'#99000d':d>0.15?'#cb181d':d>0.08?'#ef3b2c':d>0.03?'#fb6a4a':d>0?'#fcae91':d>-0.03?'#c6dbef':d>-0.08?'#9ecae1':d>-0.15?'#6baed6':d>-0.25?'#3182bd':'#08519c';
const styleFor = kind => ft => {
  const v = ft.properties?.value; const has = v!=null && !Number.isNaN(v) && v>0;
  return { renderer:L.canvas({padding:.5}), weight:has?0.5:0, color:has?'#333':'transparent', opacity:has?1:0,
           fillColor: kind==='delta'?deltaColor(v):valueColor(v), fillOpacity:has?0.65:0 };
};
function onEach(ft, layer){
  const p=ft.properties; if(p&&p.value>0){ layer.bindPopup(`<b>Grid:</b> ${p.cell_id}<br><b>Date:</b> ${p.time}<br><b>Lat,Lon:</b> ${p.center_lat}, ${p.center_lon}<br><b>Value:</b> ${p.value}`); }
}
const strideForZoom = z => z<=6?4: z<=7?2:1;
const minForZoom    = z => z<=6?0.02:0.0;

export default function App(){
  const mapRef = useRef(null);
  const nowLayerRef  = useRef(L.geoJSON([], {style:styleFor('value'), onEachFeature:onEach}));
  const pastLayerRef = useRef(L.geoJSON([], {style:styleFor('value'), onEachFeature:onEach}));
  const fwdLayerRef  = useRef(L.geoJSON([], {style:styleFor('value'), onEachFeature:onEach}));
  const deltLayerRef = useRef(L.geoJSON([], {style:styleFor('delta'), onEachFeature:onEach}));
  const [meta,setMeta] = useState(null);
  const [loaded,setLoaded] = useState({past:false,fwd:false,delt:false});
  const [minCut,setMinCut] = useState(0.05);

  // CSS เล็กน้อย
  useEffect(()=>{ const s=document.createElement('style');
    s.textContent=`html,body,#root{height:100%;margin:0} #map{height:100vh}
    .hud{position:absolute;z-index:1000;left:12px;top:12px;background:#fff;padding:10px 12px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.15);font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    .hud h1{font-size:16px;margin:0 0 6px} .badge{background:#f3f4f6;border-radius:8px;padding:2px 8px;margin-left:8px}`;
    document.head.appendChild(s); return ()=>s.remove();
  },[]);

  useEffect(()=>{ (async()=>{
    const m = await getJSON('/api/meta'); setMeta(m);
    const center=[(m.lat_min+m.lat_max)/2,(m.lon_min+m.lon_max)/2];
    const looksTH = m.lat_min<=6 && m.lat_max>=20 && m.lon_min<=97.4 && m.lon_max>=105.8;

    const map = L.map('map',{preferCanvas:true,center,zoom:looksTH?6:8,zoomSnap:.25}); mapRef.current=map;
    const baseOSM=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:12,attribution:'© OpenStreetMap'}).addTo(map);
    const terrain=L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/terrain/{z}/{x}/{y}.jpg',{maxZoom:12,attribution:'Stamen Terrain'});
    const toner=L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/toner/{z}/{x}/{y}.png',{maxZoom:12,attribution:'Stamen Toner'});
    L.control.layers({OpenStreetMap:baseOSM,Terrain:terrain,Toner:toner}, null, {collapsed:false,position:'topleft'}).addTo(map);

    // overlay placeholders
    const overlays = {
      "Malaria — Current":  nowLayerRef.current,
      "Malaria — Past":     pastLayerRef.current,
      "Malaria — Forecast": fwdLayerRef.current,
      "Change (Δ)":         deltLayerRef.current
    };
    L.control.layers(null, overlays, {collapsed:false, position:'topright'}).addTo(map);
    nowLayerRef.current.addTo(map);

    async function loadCurrentForZoom(){
      const z=map.getZoom(); const params={stride:strideForZoom(z), min:minForZoom(z)};
      let gj = await getJSON(withQuery('/api/geo/now', params)).catch(()=>({type:"FeatureCollection",features:[]}));
      if(!gj.features || gj.features.length===0){ gj = await getJSON(withQuery('/api/geo/past', params)); }
      nowLayerRef.current.clearLayers(); nowLayerRef.current.addData(gj);
    }
    await loadCurrentForZoom();

    map.on('overlayadd', async (e)=>{
      const p={stride:strideForZoom(map.getZoom()), min:minCut};
      if(e.layer===pastLayerRef.current && !loaded.past){
        const gj=await getJSON(withQuery('/api/geo/past',p)).catch(()=>getJSON('/api/geo/past'));
        pastLayerRef.current.clearLayers(); pastLayerRef.current.addData(gj); setLoaded(s=>({...s,past:true}));
      }
      if(e.layer===fwdLayerRef.current && !loaded.fwd){
        const gj=await getJSON(withQuery('/api/geo/forecast',p)).catch(()=>getJSON('/api/geo/forecast'));
        fwdLayerRef.current.clearLayers(); fwdLayerRef.current.addData(gj); setLoaded(s=>({...s,fwd:true}));
      }
      if(e.layer===deltLayerRef.current && !loaded.delt){
        const gj=await getJSON(withQuery('/api/geo/delta',p)).catch(()=>getJSON('/api/geo/delta'));
        deltLayerRef.current.clearLayers(); deltLayerRef.current.addData(gj); setLoaded(s=>({...s,delt:true}));
      }
    });

    let token=0;
    map.on('zoomend', async ()=>{ const my=++token; await loadCurrentForZoom(); if(my!==token) return; });
    map.fitBounds([[m.lat_min,m.lon_min],[m.lat_max,m.lon_max]]);
  })(); },[minCut,loaded.past,loaded.fwd,loaded.delt]);

  return (
    <div>
      <div id="map"></div>
      <div className="hud">
        <h1>มาลาเรีย — แผนที่แนวโน้มแบบกริด
          {meta && <span className="badge">Grid {meta.grid_km} km</span>}
        </h1>
        {meta
          ? <div>ช่วงวันที่: <b>{meta.dates[0]}</b> → <b>{meta.dates.at(-1)}</b> · แหล่งข้อมูล: <b>{meta.data_note}</b>{meta.csv_file?` (${meta.csv_file.split('/').pop()})`:''}
              <label style={{marginLeft:10}}>Min: <input type="number" step="0.01" value={minCut} onChange={e=>setMinCut(parseFloat(e.target.value||0))} style={{width:70,marginLeft:4}}/></label>
            </div>
          : <div>Loading…</div>}
      </div>
    </div>
  );
}
