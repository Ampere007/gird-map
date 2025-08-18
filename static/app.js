// ==== fetch JSON helper ====
async function j(path){
  const r = await fetch(path);
  if(!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return await r.json();
}
const q = (u, p={})=>{
  const url = new URL(u, location.origin);
  Object.entries(p).forEach(([k,v])=> url.searchParams.set(k, v));
  return url.toString();
};

// ==== color scales ====
function valueColor(v){
  return v>1.8?'#800026':v>1.2?'#BD0026':v>0.9?'#E31A1C':v>0.6?'#FC4E2A':
         v>0.4?'#FD8D3C':v>0.2?'#FEB24C':v>0.1?'#FED976':'#FFEDA0';
}
function deltaColor(d){
  return d>0.25?'#99000d':d>0.15?'#cb181d':d>0.08?'#ef3b2c':d>0.03?'#fb6a4a':
         d>0   ?'#fcae91':d>-0.03?'#c6dbef':d>-0.08?'#9ecae1':d>-0.15?'#6baed6':
         d>-0.25?'#3182bd':'#08519c';
}

// ==== style: ใช้ Canvas + แสดงเฉพาะเซลล์ที่มีค่า (>0) ====
function styleFor(type){
  return (ft)=>{
    const v = ft.properties.value;
    const hasData = (v !== null && !isNaN(v) && v > 0);
    return {
      renderer: L.canvas({padding:0.5}),
      weight: hasData ? 0.5 : 0,
      color: hasData ? '#333' : 'transparent',
      opacity: hasData ? 1 : 0,
      fillColor: type==='delta' ? deltaColor(v) : valueColor(v),
      fillOpacity: hasData ? 0.65 : 0
    };
  };
}

function onEach(ft, layer){
  const p=ft.properties;
  if (p && p.value>0){
    layer.bindPopup(
      `<b>Grid:</b> ${p.cell_id}<br>` +
      `<b>Date:</b> ${p.time}<br>` +
      `<b>Lat,Lon:</b> ${p.center_lat}, ${p.center_lon}<br>` +
      `<b>Value:</b> ${p.value}`
    );
  }
}

// ==== helper: TimeDimension layer ====
function tdFromGeoJSON(gj, type){
  const g = L.geoJson(gj, {renderer:L.canvas({padding:.5}), style:styleFor(type), onEachFeature:onEach});
  return L.timeDimension.layer.geoJson(g, {
    updateTimeDimension:true,
    updateTimeDimensionMode:'replace',
    duration:'P1D'
  });
}
// สร้าง layer ว่าง (ไว้เป็น placeholder สำหรับ lazy load)
function emptyTD(type){
  return tdFromGeoJSON({type:"FeatureCollection", features:[]}, type);
}

// ==== downsample ตามระดับซูม ====
function strideForZoom(z){ return z <= 6 ? 4 : z <= 7 ? 2 : 1; }
function minForZoom(z){ return z <= 6 ? 0.02 : 0.0; } // ตัดจุดค่าน้อยมากตอนซูมไกล

(async function(){
  // ---- meta ----
  const meta = await j('/api/meta');
  const dates = meta.dates || [];
  const latMin = meta.lat_min, latMax = meta.lat_max;
  const lonMin = meta.lon_min, lonMax = meta.lon_max;

  const looksLikeThailand = (latMin <= 6 && latMax >= 20 && lonMin <= 97.4 && lonMax >= 105.8);
  const regionName = looksLikeThailand ? "ประเทศไทย" : "พื้นที่ศึกษา";
  const cLat = (latMin + latMax)/2, cLon = (lonMin + lonMax)/2;

  // ---- map init (ใช้ Canvas + TimeDimension) ----
  const map = L.map('map', {
    preferCanvas: true,
    center:[cLat, cLon],
    zoom: looksLikeThailand ? 6 : 8,
    zoomSnap:.25,
    timeDimension:true,
    timeDimensionOptions:{
      timeInterval: (dates.length ? (dates[0] + "/" + dates[dates.length-1]) : undefined),
      period:"P1D"
    },
    timeDimensionControl:true,
    timeDimensionControlOptions:{
      autoPlay:false, loopButton:true, timeSliderDragUpdate:true,
      playerOptions:{ transitionTime:200, loop:true, startOver:true }
    }
  });

  // ---- Base maps ----
  const baseOSM = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
                  {maxZoom:18, attribution:'© OpenStreetMap'}).addTo(map);
  const terrain = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/terrain/{z}/{x}/{y}.jpg',
                  {maxZoom:18, attribution:'Stamen Terrain'});
  const toner   = L.tileLayer('https://stamen-tiles.a.ssl.fastly.net/toner/{z}/{x}/{y}.png',
                  {maxZoom:18, attribution:'Stamen Toner'});

  // ---- Title ----
  const title = L.control({position:'topleft'});
  title.onAdd = () => {
    const d = L.DomUtil.create('div','titlebar');
    d.innerHTML = `มาลาเรีย — แผนที่แนวโน้มแบบกริด (${regionName})`;
    return d;
  };
  title.addTo(map);

  // ---- Info ----
  const info = L.control({position:'topright'});
  info.onAdd = () => {
    const d = L.DomUtil.create('div','info');
    const src = meta.data_note || "";
    const f   = meta.csv_file ? ` <span class="file">(${meta.csv_file.split('/').pop()})</span>` : "";
    d.innerHTML = `<b>ฟิลเตอร์ชั้นข้อมูล</b> (ใช้กล่อง Layers)
                   <div class='gridnote'>ขนาดกริด: ${meta.grid_km}×${meta.grid_km} กม. | แหล่งข้อมูล: ${src}${f}</div>`;
    return d;
  };
  info.addTo(map);

  // ---- Base layer control ----
  const baseCtl = L.control.layers(
    {"OpenStreetMap": baseOSM, "Terrain": terrain, "Toner": toner},
    null, {collapsed:false, position:'topleft'}
  ).addTo(map);
  baseCtl.getContainer().classList.add('ctl-basemap');

  let overlayCtl = null;
  const titleEl = title.getContainer();
  const infoEl  = info.getContainer();
  const baseEl  = baseCtl.getContainer();

  function repositionControls(){
    if (titleEl && baseEl) baseEl.style.marginTop = (titleEl.offsetHeight + 10) + "px";
    if (overlayCtl && infoEl) {
      const overlayEl = overlayCtl.getContainer();
      if (overlayEl) overlayEl.style.marginTop = (infoEl.offsetHeight + 10) + "px";
    }
  }
  window.addEventListener('resize', ()=> requestAnimationFrame(repositionControls));

  // ---- Legends ----
  const lgVal=L.control({position:'bottomright'});
  lgVal.onAdd=()=>{
    const div=L.DomUtil.create('div','legend');
    const s=[['#800026','> 1.8'],['#BD0026','1.2–1.8'],['#E31A1C','0.9–1.2'],
             ['#FC4E2A','0.6–0.9'],['#FD8D3C','0.4–0.6'],['#FEB24C','0.2–0.4'],
             ['#FED976','0.1–0.2'],['#FFEDA0','≤ 0.1']];
    let h="<div><b>Incidence (cases / 1,000 / day)</b></div>";
    for (let i=0;i<s.length;i++) h+=`<div class='row'><span class='box' style='background:${s[i][0]}'></span>${s[i][1]}</div>`;
    div.innerHTML=h; return div;
  };
  lgVal.addTo(map);

  const lgDelta=L.control({position:'bottomleft'});
  lgDelta.onAdd=()=>{
    const div=L.DomUtil.create('div','legend');
    const s=[['#99000d','> 0.25'],['#cb181d','0.15–0.25'],['#ef3b2c','0.08–0.15'],
             ['#fb6a4a','0.03–0.08'],['#fcae91','0–0.03'],['#c6dbef','-0.03–0'],
             ['#9ecae1','-0.08–-0.03'],['#6baed6','-0.15–-0.08'],
             ['#3182bd','-0.25–-0.15'],['#08519c','< -0.25']];
    let h="<div><b>Δ Change vs previous day</b></div>";
    for (let i=0;i<s.length;i++) h+=`<div class='row'><span class='box' style='background:${s[i][0]}'></span>${s[i][1]}</div>`;
    div.innerHTML=h; return div;
  };
  lgDelta.addTo(map);

  // ===== Lazy-load + downsample =====
  let nowLayer = null, pastLayer = emptyTD('value'), fwdLayer = emptyTD('value'), deltLayer = emptyTD('delta');
  let pastLoaded=false, fwdLoaded=false, deltLoaded=false;

  function makeTD(gj, type){ return tdFromGeoJSON(gj, type); }

  async function loadNowForZoom(){
    const z = map.getZoom();
    const params = { stride: strideForZoom(z), min: minForZoom(z) };
    try{
      const gj = await j(q('/api/geo/now', params));
      const newLayer = makeTD(gj,'value');
      if (nowLayer) map.removeLayer(nowLayer);
      nowLayer = newLayer.addTo(map);
    }catch(e){
      const gj = await j('/api/geo/now');
      const newLayer = makeTD(gj,'value');
      if (nowLayer) map.removeLayer(nowLayer);
      nowLayer = newLayer.addTo(map);
    }
  }

  // เริ่มต้น: โหลด "Current" เท่านั้น
  await loadNowForZoom();

  // สร้าง overlay control
  overlayCtl = L.control.layers(
    null,
    {"Malaria — Current": nowLayer, "Malaria — Past": pastLayer, "Malaria — Forecast": fwdLayer, "Change (Δ)": deltLayer},
    {collapsed:false, position:'topright'}
  ).addTo(map);
  overlayCtl.getContainer().classList.add('ctl-overlay');

  // Lazy load layers
  map.on('overlayadd', async (e)=>{
    const z = map.getZoom();
    const params = { stride: strideForZoom(z), min: minForZoom(z) };

    if (e.layer === pastLayer && !pastLoaded){
      const gj = await j(q('/api/geo/past', params)).catch(()=> j('/api/geo/past'));
      pastLayer._baseLayer.clearLayers();
      pastLayer._baseLayer.addData(gj);
      pastLoaded = true;
    }
    if (e.layer === fwdLayer && !fwdLoaded){
      const gj = await j(q('/api/geo/forecast', params)).catch(()=> j('/api/geo/forecast'));
      fwdLayer._baseLayer.clearLayers();
      fwdLayer._baseLayer.addData(gj);
      fwdLoaded = true;
    }
    if (e.layer === deltLayer && !deltLoaded){
      const gj = await j(q('/api/geo/delta', params)).catch(()=> j('/api/geo/delta'));
      deltLayer._baseLayer.clearLayers();
      deltLayer._baseLayer.addData(gj);
      deltLoaded = true;
    }
  });

  // Refresh current layer on zoom
  let refreshToken = 0;
  map.on('zoomend', async ()=>{
    const my = ++refreshToken;
    await loadNowForZoom();
    if (my !== refreshToken) return;
  });

  // Fit to bounds
  requestAnimationFrame(repositionControls);
  setTimeout(repositionControls, 50);
  setTimeout(repositionControls, 300);
  map.fitBounds([[latMin, lonMin],[latMax, lonMax]]);
})();
