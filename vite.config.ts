import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { crx } from '@crxjs/vite-plugin'
import manifest from './src/manifest.json' with { type: 'json' }

export default defineConfig({
  plugins: [vue(), crx({ manifest })],
  build: {
    target: 'esnext',
    outDir: 'dist',
    rollupOptions: {
      input: {
        // entry points are declared via the manifest (crxjs maps them)
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
