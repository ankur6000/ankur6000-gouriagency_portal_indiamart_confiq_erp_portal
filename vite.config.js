import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiTarget = process.env.API_PROXY_TARGET || `http://127.0.0.1:${process.env.PORT || 3001}`

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: { '/api': apiTarget }
  }
})
