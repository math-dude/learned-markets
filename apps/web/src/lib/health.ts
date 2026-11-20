/** Green while a coin is safe, gold as it weakens, red when the next check can cut it. */
export function healthColor(m: { stage: string; survival: number | null; heat: number; live?: boolean }) {
  if (m.live === false) return 'var(--dim)'
  if (m.stage === 'Line') return m.heat >= 2 ? 'var(--green)' : m.heat >= 1 ? 'var(--gold)' : 'var(--red)'
  const left = Math.max(0, m.survival ?? 0)
  return left >= 60 ? 'var(--green)' : left >= 25 ? 'var(--gold)' : 'var(--red)'
}
