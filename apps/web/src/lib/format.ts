const pad2 = (n: number) => String(n).padStart(2, '0')

/** "$412K", "$8.0K", "$1.20M" */
export function money(n: number): string {
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e5) return '$' + Math.round(n / 1e3) + 'K'
  return '$' + (n / 1e3).toFixed(1) + 'K'
}

/** "11h 20m" when over an hour, else "4m 05s". */
export function timeLeft(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m ${pad2(s)}s`
}

/** "12h 05m 05s" — full precision for the survival timer. */
export function timeLeftLong(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  return (h ? h + 'h ' : '') + String(m).padStart(h ? 2 : 1, '0') + 'm ' + pad2(s) + 's'
}

/** "1:15" */
export function clock(secs: number): string {
  return Math.floor(secs / 60) + ':' + pad2(secs % 60)
}

/** "+1.23" / "−0.40" using a real minus sign. */
export function signed(v: number, digits = 2): string {
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(digits)
}

export function signedPct(v: number, digits = 1): string {
  return signed(v, digits) + '%'
}

export function ago(ms: number): string {
  const s = ms / 1000
  if (s < 60) return Math.max(1, Math.round(s)) + 's'
  if (s < 3600) return Math.round(s / 60) + 'm'
  if (s < 86400) return Math.round(s / 3600) + 'h'
  return Math.round(s / 86400) + 'd'
}

export const num = (n: number) => Math.round(n).toLocaleString()
