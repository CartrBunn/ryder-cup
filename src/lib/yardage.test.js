import { describe, expect, it } from 'vitest';
import { parseLatLng, yardsBetween } from './yardage';

describe('parseLatLng', () => {
  it('reads plain coordinates', () => {
    expect(parseLatLng('43.0356, -90.6584')).toEqual({ lat: 43.0356, lng: -90.6584 });
  });
  it('reads a Google Maps link', () => {
    expect(parseLatLng('https://www.google.com/maps/@43.0356007,-90.6584304,17z'))
      .toEqual({ lat: 43.0356007, lng: -90.6584304 });
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
