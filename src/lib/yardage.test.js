import { describe, expect, it, vi } from 'vitest';
import { bestFix, gpsQuality, parseLatLng, yardsBetween } from './yardage';

describe('parseLatLng', () => {
  it('reads plain coordinates', () => {
    expect(parseLatLng('43.0356, -90.6584')).toEqual({ lat: 43.0356, lng: -90.6584 });
  });
  it('reads a Google Maps link', () => {
    expect(parseLatLng('https://www.google.com/maps/@43.0356007,-90.6584304,17z'))
      .toEqual({ lat: 43.0356007, lng: -90.6584304 });
  });
  it('reads degrees, minutes and seconds from Google Earth', () => {
    const p = parseLatLng(`43°02'08"N 90°39'30"W`);
    expect(p.lat).toBeCloseTo(43 + 2 / 60 + 8 / 3600, 9);
    expect(p.lng).toBeCloseTo(-(90 + 39 / 60 + 30 / 3600), 9);
  });
  it('reads DMS variants: decimal seconds, curly quotes, commas, longitude first', () => {
    const want = { lat: 43.035694, lng: -90.658417 };
    for (const t of [`43°2'8.5"N, 90°39'30.3"W`, '43°02′08.5″N 90°39′30.3″W',
                     '43° 02’ 08.5” N, 90° 39’ 30.3” W', `90°39'30.3"W 43°2'8.5"N`]) {
      const p = parseLatLng(t);
      expect(p.lat, t).toBeCloseTo(want.lat, 5);
      expect(p.lng, t).toBeCloseTo(want.lng, 5);
    }
    expect(parseLatLng('43°02.1417\'N 90°39.505\'W').lat).toBeCloseTo(43.035695, 5);
    expect(parseLatLng('33°51\'S 151°12\'E')).toEqual({ lat: -(33 + 51 / 60), lng: 151.2 });
  });
  it('rejects DMS missing a half or with impossible minutes', () => {
    expect(parseLatLng(`43°02'08"N`)).toBeNull();
    expect(parseLatLng(`43°75'08"N 90°39'30"W`)).toBeNull();
  });
  it('rejects junk and out-of-range values', () => {
    expect(parseLatLng('')).toBeNull();
    expect(parseLatLng('the green')).toBeNull();
    expect(parseLatLng('95, 10')).toBeNull();
  });
});

describe('yardsBetween', () => {
  it('is zero for the same point', () => {
    expect(yardsBetween({ lat: 43, lng: -90 }, { lat: 43, lng: -90 })).toBe(0);
  });
  it('measures a 150-yard shot', () => {
    // 150 yd = 137.16 m due north; one degree of latitude ≈ 111,195 m.
    const tee = { lat: 43.0356, lng: -90.6584 };
    const green = { lat: tee.lat + 137.16 / 111195, lng: tee.lng };
    expect(yardsBetween(tee, green)).toBeCloseTo(150, 0);
  });
});

describe('bestFix', () => {
  // Fake GPS that delivers readings 1s apart; records whether it was switched off.
  function fakeGps(readings, error) {
    const gps = { cleared: false };
    gps.watchPosition = (ok, fail) => {
      readings.forEach((acc, n) => setTimeout(() =>
        ok({ coords: { latitude: 43 + n, longitude: -90, accuracy: acc } }), 1000 * (n + 1)));
      if (error) setTimeout(() => fail(error), 500);
      return 7;
    };
    gps.clearWatch = id => { if (id === 7) gps.cleared = true; };
    return gps;
  }

  it('skips the rough first reading and stops once GPS settles', async () => {
    vi.useFakeTimers();
    const gps = fakeGps([80, 20, 4, 3]);
    const seen = [];
    const p = bestFix(gps, { onProgress: m => seen.push(m) });
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ lat: 45, lng: -90, acc: 4 });
    expect(seen).toEqual([80, 20, 4]);
    expect(gps.cleared).toBe(true);
    vi.useRealTimers();
  });

  it('takes the best reading when time runs out', async () => {
    vi.useFakeTimers();
    const gps = fakeGps([60, 12, 30]);
    const p = bestFix(gps, { waitMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toMatchObject({ lat: 44, acc: 12 });
    expect(gps.cleared).toBe(true);
    vi.useRealTimers();
  });

  it('rejects when location is denied', async () => {
    vi.useFakeTimers();
    const denied = { code: 1, PERMISSION_DENIED: 1, message: 'denied' };
    const p = bestFix(fakeGps([], denied));
    const check = expect(p).rejects.toBe(denied);
    await vi.advanceTimersByTimeAsync(1000);
    await check;
    vi.useRealTimers();
  });
});

describe('gpsQuality', () => {
  it('maps accuracy to bars', () => {
    expect([null, 3, 5, 8, 10, 15, 20, 21, 500].map(m => gpsQuality(m).bars))
      .toEqual([0, 4, 4, 3, 3, 2, 2, 1, 1]);
  });
});
