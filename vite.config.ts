import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  /**
   * Absolute base, deliberately.
   *
   * './' would make asset URLs relative to the current path, which breaks a
   * client-routed SPA on any nested route: /claims/clm-119640 would resolve
   * assets (and the MSW service worker) against /claims/, where they don't
   * exist. Serve from a subpath by setting this to that subpath, not by making
   * it relative.
   */
  base: '/',
  build: {
    // Surfaces bundle-budget regressions in CI. See design doc: Performance Budgets.
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // pdf.js is the single largest dependency. Keeping it in its own chunk
          // means grid-only users never download the document workspace runtime.
          if (id.includes('pdfjs-dist')) return 'pdfjs'
          if (id.includes('@tanstack')) return 'tanstack'
          if (id.includes('node_modules')) return 'vendor'
        },
      },
    },
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
} as never)
