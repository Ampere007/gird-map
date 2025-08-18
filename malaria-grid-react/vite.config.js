// vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // ถ้า backend คือ Express (index.mjs) ที่พอร์ต 8000
      '/api': { target: 'http://localhost:8000', changeOrigin: true }
      // ถ้าใช้ Python server.py แทน ให้เปลี่ยน target ให้ตรงพอร์ตของ Python
      // '/api': { target: 'http://localhost:8010', changeOrigin: true }
    }
  }
})
