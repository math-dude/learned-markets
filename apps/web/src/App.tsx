import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import ActivityPage from './pages/ActivityPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PaperBoard, PaperCoinPage, PaperGuide, PaperLaunch, PaperPortfolio, PaperShell } from './paper/MarketPages'

const PrivyWallet = lazy(() => import('./wallet/PrivyWallet'))

export default function App() {
  const routes = <Routes>
    <Route path="activity" element={<ActivityPage />} />
    <Route element={<PaperShell />}>
      <Route index element={<PaperBoard />} />
      <Route path="coin/:ticker" element={<PaperCoinPage />} />
      <Route path="portfolio" element={<PaperPortfolio />} />
      <Route path="launch" element={<PaperLaunch />} />
      <Route path="how-it-works" element={<PaperGuide />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route>
  </Routes>
  return import.meta.env.VITE_PRIVY_APP_ID
    ? <Suspense fallback={<p>Connecting wallet…</p>}><PrivyWallet>{routes}</PrivyWallet></Suspense>
    : routes
}
