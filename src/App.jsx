import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search, Plus, Trash2, Navigation, Route, Settings, Play, Square,
  ArrowRight, Save, Compass, MapPinned, RotateCcw, Download,
  ChevronUp, ChevronDown, Crosshair, Anchor,
} from "lucide-react";

const DEFAULT_ARRIVAL_RADIUS = 50;
const TRACK_MIN_DISTANCE_M = 12;
const APP_VERSION = "1.1.0";

const seedWaypoints = [
  { id: crypto.randomUUID(), name: "OLIVOS", lat: -34.5102, lon: -58.4787, note: "Puerto / referencia" },
  { id: crypto.randomUUID(), name: "BOYA 1", lat: -34.5275, lon: -58.4911, note: "Canal" },
  { id: crypto.randomUUID(), name: "SAN ISIDRO", lat: -34.4731, lon: -58.5144, note: "Rumbo norte" },
];

function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }
function normalizeBearing(b) { return (b + 360) % 360; }
function metersToNm(m) { return m / 1852; }
function knotsFromMps(mps) { return mps ? mps * 1.94384 : 0; }

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function initialBearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return normalizeBearing(toDeg(Math.atan2(y, x)));
}

function crossTrackErrorMeters(start, end, current) {
  if (!start || !end || !current) return 0;
  const d13 = haversineDistance(start.lat, start.lon, current.lat, current.lon) / 6371000;
  const theta13 = toRad(initialBearing(start.lat, start.lon, current.lat, current.lon));
  const theta12 = toRad(initialBearing(start.lat, start.lon, end.lat, end.lon));
  return Math.asin(Math.sin(d13) * Math.sin(theta13 - theta12)) * 6371000;
}

function formatLat(lat) { return `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? "N" : "S"}`; }
function formatLon(lon) { return `${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? "E" : "W"}`; }
function formatTimeHours(hours) {
  if (!isFinite(hours) || hours <= 0) return "--:--";
  const totalMin = Math.round(hours * 60);
  return `${String(Math.floor(totalMin / 60)).padStart(2, "0")}:${String(totalMin % 60).padStart(2, "0")}`;
}
function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function readLS(key, fallback) {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : fallback; } catch { return fallback; }
}

// ─── GPX Builder ──────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function buildGpx(trackPoints, trackStartedAt, waypoints, route) {
  const wptTags = waypoints.map(w =>
    `  <wpt lat="${w.lat}" lon="${w.lon}">\n    <name>${esc(w.name)}</name>\n    <desc>${esc(w.note||"")}</desc>\n  </wpt>`
  ).join("\n");

  const routeWpts = route.map(id => waypoints.find(w => w.id === id)).filter(Boolean);
  const rteTags = routeWpts.length > 0
    ? `  <rte>\n    <name>BedrossGPS Route</name>\n${routeWpts.map(w=>`    <rtept lat="${w.lat}" lon="${w.lon}"><name>${esc(w.name)}</name></rtept>`).join("\n")}\n  </rte>`
    : "";

  const trkpts = trackPoints.map(p => {
    const t = p.ts ? `\n        <time>${new Date(p.ts).toISOString()}</time>` : "";
    const spd = p.speedKts != null ? `\n        <extensions><speed>${(p.speedKts/1.94384).toFixed(3)}</speed></extensions>` : "";
    return `      <trkpt lat="${p.lat}" lon="${p.lon}">${t}${spd}\n      </trkpt>`;
  }).join("\n");

  const trkTag = trackPoints.length > 0
    ? `  <trk>\n    <name>BedrossGPS Track ${trackStartedAt ? new Date(trackStartedAt).toISOString() : new Date().toISOString()}</name>\n    <trkseg>\n${trkpts}\n    </trkseg>\n  </trk>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="BedrossGpsPWA v${APP_VERSION}"
  xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>BedrossGPS Export</name>
    <time>${new Date().toISOString()}</time>
  </metadata>
${wptTags}
${rteTags}
${trkTag}
</gpx>`.trim();
}

function downloadGpx(content, filename) {
  const blob = new Blob([content], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ─── UI Components ────────────────────────────────────────────────────────────
function BigMetric({ label, value, unit, accent }) {
  return (
    <div className={`rounded-[2rem] bg-black border-2 ${accent ? "border-cyan-400" : "border-slate-500"} shadow-2xl p-5 min-h-[220px] md:min-h-[260px] flex flex-col justify-between`}>
      <div className="text-slate-300 text-base md:text-lg tracking-[0.18em] uppercase font-black">{label}</div>
      <div className="flex items-end gap-3">
        <div className={`font-black tabular-nums leading-none ${accent ? "text-cyan-300" : "text-white"} text-8xl md:text-[10rem]`}>{value}</div>
        {unit && <div className="text-slate-200 text-2xl md:text-3xl mb-3 font-black">{unit}</div>}
      </div>
    </div>
  );
}

function SmallMetric({ label, value, unit, highlight }) {
  return (
    <div className={`rounded-[2rem] bg-black border-2 ${highlight ? "border-amber-500" : "border-slate-700"} p-4 min-h-[150px] flex flex-col justify-between`}>
      <div className="text-slate-400 text-sm tracking-[0.16em] uppercase font-black">{label}</div>
      <div className="flex items-end gap-2">
        <div className={`font-black tabular-nums leading-none ${highlight ? "text-amber-300" : "text-white"} text-6xl md:text-7xl`}>{value}</div>
        {unit && <div className="text-slate-300 text-xl mb-2 font-black">{unit}</div>}
      </div>
    </div>
  );
}

function AddWptModal({ onClose, onAdd, currentPosition }) {
  const [name, setName] = useState("");
  const [lat, setLat] = useState(currentPosition ? String(currentPosition.lat.toFixed(6)) : "");
  const [lon, setLon] = useState(currentPosition ? String(currentPosition.lon.toFixed(6)) : "");
  const [note, setNote] = useState("");

  const fillGps = () => { if (currentPosition) { setLat(currentPosition.lat.toFixed(6)); setLon(currentPosition.lon.toFixed(6)); } };

  const submit = () => {
    const latN = Number(lat), lonN = Number(lon);
    if (!name.trim() || isNaN(latN) || isNaN(lonN)) return;
    onAdd({ id: crypto.randomUUID(), name: name.trim().toUpperCase(), lat: latN, lon: lonN, note: note.trim() });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-slate-900 border-2 border-slate-600 rounded-3xl p-6 w-full max-w-md space-y-4" onClick={e => e.stopPropagation()}>
        <div className="text-xl font-black text-white">Nuevo Waypoint</div>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nombre (ej: BOYA 2)" className="w-full bg-black border border-slate-600 rounded-2xl px-4 py-3 text-white font-bold outline-none focus:border-cyan-400 uppercase" />
        <div className="flex gap-2">
          <input value={lat} onChange={e => setLat(e.target.value)} placeholder="Lat (-34.5102)" className="flex-1 bg-black border border-slate-600 rounded-2xl px-4 py-3 text-white font-bold outline-none focus:border-cyan-400" />
          <input value={lon} onChange={e => setLon(e.target.value)} placeholder="Lon (-58.4787)" className="flex-1 bg-black border border-slate-600 rounded-2xl px-4 py-3 text-white font-bold outline-none focus:border-cyan-400" />
        </div>
        {currentPosition && (
          <button onClick={fillGps} className="w-full px-4 py-3 rounded-2xl bg-cyan-700 hover:bg-cyan-600 font-black flex items-center justify-center gap-2 text-white">
            <Crosshair className="w-4 h-4" /> Usar posición GPS actual
          </button>
        )}
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Nota (opcional)" className="w-full bg-black border border-slate-600 rounded-2xl px-4 py-3 text-white font-bold outline-none focus:border-slate-400" />
        <div className="flex gap-3">
          <button onClick={submit} className="flex-1 px-4 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-black text-white">Guardar</button>
          <button onClick={onClose} className="px-4 py-3 rounded-2xl bg-slate-700 hover:bg-slate-600 font-black text-white">Cancelar</button>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("nav");
  const [waypoints, setWaypoints] = useState(() => readLS("bedross_waypoints_v2", seedWaypoints));
  const [route, setRoute] = useState(() => readLS("bedross_route_v2", []));
  const [activeRouteIndex, setActiveRouteIndex] = useState(() => readLS("bedross_route_index_v2", 0));
  const [search, setSearch] = useState("");
  const [navOn, setNavOn] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(() => readLS("bedross_auto_advance_v2", true));
  const [arrivalRadius, setArrivalRadius] = useState(() => readLS("bedross_arrival_radius_v2", DEFAULT_ARRIVAL_RADIUS));
  const [position, setPosition] = useState(null);
  const [gpsError, setGpsError] = useState("");
  const [trackRecording, setTrackRecording] = useState(() => readLS("bedross_track_recording_v2", false));
  const [trackPoints, setTrackPoints] = useState(() => readLS("bedross_track_points_v2", []));
  const [trackStartedAt, setTrackStartedAt] = useState(() => readLS("bedross_track_started_v2", null));
  const [showAddModal, setShowAddModal] = useState(false);
  const [now, setNow] = useState(Date.now());
  const watchRef = useRef(null);

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  useEffect(() => localStorage.setItem("bedross_waypoints_v2", JSON.stringify(waypoints)), [waypoints]);
  useEffect(() => localStorage.setItem("bedross_route_v2", JSON.stringify(route)), [route]);
  useEffect(() => localStorage.setItem("bedross_route_index_v2", JSON.stringify(activeRouteIndex)), [activeRouteIndex]);
  useEffect(() => localStorage.setItem("bedross_auto_advance_v2", JSON.stringify(autoAdvance)), [autoAdvance]);
  useEffect(() => localStorage.setItem("bedross_arrival_radius_v2", JSON.stringify(arrivalRadius)), [arrivalRadius]);
  useEffect(() => localStorage.setItem("bedross_track_recording_v2", JSON.stringify(trackRecording)), [trackRecording]);
  useEffect(() => localStorage.setItem("bedross_track_points_v2", JSON.stringify(trackPoints)), [trackPoints]);
  useEffect(() => localStorage.setItem("bedross_track_started_v2", JSON.stringify(trackStartedAt)), [trackStartedAt]);

  useEffect(() => {
    if (!navOn) { if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current); watchRef.current = null; return; }
    if (!navigator.geolocation) { setGpsError("Geolocalización no soportada."); return; }
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsError("");
        const p = { lat: pos.coords.latitude, lon: pos.coords.longitude, speedKts: knotsFromMps(pos.coords.speed || 0), cog: pos.coords.heading ?? 0, accuracy: pos.coords.accuracy, ts: pos.timestamp };
        setPosition(p);
        if (trackRecording) {
          setTrackPoints(prev => {
            const last = prev[prev.length - 1];
            if (!last) return [...prev, p];
            return haversineDistance(last.lat, last.lon, p.lat, p.lon) >= TRACK_MIN_DISTANCE_M ? [...prev, p] : prev;
          });
        }
      },
      (err) => setGpsError(err.message || "Error GPS"),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
    return () => { if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current); };
  }, [navOn, trackRecording]);

  const routeWaypoints = useMemo(() => route.map(id => waypoints.find(w => w.id === id)).filter(Boolean), [route, waypoints]);
  const activeWpt = routeWaypoints[activeRouteIndex] || null;
  const previousWpt = activeRouteIndex > 0 ? routeWaypoints[activeRouteIndex - 1] : null;

  const nav = useMemo(() => {
    if (!position || !activeWpt) return null;
    const distM = haversineDistance(position.lat, position.lon, activeWpt.lat, activeWpt.lon);
    const brg = initialBearing(position.lat, position.lon, activeWpt.lat, activeWpt.lon);
    const xteM = previousWpt ? crossTrackErrorMeters(previousWpt, activeWpt, position) : 0;
    const delta = Math.abs(((brg - (position.cog || 0) + 540) % 360) - 180);
    const vmg = position.speedKts * Math.cos(toRad(delta));
    const ttgH = vmg > 0 ? metersToNm(distM) / vmg : Infinity;
    return { distM, brg, xteM, vmg, ttgH };
  }, [position, activeWpt, previousWpt]);

  const trackDistanceNm = useMemo(() => {
    if (trackPoints.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < trackPoints.length; i++) total += haversineDistance(trackPoints[i-1].lat, trackPoints[i-1].lon, trackPoints[i].lat, trackPoints[i].lon);
    return metersToNm(total);
  }, [trackPoints]);

  useEffect(() => {
    if (!autoAdvance || !nav || !activeWpt) return;
    if (nav.distM <= arrivalRadius && activeRouteIndex < routeWaypoints.length - 1) setActiveRouteIndex(i => i + 1);
  }, [nav, autoAdvance, arrivalRadius, activeRouteIndex, routeWaypoints.length, activeWpt]);

  const filteredWaypoints = waypoints.filter(w =>
    [w.name, w.note, `${w.lat}`, `${w.lon}`].join(" ").toLowerCase().includes(search.toLowerCase())
  );

  const moveInRoute = (idx, dir) => {
    setRoute(prev => {
      const next = [...prev]; const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]]; return next;
    });
  };

  const startTrack = () => { setTrackRecording(true); if (!trackStartedAt) setTrackStartedAt(Date.now()); if (position && trackPoints.length === 0) setTrackPoints([position]); };
  const stopTrack = () => setTrackRecording(false);
  const clearTrack = () => { setTrackPoints([]); setTrackStartedAt(null); setTrackRecording(false); };

  const ts = () => new Date().toISOString().slice(0,16).replace("T","_").replace(":","");
  const exportTrackGpx = () => { if (trackPoints.length < 2) { alert("No hay suficientes puntos."); return; } downloadGpx(buildGpx(trackPoints, trackStartedAt, waypoints, route), `track_${ts()}.gpx`); };
  const exportWptsGpx = () => { if (!waypoints.length) { alert("No hay waypoints."); return; } downloadGpx(buildGpx([], null, waypoints, route), `waypoints_${ts()}.gpx`); };
  const exportFullGpx = () => downloadGpx(buildGpx(trackPoints, trackStartedAt, waypoints, route), `bedross_full_${ts()}.gpx`);

  const TABS = [["nav",<Compass className="w-4 h-4"/>,"Navegar"],["wpt",<Navigation className="w-4 h-4"/>,"WPT"],["route",<Route className="w-4 h-4"/>,"Ruta"],["track",<MapPinned className="w-4 h-4"/>,"Track"],["settings",<Settings className="w-4 h-4"/>,"Config"]];

  return (
    <div className="min-h-screen bg-black text-white p-3 md:p-5 select-none">
      {showAddModal && <AddWptModal onClose={() => setShowAddModal(false)} onAdd={w => setWaypoints(p => [...p, w])} currentPosition={position} />}

      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
          <div>
            <h1 className="text-2xl md:text-3xl font-black tracking-tight text-white flex items-center gap-2">
              <Anchor className="w-6 h-6 text-cyan-400" /> BedrossGpsPWA
            </h1>
            <p className="text-slate-400 text-xs font-bold tracking-widest uppercase">v{APP_VERSION} · Náutica alto contraste</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {TABS.map(([key, icon, label]) => (
              <button key={key} onClick={() => setTab(key)}
                className={`px-3 py-2 rounded-2xl border-2 font-black flex items-center gap-2 text-sm transition-colors ${tab === key ? "bg-white text-black border-white" : "bg-black border-slate-600 text-white hover:border-slate-400"}`}>
                {icon}{label}
              </button>
            ))}
          </div>
        </div>

        {/* NAV */}
        {tab === "nav" && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 items-center">
              <button onClick={() => setNavOn(true)} className="px-4 py-3 rounded-2xl bg-emerald-700 hover:bg-emerald-600 font-black flex items-center gap-2"><Play className="w-4 h-4" /> GPS ON</button>
              <button onClick={() => setNavOn(false)} className="px-4 py-3 rounded-2xl bg-rose-700 hover:bg-rose-600 font-black flex items-center gap-2"><Square className="w-4 h-4" /> GPS OFF</button>
              {navOn && <div className={`px-3 py-2 rounded-2xl text-xs font-black tracking-widest ${position ? "bg-emerald-900 text-emerald-300 border border-emerald-600" : "bg-amber-900 text-amber-300 border border-amber-600"}`}>{position ? `● GPS OK ±${Math.round(position.accuracy||0)}m` : "○ Esperando..."}</div>}
            </div>
            {gpsError && <div className="rounded-2xl bg-rose-950/50 border border-rose-700 p-3 text-sm font-bold">⚠ {gpsError}</div>}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <BigMetric label="Rumbo actual (COG)" value={Math.round(position?.cog||0)} unit="°" />
              <BigMetric label="Rumbo al WP (BRG)" value={Math.round(nav?.brg||0)} unit="°" accent />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <BigMetric label="Velocidad" value={(position?.speedKts||0).toFixed(1)} unit="kt" />
              <BigMetric label="Distancia al WP" value={(metersToNm(nav?.distM||0)).toFixed(2)} unit="nm" accent />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <SmallMetric label="VMG" value={(nav?.vmg||0).toFixed(1)} unit="kt" />
              <SmallMetric label="XTE" value={(metersToNm(Math.abs(nav?.xteM||0))).toFixed(2)} unit="nm" highlight={Math.abs(nav?.xteM||0)>50} />
              <SmallMetric label="TTG" value={formatTimeHours(nav?.ttgH)} unit="" />
            </div>
            <div className="rounded-[2rem] bg-black border-2 border-slate-500 p-5">
              <div className="text-slate-300 text-base tracking-[0.18em] uppercase font-black mb-1">Waypoint activo</div>
              <div className="text-4xl md:text-6xl font-black tabular-nums text-cyan-300">{activeWpt?.name||"SIN DESTINO"}</div>
              {activeWpt?.note && <div className="text-slate-400 text-sm mt-1">{activeWpt.note}</div>}
              <div className="mt-3 text-slate-400 text-sm md:text-base">{position ? `${formatLat(position.lat)} · ${formatLon(position.lon)}` : "Sin posición GPS"}</div>
            </div>
          </div>
        )}

        {/* WPT */}
        {tab === "wpt" && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3 items-center">
              <div className="flex items-center gap-2 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 flex-1 min-w-[200px]">
                <Search className="w-4 h-4 text-slate-400" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar waypoint..." className="bg-transparent outline-none w-full text-white font-bold" />
              </div>
              <button onClick={() => setShowAddModal(true)} className="px-4 py-3 rounded-2xl bg-cyan-600 hover:bg-cyan-500 font-black flex items-center gap-2"><Plus className="w-4 h-4" /> Nuevo WPT</button>
              <button onClick={exportWptsGpx} className="px-4 py-3 rounded-2xl bg-slate-700 hover:bg-slate-600 font-black flex items-center gap-2"><Download className="w-4 h-4" /> GPX</button>
            </div>
            <div className="grid gap-3">
              {filteredWaypoints.length === 0 && <div className="text-slate-400 text-center py-8">Sin resultados.</div>}
              {filteredWaypoints.map(w => {
                const distM = position ? haversineDistance(position.lat, position.lon, w.lat, w.lon) : null;
                return (
                  <div key={w.id} className="rounded-3xl bg-slate-900/90 border border-slate-700 p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div>
                      <div className="text-xl font-black text-white">{w.name}</div>
                      <div className="text-slate-400 text-sm">{w.note||"Sin nota"}</div>
                      <div className="text-sm mt-1 text-slate-300">{formatLat(w.lat)} · {formatLon(w.lon)}</div>
                      {distM !== null && <div className="text-xs mt-1 text-cyan-400 font-bold">{metersToNm(distM).toFixed(2)} nm desde posición actual</div>}
                    </div>
                    <div className="flex gap-2 flex-wrap">
                      <button onClick={() => { setRoute([w.id]); setActiveRouteIndex(0); setTab("nav"); }} className="px-3 py-2 rounded-2xl bg-emerald-700 hover:bg-emerald-600 font-black text-sm">Ir directo</button>
                      <button onClick={() => setRoute(p => p.includes(w.id) ? p : [...p, w.id])} className="px-3 py-2 rounded-2xl bg-cyan-700 hover:bg-cyan-600 font-black text-sm">+ Ruta</button>
                      <button onClick={() => setWaypoints(p => p.filter(x => x.id !== w.id))} className="px-3 py-2 rounded-2xl bg-rose-700 hover:bg-rose-600"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ROUTE */}
        {tab === "route" && (
          <div className="grid lg:grid-cols-2 gap-4">
            <div className="rounded-3xl bg-slate-900/90 border border-slate-700 p-4">
              <div className="text-xl font-black mb-4">Ruta ({routeWaypoints.length} WPT)</div>
              <div className="space-y-3">
                {routeWaypoints.length === 0 && <div className="text-slate-400">Agregá waypoints desde la pestaña WPT.</div>}
                {routeWaypoints.map((w, idx) => (
                  <div key={`${w.id}-${idx}`} className={`rounded-2xl border p-3 flex items-center justify-between ${idx === activeRouteIndex ? "border-cyan-400 bg-cyan-500/10" : "border-slate-700 bg-slate-800/70"}`}>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-sm font-black">{idx + 1}</div>
                      <div><div className="font-black">{w.name}</div><div className="text-xs text-slate-400">{w.note||"Sin nota"}</div></div>
                    </div>
                    <div className="flex items-center gap-1">
                      {idx === activeRouteIndex && <ArrowRight className="w-4 h-4 text-cyan-300 mr-1" />}
                      <button onClick={() => moveInRoute(idx,-1)} className="p-1 rounded-xl bg-slate-700 hover:bg-slate-600"><ChevronUp className="w-4 h-4" /></button>
                      <button onClick={() => moveInRoute(idx,1)} className="p-1 rounded-xl bg-slate-700 hover:bg-slate-600"><ChevronDown className="w-4 h-4" /></button>
                      <button onClick={() => setRoute(p => p.filter((_,i) => i!==idx))} className="p-1 rounded-xl bg-rose-700 hover:bg-rose-600 ml-1"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-3xl bg-slate-900/90 border border-slate-700 p-4 space-y-4">
              <div className="text-xl font-black">Control de ruta</div>
              <div className="flex items-center justify-between rounded-2xl border border-slate-700 p-4">
                <div><div className="font-black">Auto avance</div><div className="text-sm text-slate-400">Pasa al siguiente WPT al llegar</div></div>
                <button onClick={() => setAutoAdvance(!autoAdvance)} className={`px-4 py-2 rounded-2xl font-black ${autoAdvance ? "bg-emerald-600" : "bg-slate-700"}`}>{autoAdvance ? "ON" : "OFF"}</button>
              </div>
              <div className="rounded-2xl border border-slate-700 p-4">
                <div className="font-black mb-2">Radio de arribo: <span className="text-cyan-300">{arrivalRadius} m</span></div>
                <input type="range" min="10" max="200" step="5" value={arrivalRadius} onChange={e => setArrivalRadius(Number(e.target.value))} className="w-full accent-cyan-400" />
              </div>
              <div className="flex gap-3 flex-wrap">
                <button onClick={() => setActiveRouteIndex(0)} className="px-4 py-3 rounded-2xl bg-cyan-700 hover:bg-cyan-600 font-black flex items-center gap-2"><Save className="w-4 h-4" /> Reiniciar</button>
                <button onClick={() => { setRoute([]); setActiveRouteIndex(0); }} className="px-4 py-3 rounded-2xl bg-rose-700 hover:bg-rose-600 font-black">Vaciar</button>
              </div>
            </div>
          </div>
        )}

        {/* TRACK */}
        {tab === "track" && (
          <div className="space-y-4">
            <div className={`rounded-2xl border p-4 flex items-center justify-between flex-wrap gap-3 ${trackRecording ? "border-cyan-400 bg-cyan-950/40" : "border-slate-700 bg-slate-900/40"}`}>
              <div>
                <div className={`text-2xl font-black ${trackRecording ? "text-cyan-300" : "text-slate-400"}`}>{trackRecording ? "● GRABANDO" : "○ DETENIDO"}</div>
                <div className="text-slate-400 text-sm">{trackStartedAt ? `Inicio: ${new Date(trackStartedAt).toLocaleTimeString()} · ${formatDuration(now - trackStartedAt)}` : "Sin track activo"}</div>
              </div>
              <div className="flex gap-2">
                {!trackRecording && <button onClick={startTrack} className="px-4 py-3 rounded-2xl bg-cyan-700 hover:bg-cyan-600 font-black flex items-center gap-2"><Play className="w-4 h-4" /> Grabar</button>}
                {trackRecording && <button onClick={stopTrack} className="px-4 py-3 rounded-2xl bg-amber-700 hover:bg-amber-600 font-black flex items-center gap-2"><Square className="w-4 h-4" /> Detener</button>}
                <button onClick={clearTrack} className="px-4 py-3 rounded-2xl bg-slate-700 hover:bg-slate-600 font-black flex items-center gap-2"><RotateCcw className="w-4 h-4" /> Borrar</button>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <SmallMetric label="Puntos" value={trackPoints.length} unit="" />
              <SmallMetric label="Distancia" value={trackDistanceNm.toFixed(2)} unit="nm" />
              <SmallMetric label="Duración" value={trackStartedAt ? formatDuration(now - trackStartedAt).slice(0,5) : "--:--"} unit="" />
              <SmallMetric label="Vel. media" value={trackPoints.length > 1 && trackStartedAt ? (trackDistanceNm / ((now - trackStartedAt) / 3600000)).toFixed(1) : "0.0"} unit="kt" />
            </div>

            <div className="rounded-3xl bg-slate-900/90 border border-slate-700 p-5 space-y-4">
              <div className="text-xl font-black text-white">Exportar GPX</div>
              <p className="text-slate-400 text-sm">Compatible con OpenCPN, Navionics, QtVlm, Google Earth y la mayoría de chartplotters.</p>
              <div className="grid gap-3">
                <button onClick={exportTrackGpx} disabled={trackPoints.length < 2}
                  className="w-full px-5 py-4 rounded-2xl bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed font-black flex items-center gap-3 text-lg">
                  <Download className="w-5 h-5" />
                  <div className="text-left">
                    <div>Exportar Track</div>
                    <div className="text-xs font-normal text-cyan-200">{trackPoints.length} puntos · {trackDistanceNm.toFixed(2)} nm</div>
                  </div>
                </button>
                <button onClick={exportWptsGpx} disabled={waypoints.length === 0}
                  className="w-full px-5 py-4 rounded-2xl bg-slate-700 hover:bg-slate-600 disabled:opacity-40 font-black flex items-center gap-3 text-lg">
                  <Download className="w-5 h-5" />
                  <div className="text-left">
                    <div>Exportar Waypoints</div>
                    <div className="text-xs font-normal text-slate-300">{waypoints.length} waypoints</div>
                  </div>
                </button>
                <button onClick={exportFullGpx}
                  className="w-full px-5 py-4 rounded-2xl bg-emerald-800 hover:bg-emerald-700 font-black flex items-center gap-3 text-lg">
                  <Download className="w-5 h-5" />
                  <div className="text-left">
                    <div>Exportar Todo (Track + WPT + Ruta)</div>
                    <div className="text-xs font-normal text-emerald-200">GPX completo para OpenCPN / chartplotter</div>
                  </div>
                </button>
              </div>
              {trackPoints.length > 0 && (
                <div className="rounded-2xl bg-black border border-slate-700 p-3">
                  <div className="text-xs font-black text-slate-400 tracking-widest uppercase mb-2">Preview GPX</div>
                  <pre className="text-xs text-green-400 font-mono overflow-x-auto whitespace-pre-wrap">{`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="BedrossGpsPWA v${APP_VERSION}">
  <!-- ${waypoints.length} waypoints, ${routeWaypoints.length} en ruta -->
  <trk>
    <name>Track ${trackStartedAt ? new Date(trackStartedAt).toLocaleString() : ""}</name>
    <!-- ${trackPoints.length} trkpt, ${trackDistanceNm.toFixed(3)} nm -->
    <trkpt lat="${trackPoints[0]?.lat.toFixed(6)}" lon="${trackPoints[0]?.lon.toFixed(6)}">
      <time>${trackPoints[0]?.ts ? new Date(trackPoints[0].ts).toISOString() : "--"}</time>
    </trkpt>
    ...
  </trk>
</gpx>`}</pre>
                </div>
              )}
            </div>
          </div>
        )}

        {/* SETTINGS */}
        {tab === "settings" && (
          <div className="space-y-4">
            <div className="rounded-3xl bg-slate-900/90 border border-slate-700 p-5">
              <div className="text-xl font-black mb-3">Estado del sistema</div>
              <ul className="space-y-2 text-sm font-bold">
                <li className={navOn ? "text-emerald-400" : "text-slate-500"}>● GPS: {navOn ? "Activo" : "Apagado"}{position ? ` (±${Math.round(position.accuracy||0)}m)` : ""}</li>
                <li className="text-slate-300">● Waypoints: {waypoints.length} guardados</li>
                <li className="text-slate-300">● Ruta: {routeWaypoints.length} WPT · activo #{activeRouteIndex + 1}</li>
                <li className={trackRecording ? "text-cyan-400" : "text-slate-500"}>● Track: {trackRecording ? "Grabando" : "Detenido"} · {trackPoints.length} pts · {trackDistanceNm.toFixed(2)} nm</li>
                <li className="text-slate-300">● Auto-avance: {autoAdvance ? "ON" : "OFF"} · Radio: {arrivalRadius}m</li>
                <li className="text-slate-500">● v{APP_VERSION} · Río de la Plata · WGS84 · GMT-3</li>
              </ul>
            </div>
            <div className="rounded-3xl bg-rose-950/40 border border-rose-800 p-5">
              <div className="text-xl font-black mb-3 text-rose-300">Resetear datos</div>
              <div className="flex gap-3 flex-wrap">
                <button onClick={() => { if (confirm("¿Restaurar waypoints semilla?")) setWaypoints(seedWaypoints); }} className="px-4 py-3 rounded-2xl bg-rose-800 hover:bg-rose-700 font-black text-sm">Reset WPT</button>
                <button onClick={() => { if (confirm("¿Vaciar ruta?")) { setRoute([]); setActiveRouteIndex(0); } }} className="px-4 py-3 rounded-2xl bg-rose-800 hover:bg-rose-700 font-black text-sm">Reset Ruta</button>
                <button onClick={() => { if (confirm("¿Borrar track?")) clearTrack(); }} className="px-4 py-3 rounded-2xl bg-rose-800 hover:bg-rose-700 font-black text-sm">Borrar Track</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
