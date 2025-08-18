// server/index.mjs
import express from 'express';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { parse as csvParse } from 'csv-parse';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ---- config (env) ----
const LAT_MIN = parseFloat(process.env.LAT_MIN ?? 5.6);
const LAT_MAX = parseFloat(process.env.LAT_MAX ?? 20.7);
const LON_MIN = parseFloat(process.env.LON_MIN ?? 97.0);
const LON_MAX = parseFloat(process.env.LON_MAX ?? 105.9);
const GRID_KM = parseFloat(process.env.GRID_KM ?? 10.0);
const PORT    = parseInt(process.env.PORT ?? '8000', 10);
const COORD_DEC = parseInt(process.env.COORD_DEC ?? '4', 10);

// ---- grid ----
const MID_LAT = (LAT_MIN + LAT_MAX)/2;
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON = 111.320 * Math.cos((Math.PI/180)*MID_LAT);
const DLAT = GRID_KM / KM_PER_DEG_LAT;
const DLON = GRID_KM / KM_PER_DEG_LON;

function buildGrid(){
  const cells = [];
  let row = 0;
  for(let lat=LAT_MIN; lat<LAT_MAX-1e-12; lat+=DLAT){
    let col = 0;
    for(let lon=LON_MIN; lon<LON_MAX-1e-12; lon+=DLON){
      const lat_max = Math.min(lat + DLAT, LAT_MAX);
      const lon_max = Math.min(lon + DLON, LON_MAX);
      cells.push({
        id:`r${row}c${col}`, row, col,
        lat_min:lat, lat_max, lon_min:lon, lon_max,
        lat_c:(lat+lat_max)/2, lon_c:(lon+lon_max)/2
      });
      col++;
    }
    row++;
  }
  return {cells, nrows: row};
}
const {cells: CELLS, nrows: NROWS} = buildGrid();

// ---- CSV utils ----
const DEFAULTS = [
  'server/data/thailand_10km_cells.csv',
  'server/data/malaria_th_daily_cells.csv',
  'server/data/malaria_th_daily.csv',
  'thailand_10km_cells.csv',
  'malaria_th_daily_cells.csv',
  'malaria_th_daily.csv',
];
function guessCsv(){
  if (process.env.CSV_FILE) return process.env.CSV_FILE;
  for (const p of DEFAULTS){
    const abs = path.resolve(ROOT, p);
    if (fs.existsSync(abs)) return abs;
    if (fs.existsSync(abs + '.gz')) return abs + '.gz';
  }
  return null;
}
function openMaybeGzip(p){
  const s = fs.createReadStream(p);
  return p.endsWith('.gz') ? s.pipe(zlib.createGunzip()) : s;
}
function binPointToCell(lat, lon){
  if (!(LAT_MIN <= lat && lat <= LAT_MAX && LON_MIN <= lon && lon <= LON_MAX)) return null;
  let r = Math.floor((lat - LAT_MIN)/DLAT); r = Math.max(0, Math.min(NROWS-1, r));
  let c = Math.floor((lon - LON_MIN)/DLON);
  return `r${r}c${c}`;
}

// ---- load CSV (async) ----
async function loadCsv(csvPath){
  if (!csvPath) {
    return { gridMap: null, datesISO: [], dataNote: 'synthetic (no CSV found)', csvPath: null };
  }
  const gridMap = new Map(CELLS.map(c=>[c.id, new Map()]));
  const dateSet = new Set();
  let schema = null; // 'cell' | 'point'

  await new Promise((resolve, reject)=>{
    openMaybeGzip(csvPath)
      .pipe(csvParse({columns:true, trim:true}))
      .on('data', (row)=>{
        if (!schema){
          const headers = Object.keys(row).map(h=>h.toLowerCase());
          const has = h => headers.includes(h);
          if (has('cell_id') && has('value')) schema = 'cell';
          else if ((has('lat')||has('lat_c')) && (has('lon')||has('lon_c')) && has('value')) schema = 'point';
          else schema = 'unknown';
        }
        if (schema==='unknown') return;

        const d = (row.date || '').trim(); if (!d) return;
        dateSet.add(d);
        const v = Number(row.value); if (!Number.isFinite(v)) return;

        if (schema==='cell'){
          const cid = (row.cell_id || '').trim();
          if (gridMap.has(cid)) gridMap.get(cid).set(d, v);
        } else {
          const lat = Number(row.lat ?? row.lat_c);
          const lon = Number(row.lon ?? row.lon_c);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
          const cid = binPointToCell(lat, lon); if (!cid) return;
          const per = gridMap.get(cid);
          per.set(d, per.has(d) ? (per.get(d)+v)/2 : v);
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  const datesISO = Array.from(dateSet).sort();
  return { gridMap, datesISO, dataNote:`loaded: ${path.basename(csvPath)}`, csvPath };
}

function cellPolygon(c){
  const r = COORD_DEC;
  return [
    [Number(c.lon_min.toFixed(r)), Number(c.lat_min.toFixed(r))],
    [Number(c.lon_max.toFixed(r)), Number(c.lat_min.toFixed(r))],
    [Number(c.lon_max.toFixed(r)), Number(c.lat_max.toFixed(r))],
    [Number(c.lon_min.toFixed(r)), Number(c.lat_max.toFixed(r))],
    [Number(c.lon_min.toFixed(r)), Number(c.lat_min.toFixed(r))],
  ];
}
function buildFeatures(DATES_ISO, GRID_MAP, idx, metric='value', stride=1, minValue=null){
  const feats = [];
  for (const ti of idx){
    const d_iso = DATES_ISO[ti];
    for (const c of CELLS){
      if (stride>1 && ((c.row%stride)!==0 || (c.col%stride)!==0)) continue;
      const per = GRID_MAP.get(c.id);
      const v0 = Number(per.get(d_iso) ?? 0);
      const vPrev = ti>0 ? Number(per.get(DATES_ISO[ti-1]) ?? 0) : 0;
      const val = metric==='delta' ? (v0 - vPrev) : v0;
      if (minValue!=null && metric==='value' && !(val>minValue)) continue;
      feats.push({
        type:'Feature',
        geometry:{type:'Polygon', coordinates:[cellPolygon(c)]},
        properties:{
          time:d_iso, cell_id:c.id, row:c.row, col:c.col,
          center_lat:Number(c.lat_c.toFixed(COORD_DEC)),
          center_lon:Number(c.lon_c.toFixed(COORD_DEC)),
          value:Number(val.toFixed(4))
        }
      });
    }
  }
  return {type:'FeatureCollection', features:feats};
}

// ---- main: load + serve ----
async function main(){
  const CSV_FILE = guessCsv();
  console.log('[BOOT] CSV_FILE =', CSV_FILE ?? '(none)');
  const { gridMap: GRID_MAP, datesISO: DATES_ISO, dataNote: DATA_NOTE } = await loadCsv(CSV_FILE);

  const toD = s => { const t = new Date(s); t.setHours(0,0,0,0); return t; };
  const TODAY_ISO = new Date().toISOString().slice(0,10);
  const PAST_IDX = DATES_ISO.map((d,i)=>({d,i})).filter(x=> toD(x.d) <  toD(TODAY_ISO)).map(x=>x.i);
  const NOW_IDX  = DATES_ISO.map((d,i)=>({d,i})).filter(x=> toD(x.d).getTime() === toD(TODAY_ISO).getTime()).map(x=>x.i);
  const FWD_IDX  = DATES_ISO.map((d,i)=>({d,i})).filter(x=> toD(x.d) >  toD(TODAY_ISO)).map(x=>x.i);

  const app = express();
  app.use(compression());

  app.get('/api/meta', (req,res)=>{
    res.json({
      grid_km: GRID_KM,
      lat_min: LAT_MIN, lat_max: LAT_MAX,
      lon_min: LON_MIN, lon_max: LON_MAX,
      dates: DATES_ISO,
      data_note: DATA_NOTE,
      csv_file: CSV_FILE
    });
  });

  app.get('/api/geo/:kind', (req,res)=>{
    const kind = req.params.kind; // past | now | forecast | delta
    const stride = Math.max(1, parseInt(req.query.stride ?? '1', 10));
    const min = req.query.min != null ? Number(req.query.min) : null;

    let idx = [];
    if (kind==='past') idx = PAST_IDX;
    else if (kind==='now') idx = NOW_IDX;
    else if (kind==='forecast') idx = FWD_IDX;
    else if (kind==='delta') idx = DATES_ISO.map((_,i)=>i);
    else return res.status(400).json({error:'bad kind'});

    const fc = buildFeatures(DATES_ISO, GRID_MAP, idx, kind==='delta'?'delta':'value', stride, min);
    res.json(fc);
  });

  // serve built React ifมี dist/
  const DIST = path.join(ROOT, 'dist');
  if (fs.existsSync(DIST)){
    app.use(express.static(DIST));
    app.get('*', (_,res)=> res.sendFile(path.join(DIST,'index.html')));
  }

  app.listen(PORT, ()=>{
    console.log(`[SERVE] http://localhost:${PORT}  grid=${GRID_KM}km  dates=${DATES_ISO[0]||'-'}→${DATES_ISO.at(-1)||'-'}`);
  });
}

main().catch(err=>{
  console.error('[FATAL]', err);
  process.exit(1);
});
