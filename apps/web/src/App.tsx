import { Route, Routes } from 'react-router-dom'
import { Shell } from './components/Shell'
import { BoardPage } from './pages/BoardPage'
import { CoinPage } from './pages/CoinPage'
import { HowItWorksPage } from './pages/HowItWorksPage'
import { LaunchPage } from './pages/LaunchPage'
import { LinePage } from './pages/LinePage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PortfolioPage } from './pages/PortfolioPage'

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<BoardPage />} />
        <Route path="coin/:ticker" element={<CoinPage />} />
        <Route path="portfolio" element={<PortfolioPage />} />
        <Route path="line" element={<LinePage />} />
        <Route path="how-it-works" element={<HowItWorksPage />} />
        <Route path="launch" element={<LaunchPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
