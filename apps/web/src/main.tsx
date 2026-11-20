import { Buffer } from 'buffer/'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'

// Privy’s Solana signer reads the browser global when it encodes a challenge.
Object.assign(globalThis, { Buffer })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

// The hosting proxy sometimes fails to look up the backend and answers 502 itself, before the
// request reaches the service. Those are safe to send again, so no caller ever sees them.
const send = window.fetch.bind(window)
window.fetch = async (input, init) => {
  let response = await send(input, init)
  for (let attempt = 0; attempt < 8 && response.status === 502 && response.headers.get('x-vercel-error'); attempt++) {
    await new Promise((done) => setTimeout(done, 120))
    response = await send(input, init)
  }
  return response
}
