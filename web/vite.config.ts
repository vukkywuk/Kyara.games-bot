import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Dev: `npm run web:dev` proxies /app-api to `kyara serve --dev-origin http://localhost:5173`.
const API = process.env.KYARA_API ?? 'http://127.0.0.1:47321';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    host: 'localhost',
    proxy: { '/app-api': { target: API, changeOrigin: true } },
    // the app imports a few pure, shared modules from ../src (types and character search)
    fs: { allow: [path.resolve(import.meta.dirname, '..')] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 700,
    // never inline assets as data: URIs (the server's CSP only allows same-origin fonts)
    assetsInlineLimit: 0,
  },
});
