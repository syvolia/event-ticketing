import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';

// HTTPS config for phone testing. Generate certs with mkcert (see README);
// if the files are missing, we simply omit the `https` key so Vite falls
// back to HTTP. This is required because under exactOptionalPropertyTypes
// you cannot pass `https: undefined` — the key must be absent or a value.
const certDir = fileURLToPath(new URL('./.cert', import.meta.url));
const keyPath = `${certDir}/key.pem`;
const certPath = `${certDir}/cert.pem`;
const haveCerts = existsSync(keyPath) && existsSync(certPath);

const https = haveCerts
  ? { key: readFileSync(keyPath), cert: readFileSync(certPath) }
  : null;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Ticketing Scanner',
        short_name: 'Scanner',
        description: 'Scan tickets at the door, online or offline.',
        start_url: '/scan',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0b0b0b',
        theme_color: '#0b0b0b',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallbackDenylist: [/^\/api\//, /^\/webhooks\//],
        runtimeCaching: [
          {
            urlPattern: /\/checkin-manifest$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'manifest-cache',
              expiration: { maxEntries: 10, maxAgeSeconds: 24 * 60 * 60 },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@ticketing/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    host: true,
    // Spread-conditional: the key is omitted entirely when certs are absent.
    // Under exactOptionalPropertyTypes this is the only legal way to have an
    // optional property be "not present" — passing undefined is rejected.
    ...(https ? { https } : {}),
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});