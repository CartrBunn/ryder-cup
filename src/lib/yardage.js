// GPS yardage: distance from the phone to a hole's green. Dependency-free so it can be tested.

const YARDS_PER_METER = 1.0936133;
const EARTH_RADIUS_M = 6371008.8;

// Read a green location the organizer pasted: "43.0356, -90.6584", or a Google Maps link
// that carries "@lat,lng" or "?q=lat,lng". Returns { lat, lng } or null.
export function parseLatLng(text) {
  const m = String(text || '').match(/(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/);
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
