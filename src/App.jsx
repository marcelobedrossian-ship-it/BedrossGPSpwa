import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Search, Plus, Trash2, Navigation, Route, Settings, Play, Square,
  ArrowRight, Save, Compass, MapPinned, RotateCcw,
} from "lucide-react";

const DEFAULT_ARRIVAL_RADIUS = 50;
const TRACK_MIN_DISTANCE_M = 12;

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
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function initialBearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return normalizeBearing(toDeg(Math.atan2(y, x)));
}

function crossTrackErrorMeters(start, end, current) {
  if (!start || !end || !current) return 0;
  const d13 = haversineDistance(start.lat, start.lon, current.lat, current.lon) / 6371000;
  const theta13 = toRad(initialBearing(start.lat, start.lon, current.lat, current.lon));
  const theta12 = toRad(initialBearing(start.lat, start.lon, end.lat, end.lon));
  return Math.asin(Math.sin(d13) * Math.sin(theta13 - theta12)) * 6371000;
}

function formatLat(lat) {
  const hemi = lat >= 0 ? "N" : "S";
  return `${Math.abs(lat).toFixed(5)}° ${hemi}`;
}
function formatLon(lon) {
  const hemi = lon >= 0 ? "E" : "W";
  return `${Math.abs(lon).toFixed(5)}° ${hemi}`;
}
function formatTimeHours(hours) {
  if (!isFinite(hours) || hours <= 0) return "--:--";
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function BigMetric({ label, value, unit }) {
  return (
    <div className="rounded-[2rem] bg-black border-2 border-slate-500 shadow-2xl p-5 min-h-[220px] md:min-h-[260px] flex flex-col justify-between">
      <div className="text-slate-300 text-base md:text-lg tracking-[0.18em] uppercase font-black">{label}</div>
      <div className="flex items-end gap-3">
        <div className="font-black tabular-nums leading-none text-white text-8xl md:text-[10rem] drop-shadow-[0_2px_6px_rgba(255,255,255,0.18)]">
          {value}
        </div>
        {unit && <div className="text-slate-200 text-2xl md:text-3xl mb-3 font-black">{unit}</div>}
      </div>
    </div>
  );
}

function SmallMetric({ label, value, unit }) {
  return (
    <div className="rounded-[2rem] bg-black border-2 border-slate-700 p-4 min-h-[150px] flex flex-col justify-between">
      <div className="text-slate-400 text-sm tracking-[0.16em] uppercase font-black">{label}</div>
      <div className="flex items-end gap-2">
        <div className="font-black tabular-nums leading-none text-white text-6xl md:text-7xl">{value}</div>
        {unit && <div className="text-slate-300 text-xl mb-2 font-black">{unit}</div>}
      </div>
    </div>
  );
}

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
  const watchRef = useRef(null);

  useEffect(() => localStorage.setItem("bedross_waypoints_v2", JSON.stringify(waypoints)), [waypoints]);
  useEffect(() => localStorage.setItem("bedross_route_v2", JSON.stringify(route)), [route]);
  useEffect(() => localStorage.setItem("bedross_route_index_v2", JSON.stringify(activeRouteIndex)), [activeRouteIndex]);
  useEffect(() => localStorage.setItem("bedross_auto_advance_v2", JSON.stringify(autoAdvance)), [autoAdvance]);
  useEffect(() => localStorage.setItem("bedross_arrival_radius_v2", JSON.stringify(arrivalRadius)), [arrivalRadius]);
  useEffect(() => localStorage.setItem("bedross_track_recording_v2", JSON.stringify(trackRecording)), [trackRecording]);
  useEffect(() => localStorage.setItem("bedross_track_points_v2", JSON.stringify(trackPoints)), [trackPoints]);
  useEffect(() => localStorage.setItem("bedross_track_started_v2", JSON.stringify(trackStartedAt)), [trackStartedAt]);

  useEffect(() => {
    if (!navOn) {
      if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
      return;
    }
    if (!navigator.geolocation) {
      setGpsError("Geolocalización no soportada.");
      return;
    }
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setGpsError("");
        const newPosition = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          speedKts: knotsFromMps(pos.coords.speed || 0),
          cog: pos.coords.heading ?? 0,
          accuracy: pos.coords.accuracy,
          ts: pos.timestamp,
        };
        setPosition(newPosition);
        if (trackRecording) {
          setTrackPoints((prev) => {
            const last = prev[prev.length - 1];
            if (!last) return [...prev, newPosition];
            const dist = haversineDistance(last.lat, last.lon, newPosition.lat, newPosition.lon);
            return dist >= TRACK_MIN_DISTANCE_M ? [...prev, newPosition] : prev;
          });
        }
      },
      (err) => setGpsError(err.message || "Error GPS"),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
    );
    return () => {
      if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current);
    };
  }, [navOn, trackRecording]);

  const routeWaypoints = useMemo(() => route.map((id) => waypoints.find((w) => w.id === id)).filter(Boolean), [route, waypoints]);
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
    for (let i = 1; i < trackPoints.length; i++) {
      total += haversineDistance(trackPoints[i - 1].lat, trackPoints[i - 1].lon, trackPoints[i].lat, trackPoints[i].lon);
    }
    return metersToNm(total);
  }, [trackPoints]);

  useEffect(() => {
    if (!autoAdvance || !nav || !activeWpt) return;
    if (nav.distM <= arrivalRadius && activeRouteIndex < routeWaypoints.length - 1) {
      setActiveRouteIndex((i) => i + 1);
    }
  }, [nav, autoAdvance, arrivalRadius, activeRouteIndex, routeWaypoints.length, activeWpt]);

  const filteredWaypoints = waypoints.filter((w) =>
    [w.name, w.note, `${w.lat}`, `${w.lon}`].join(" ").toLowerCase().includes(search.toLowerCase())
  );

  const addWaypoint = () => {
    const name = prompt("Nombre del waypoint:");
    const lat = Number(prompt("Latitud decimal (-34.12345):"));
    const lon = Number(prompt("Longitud decimal (-58.12345):"));
    const note = prompt("Nota / descripción:") || "";
    if (!name || Number.isNaN(lat) || Number.isNaN(lon)) return;
    setWaypoints((prev) => [...prev, { id: crypto.randomUUID(), name, lat, lon, note }]);
  };

  const addToRoute = (id) => setRoute((prev) => (prev.includes(id) ? prev : [...prev, id]));
  const removeFromRoute = (idx) => setRoute((prev) => prev.filter((_, i) => i !== idx));

  const startTrack = () => {
    setTrackRecording(true);
    if (!trackStartedAt) setTrackStartedAt(Date.now());
    if (position && trackPoints.length === 0) setTrackPoints([position]);
  };

  const stopTrack = () => setTrackRecording(false);
  const clearTrack = () => {
    setTrackPoints([]);
    setTrackStartedAt(null);
    setTrackRecording(false);
  };

  return (
    <div className="min-h-screen bg-black text-white p-3 md:p-5 select-none">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl md:text-3xl font-black tracking-tight text-white">BedrossGpsPWA</h1>
            <p className="text-slate-300 text-sm md:text-base font-bold">Pantalla náutica de alto contraste para sol directo</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            {[
              ["nav", <Compass className="w-4 h-4" />, "Navegar"],
              ["wpt", <Navigation className="w-4 h-4" />, "WPT"],
              ["route", <Route className="w-4 h-4" />, "Ruta"],
              ["settings", <Settings className="w-4 h-4" />, "Datos"],
            ].map(([key, icon, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`px-3 py-2 rounded-2xl border-2 font-black flex items-center gap-2 ${tab === key ? "bg-white text-black border-white" : "bg-black border-slate-500 text-white"}`}
              >
                {icon}
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab === "nav" && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setNavOn(true)} className="px-4 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-500 font-black flex items-center gap-2"><Play className="w-4 h-4" /> Navegación ON</button>
              <button onClick={() => setNavOn(false)} className="px-4 py-3 rounded-2xl bg-rose-600 hover:bg-rose-500 font-black flex items-center gap-2"><Square className="w-4 h-4" /> Navegación OFF</button>
            </div>

            {gpsError && <div className="rounded-2xl bg-rose-950/50 border border-rose-700 p-3 text-sm">GPS: {gpsError}</div>}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <BigMetric label="Rumbo actual" value={Math.round(position?.cog || 0)} unit="°" />
              <BigMetric label="Rumbo al WP" value={Math.round(nav?.brg || 0)} unit="°" />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <BigMetric label="Velocidad" value={(position?.speedKts || 0).toFixed(1)} unit="kt" />
              <BigMetric label="Distancia al WP" value={(metersToNm(nav?.distM || 0)).toFixed(2)} unit="nm" />
            </div>

            <div className="rounded-[2rem] bg-black border-2 border-slate-500 p-5">
              <div className="text-slate-300 text-base tracking-[0.18em] uppercase font-black mb-2">Waypoint activo</div>
              <div className="text-4xl md:text-6xl font-black tabular-nums">{activeWpt?.name || "SIN DESTINO"}</div>
              <div className="mt-3 text-slate-400 text-sm md:text-base">{position ? `${formatLat(position.lat)} · ${formatLon(position.lon)}` : "Sin posición GPS"}</div>
            </div>
          </div>
        )}

        {tab === "wpt" && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3 items-center">
              <div className="flex items-center gap-2 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 flex-1 min-w-[280px]">
                <Search className="w-4 h-4 text-slate-400" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar waypoint..." className="bg-transparent outline-none w-full text-white" />
              </div>
              <button onClick={addWaypoint} className="px-4 py-3 rounded-2xl bg-cyan-600 hover:bg-cyan-500 font-black flex items-center gap-2"><Plus className="w-4 h-4" /> Nuevo WPT</button>
            </div>

            <div className="grid gap-3">
              {filteredWaypoints.map((w) => (
                <div key={w.id} className="rounded-3xl bg-slate-900/90 border border-slate-700 p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                  <div>
                    <div className="text-xl font-black">{w.name}</div>
                    <div className="text-slate-400 text-sm">{w.note || "Sin nota"}</div>
                    <div className="text-sm mt-2">{formatLat(w.lat)} · {formatLon(w.lon)}</div>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    <button onClick={() => { setRoute([w.id]); setActiveRouteIndex(0); setTab("nav"); }} className="px-3 py-2 rounded-2xl bg-emerald-700 hover:bg-emerald-600 font-black">Ir a WPT</button>
                    <button onClick={() => addToRoute(w.id)} className="px-3 py-2 rounded-2xl bg-cyan-700 hover:bg-cyan-600 font-black">Agregar a ruta</button>
                    <button onClick={() => setWaypoints((prev) => prev.filter((x) => x.id !== w.id))} className="px-3 py-2 rounded-2xl bg-rose-700 hover:bg-rose-600"><Trash2 className="w-4 h-4" /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "route" && (
          <div className="grid lg:grid-cols-2 gap-4">
            <div className="rounded-3xl bg-slate-900/90 border border-slate-700 p-4">
              <div className="text-xl font-black mb-4">Ruta actual</div>
              <div className="space-y-3">
                {routeWaypoints.length === 0 && <div className="text-slate-400">Todavía no agregaste waypoints a la ruta.</div>}
                {routeWaypoints.map((w, idx) => (
                  <div key={`${w.id}-${idx}`} className={`rounded-2xl border p-3 flex items-center justify-between ${idx === activeRouteIndex ? "border-cyan-400 bg-cyan-500/10" : "border-slate-700 bg-slate-800/70"}`}>
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-sm font-black">{idx + 1}</div>
                      <div>
                        <div className="font-black">{w.name}</div>
                        <div className="text-xs text-slate-400">{w.note || "Sin nota"}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {idx === activeRouteIndex && <ArrowRight className="w-4 h-4 text-cyan-300" />}
                      <button onClick={() => removeFromRoute(idx)} className="px-2 py-2 rounded-xl bg-rose-700 hover:bg-rose-600"><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-3xl bg-slate-900/90 border border-slate-700 p-4 space-y-4">
              <div className="text-xl font-black">Control de ruta</div>
              <div className="flex items-center justify-between rounded-2xl border border-slate-700 p-4">
                <div>
                  <div className="font-black">Auto avance</div>
                  <div className="text-sm text-slate-400">Pasa al siguiente waypoint al entrar en radio de arribo</div>
                </div>
                <button onClick={() => setAutoAdvance(!autoAdvance)} className={`px-4 py-2 rounded-2xl font-black ${autoAdvance ? "bg-emerald-600" : "bg-slate-700"}`}>{autoAdvance ? "ON" : "OFF"}</button>
              </div>
              <div className="rounded-2xl border border-slate-700 p-4">
                <div className="font-black mb-2">Radio de arribo</div>
                <input type="range" min="10" max="150" step="5" value={arrivalRadius} onChange={(e) => setArrivalRadius(Number(e.target.value))} className="w-full" />
                <div className="text-sm text-slate-400 mt-2">{arrivalRadius} metros</div>
              </div>
              <div className="flex gap-3">
                <button onClick={() => setActiveRouteIndex(0)} className="px-4 py-3 rounded-2xl bg-cyan-700 hover:bg-cyan-600 font-black flex items-center gap-2"><Save className="w-4 h-4" /> Reiniciar ruta</button>
                <button onClick={() => { setRoute([]); setActiveRouteIndex(0); }} className="px-4 py-3 rounded-2xl bg-rose-700 hover:bg-rose-600 font-black">Vaciar</button>
              </div>
            </div>
          </div>
        )}

        {tab === "settings" && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <SmallMetric label="VMG" value={(nav?.vmg || 0).toFixed(1)} unit="kt" />
              <SmallMetric label="XTE" value={(metersToNm(Math.abs(nav?.xteM || 0))).toFixed(2)} unit="nm" />
              <SmallMetric label="Tiempo al WP" value={formatTimeHours(nav?.ttgH)} unit="" />
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="rounded-[2rem] bg-black border-2 border-slate-700 p-5">
                <div className="text-slate-300 text-base tracking-[0.18em] uppercase font-black mb-3">Track</div>
                <div className="flex flex-wrap gap-2 mb-4">
                  <button onClick={startTrack} className="px-4 py-3 rounded-2xl bg-cyan-700 hover:bg-cyan-600 font-black flex items-center gap-2"><MapPinned className="w-4 h-4" /> Grabar Track</button>
                  <button onClick={stopTrack} className="px-4 py-3 rounded-2xl bg-amber-700 hover:bg-amber-600 font-black flex items-center gap-2"><Square className="w-4 h-4" /> Detener</button>
                  <button onClick={clearTrack} className="px-4 py-3 rounded-2xl bg-slate-700 hover:bg-slate-600 font-black flex items-center gap-2"><RotateCcw className="w-4 h-4" /> Borrar</button>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <SmallMetric label="Puntos" value={trackPoints.length} unit="" />
                  <SmallMetric label="Distancia" value={trackDistanceNm.toFixed(2)} unit="nm" />
                </div>
                <div className="mt-4 text-slate-300 text-sm font-black">REC: {trackRecording ? "ON" : "OFF"} · {trackStartedAt ? formatDuration(Date.now() - trackStartedAt) : "00:00:00"}</div>
              </div>

              <div className="rounded-[2rem] bg-black border-2 border-slate-700 p-5">
                <div className="text-slate-300 text-base tracking-[0.18em] uppercase font-black mb-3">Estado</div>
                <ul className="list-disc pl-6 text-slate-300 space-y-2 font-bold">
                  <li>Pantalla principal enfocada solo en rumbo, velocidad y distancia.</li>
                  <li>Diseño responsive para vertical y horizontal.</li>
                  <li>Track recorder persistente en LocalStorage.</li>
                  <li>Guarda waypoints, ruta, auto-next y radio de arribo.</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}