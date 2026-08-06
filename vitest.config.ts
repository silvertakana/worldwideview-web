import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    alias: {
      '@': path.resolve(__dirname, './src')
    },
    // Keep the Playwright billing E2E specs (tests/billing-*.spec.ts) out of
    // the Vitest run — they are run via `pnpm test:e2e` instead.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.git/**',
      'tests/billing-*.spec.ts'
    ]
  }
})
