import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.LM_WEB_API || 'http://127.0.0.1:8000',
      '/v1': process.env.LM_ATTESTATION_URL || 'http://127.0.0.1:8787',
    },
  },
})
