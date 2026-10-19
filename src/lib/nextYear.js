// "Ryder Cup 2026" -> "Ryder Cup 2027", "BIRDIE26" -> "BIRDIE27": bump the last number.
// Text with no number gets nothing back, so the organizer types something new.
export function nextYear(s) {
  const m = /(\d+)(?!.*\d)/.exec(s || '');
  if (!m) return '';
  const n = String(Number(m[1]) + 1).padStart(m[1].length, '0');
  return s.slice(0, m.index) + n + s.slice(m.index + m[1].length);
}
