import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function normalizeBase(input) {
  if (!input || input === '/') return '/';
  const withSlash = input.startsWith('/') ? input : `/${input}`;
  return withSlash.endsWith('/') ? withSlash : `${withSlash}/`;
}

const base = normalizeBase(process.env.BASE_PATH);
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

function appVersionHtml() {
  return {
    name: 'app-version-html',
    transformIndexHtml(html) {
      return html.replaceAll('__APP_VERSION__', pkg.version);
    },
  };
}

export default defineConfig({
  base,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    appVersionHtml(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      manifestFilename: 'manifest.webmanifest',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: '寵物健康',
        short_name: '寵物健康',
        description: '記錄寵物日常與醫療。離線可用，登入後和家人透過 Google 雲端硬碟同步同一份資料。',
        lang: 'zh-TW',
        dir: 'ltr',
        id: './',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0f172a',
        theme_color: '#10b981',
        categories: ['lifestyle', 'health'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.js'],
  },
});
