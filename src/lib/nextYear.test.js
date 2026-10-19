import { describe, expect, it } from 'vitest';
import { nextYear } from './nextYear';

describe('nextYear', () => {
  it('bumps the last number', () => {
    expect(nextYear('Company Ryder Cup 2026')).toBe('Company Ryder Cup 2027');
    expect(nextYear('BIRDIE26')).toBe('BIRDIE27');
    expect(nextYear('RC2026-B')).toBe('RC2027-B');
  });
  it('keeps leading zeros', () => {
    expect(nextYear('CUP09')).toBe('CUP10');
    expect(nextYear('CUP05')).toBe('CUP06');
  });
  it('gives nothing back when there is no number', () => {
    expect(nextYear('BIRDIE')).toBe('');
    expect(nextYear('')).toBe('');
  });
});
