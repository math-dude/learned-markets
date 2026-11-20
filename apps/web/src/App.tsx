import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import ActivityPage from './pages/ActivityPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PaperBoard, PaperCoinPage, PaperGuide, PaperLaunch, PaperPortfolio, PaperShell } from './paper/MarketPages'

import { WalletBoundary } from './wallet/WalletBoundary'
import { ChainMarket } from './wallet/ChainMarket'

const PrivyWallet = lazy(() => import('./wallet/PrivyWallet'))

export default function App() {
  const routes = import.meta.env.VITE_LM_EXECUTION === 'sandbox' ? <Routes>
    <Route path="activity" element={<ActivityPage />} />
    <Route element={<PaperShell />}>
      <Route index element={<PaperBoard />} />
      <Route path="coin/:ticker" element={<PaperCoinPage />} />
      <Route path="portfolio" element={<PaperPortfolio />} />
      <Route path="launch" element={<PaperLaunch />} />
      <Route path="how-it-works" element={<PaperGuide />} />
      <Route path="*" element={<NotFoundPage />} />
    </Route>
  </Routes> : <ChainMarket />
  return import.meta.env.VITE_PRIVY_APP_ID
    ? <WalletBoundary market={routes}><Suspense fallback={<p>Connecting wallet…</p>}><PrivyWallet>{routes}</PrivyWallet></Suspense></WalletBoundary>
    : routes
}
