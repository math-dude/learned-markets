let ctx: AudioContext | null = null

/** Short chime when an epoch closes; three notes when a pick was right. */
export function chime(good: boolean): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    ctx ??= new Ctx()
    const ac = ctx
    if (ac.state === 'suspended') void ac.resume()
    const notes = good ? [659.25, 880, 1174.66] : [659.25, 880]
    notes.forEach((f, i) => {
      const o = ac.createOscillator()
      const g = ac.createGain()
      const t = ac.currentTime + i * 0.11
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.12, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
      o.connect(g)
      g.connect(ac.destination)
      o.start(t)
      o.stop(t + 0.55)
    })
  } catch {
    // audio is optional
  }
}
