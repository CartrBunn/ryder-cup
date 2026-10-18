// GPS yardage: distance from the phone to a hole's green. Dependency-free so it can be tested.

const YARDS_PER_METER = 1.0936133;
const EARTH_RADIUS_M = 6371008.8;

// One degrees-minutes-seconds coordinate with its N/S/E/W letter: 43°02'08"N, 43°2'8.5" N,
// 43°02.133'N or 43.0356°N (curly quotes and ′ ″ too, as Google Earth sometimes copies them).
const DMS = /(\d{1,3}(?:\.\d+)?)\s*°\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′’]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:"|″|”|''|′′)\s*)?([NSEW])/gi;

function parseDms(text) {
  const out = {};
  for (const [, d, m = 0, s = 0, hemi] of text.matchAll(DMS)) {
    if (Number(m) >= 60 || Number(s) >= 60) return null;
    const h = hemi.toUpperCase();
    const v = (Number(d) + Number(m) / 60 + Number(s) / 3600) * (h === 'S' || h === 'W' ? -1 : 1);
    out[h === 'N' || h === 'S' ? 'lat' : 'lng'] = v;
  }
  return out.lat != null && out.lng != null ? out : null;
}

// Read a location the organizer pasted: "43.0356, -90.6584", degrees-minutes-seconds from
// Google Earth (43°02'08"N 90°39'30"W), or a Google Maps link that carries "@lat,lng" or
// "?q=lat,lng". Returns { lat, lng } or null.
export function parseLatLng(text) {
  text = String(text || '');
  if (text.includes('°')) {
    const p = parseDms(text);
    if (!p || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return null;
    return p;
  }
  const m = text.match(/(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export const formatLatLng = p => p ? `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}` : '';

// Great-circle (haversine) distance between two { lat, lng } points, in yards.
export function yardsBetween(a, b) {
  const rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h)) * YARDS_PER_METER;
}

export const metersToYards = m => m * YARDS_PER_METER;

// A phone's first reading is often from Wi-Fi or cell towers and can be 50+ yards off, so
// keep listening until GPS settles to `goodM` meters (or `waitMs` runs out) and resolve with
// the most accurate reading seen: { lat, lng, acc } (acc in meters). `onProgress(acc)` reports
// the best accuracy so far. Rejects with the GeolocationPositionError if nothing arrives.
export function bestFix(geolocation, { goodM = 5, waitMs = 20000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let best = null, done = false, watch = null;
    const finish = err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (watch != null) geolocation.clearWatch(watch);
      if (best) resolve({ lat: best.latitude, lng: best.longitude, acc: best.accuracy });
      else reject(err || new Error('no location'));
    };
    const timer = setTimeout(() => finish(), waitMs);
    watch = geolocation.watchPosition(
      pos => {
        if (!best || pos.coords.accuracy < best.accuracy) best = pos.coords;
        onProgress?.(best.accuracy);
        if (best.accuracy <= goodM) finish();
      },
      err => { if (err.code === err.PERMISSION_DENIED || !best) finish(err); },
      { enableHighAccuracy: true, timeout: waitMs, maximumAge: 0 });
  });
}

// How trustworthy a reading is, from its accuracy radius in meters, for the GPS bar on the
// score card: 4 bars is good to a few yards, 1 bar means the number could be well off.
export function gpsQuality(accM) {
  if (accM == null) return { bars: 0, label: 'Finding GPS…' };
  if (accM <= 5) return { bars: 4, label: 'GPS excellent' };
  if (accM <= 10) return { bars: 3, label: 'GPS good' };
  if (accM <= 20) return { bars: 2, label: 'GPS fair' };
  return { bars: 1, label: 'GPS weak' };
}
