import { useEffect, useState } from 'react'
import './App.css'

type Event = { sig: string; slot: string; index: number; name: string; data: {
  clearingPrice?: string; batchId?: string; userBuy?: string; userSell?: string; intent?: string
} }
function App() {
  const [events, setEvents] = useState<Event[]>([])
  const [market, setMarket] = useState('')
  const [status, setStatus] = useState('Connecting to relayer')
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const url = new URL('/events', import.meta.env.VITE_SETTLER_URL || window.location.origin)
        const selected = new URLSearchParams(location.search).get('market')
        if (selected) url.searchParams.set('market', selected)
        const res = await fetch(url, {signal:controller.signal})
        if (!res.ok) throw new Error()
        const payload = await res.json()
        if (!Array.isArray(payload.events)) throw new Error()
        setEvents(payload.events)
        setMarket(payload.market)
        setStatus(payload.events.length ? 'Live' : 'Waiting for the first market event')
      } catch { if (!controller.signal.aborted) setStatus('Relayer unavailable') }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500)
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [])
  return <main className="market-feed">
    <header><h1>Market activity</h1><p role="status">{status}</p></header>
    {market && <p className="address">{market}</p>}
    <ol>{events.map(event => <li key={event.sig + ':' + event.index}>
      <div><strong>{event.name === 'BatchSettled' ? 'Batch ' + event.data.batchId + ' settled' : 'Intent submitted'}</strong>
        <small>Slot {event.slot}</small></div>
      {event.name === 'BatchSettled'
        ? <p>Price {event.data.clearingPrice} quote atoms per coin · Bought {event.data.userBuy} · Sold {event.data.userSell} base atoms</p>
        : <p className="address">{event.data.intent}</p>}
    </li>)}</ol>
  </main>
}
export default App
