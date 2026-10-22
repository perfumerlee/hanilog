import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const basePath = env.PAGES_BASE_PATH?.trim();
  const base = basePath ? `/${basePath.replace(/^\/+|\/+$/g, '')}/` : '/';

  return {
    base,
    plugins: [
      ...(command === 'serve' ? [basicSsl()] : []),
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'prompt',
        injectRegister: 'auto',
        includeAssets: ['paw.svg'],
        manifest: {
          name: 'HaniLog',
          short_name: 'HaniLog',
          lang: 'ko',
          description: '반려동물 건강 기록을 함께 관리합니다.',
          start_url: base,
          scope: base,
          display: 'standalone',
          background_color: '#f8fafc',
          theme_color: '#0f766e',
          icons: [
            { src: `${base}paw.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,ico,png,webmanifest}'],
          navigateFallback: 'index.html',
          runtimeCaching: [],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      coverage: { reporter: ['text', 'html'] },
    },
  };
});
