import { useEffect, useState } from 'react'

/** Current time in ms, refreshed every `ms`. Keeps Date.now() out of render. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}
