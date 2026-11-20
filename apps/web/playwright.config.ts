import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: { baseURL: 'http://127.0.0.1:5189' },
  webServer: {
    command: 'node ../../scripts/dev-web.mjs --host 127.0.0.1 --port 5189 --strictPort',
    env: { LM_WEB_API_PORT: '8019', LM_PAPER_SANDBOX: '1', VITE_PRIVY_APP_ID: '' },
    url: 'http://127.0.0.1:5189/api/market',
    timeout: 90_000,
    reuseExistingServer: false,
  },
})
