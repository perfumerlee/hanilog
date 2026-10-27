import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { loadEnv, type ViteDevServer } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

function getDevPort(): number {
  const port = Number(process.env.HANILOG_DEV_PORT ?? '7344');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('HANILOG_DEV_PORT must be a valid TCP port from 1 to 65535.');
  }
  return port;
}

const mobileTlsDirectory = resolve(process.cwd(), 'node_modules/.cache/hanilog-mobile');
const mobileTlsKey = resolve(mobileTlsDirectory, 'mobile-key.pem');
const mobileTlsCertificate = resolve(mobileTlsDirectory, 'mobile-cert.pem');
const mobileProfile = resolve(mobileTlsDirectory, 'HaniLog-Local-RootCA.mobileconfig');
const mobileRootCertificate = resolve(mobileTlsDirectory, 'rootCA.cer');
const mobileTlsReady = existsSync(mobileTlsKey) && existsSync(mobileTlsCertificate);
const mobileHttps = mobileTlsReady
  ? { key: readFileSync(mobileTlsKey), cert: readFileSync(mobileTlsCertificate) }
  : undefined;

function mobileCertificateDownload() {
  const profilePort = 7345;
  return {
    name: 'hanilog-mobile-certificate-download',
    configureServer(server: ViteDevServer) {
      // iOS must download the profile before it trusts the local HTTPS certificate,
      // so this tiny LAN-only helper intentionally uses plain HTTP on a fixed port.
      if (!existsSync(mobileProfile) && !existsSync(mobileRootCertificate)) return;

      const profileServer = createHttpServer((request, response) => {
        if (request.url === '/HaniLog-Local-RootCA.cer' && existsSync(mobileRootCertificate)) {
          response.writeHead(200, {
            'Content-Type': 'application/x-x509-ca-cert',
            'Content-Disposition': 'attachment; filename="HaniLog-Local-RootCA.cer"',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          response.end(readFileSync(mobileRootCertificate));
          return;
        }

        if (request.url === '/HaniLog-Local-RootCA.mobileconfig' && existsSync(mobileProfile)) {
          response.writeHead(200, {
            'Content-Type': 'application/x-apple-aspen-config; charset=utf-8',
            'Content-Disposition': 'attachment; filename="HaniLog-Local-RootCA.mobileconfig"',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          response.end(readFileSync(mobileProfile));
          return;
        }

        if (request.url === '/' && (existsSync(mobileProfile) || existsSync(mobileRootCertificate))) {
          const requestHost = request.headers.host?.split(':')[0];
          const lanHost = requestHost && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(requestHost)
            ? requestHost
            : 'localhost';
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>HaniLog certificate</title><main style="font:18px system-ui;max-width:34rem;margin:2rem auto;padding:1rem"><h1>HaniLog 로컬 인증서 설치</h1><p>본인 휴대폰에서만 설치하세요. 이 인증서는 이 PC의 로컬 HTTPS 개발 주소를 위한 것입니다.</p><section style="padding:1rem;background:#f4f7f3;border-radius:12px;margin:1rem 0"><h2>Android</h2><p><a style="display:inline-block;padding:1rem;background:#e4f1e7;border-radius:12px" href="/HaniLog-Local-RootCA.cer">Android 인증서 다운로드</a></p><p>다운로드한 뒤 설정의 보안/자격 증명 메뉴에서 CA 인증서로 설치하세요. 설치가 끝나면 아래 HaniLog 주소를 여세요.</p></section><section style="padding:1rem;background:#f4f7f3;border-radius:12px;margin:1rem 0"><h2>iPhone</h2><p><a style="display:inline-block;padding:1rem;background:#e4f1e7;border-radius:12px" href="/HaniLog-Local-RootCA.mobileconfig">iPhone 프로파일 다운로드</a></p><p>설정에서 프로파일을 설치한 뒤 인증서 전체 신뢰를 켜세요.</p></section><p><a href="https://' + lanHost + ':7344/">HaniLog 열기: https://' + lanHost + ':7344/</a></p></main>');
          return;
        }

        response.writeHead(404, { 'Cache-Control': 'no-store' });
        response.end('Not found');
      });
      profileServer.on('error', (error: NodeJS.ErrnoException) => {
        console.error(`HaniLog certificate download helper could not listen on port ${profilePort}: ${error.code ?? 'unknown error'}`);
      });
      server.httpServer?.once('close', () => profileServer.close());
      profileServer.listen(profilePort, '0.0.0.0');
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const devPort = getDevPort();
  const env = loadEnv(mode, process.cwd(), '');
  const basePath = env.PAGES_BASE_PATH?.trim();
  const base = basePath ? `/${basePath.replace(/^\/+|\/+$/g, '')}/` : '/';

  return {
    base,
    plugins: [
      ...(command === 'serve' && !mobileTlsReady ? [basicSsl()] : []),
      ...(command === 'serve' && mode !== 'test' ? [mobileCertificateDownload()] : []),
      react(),
      tailwindcss(),
      VitePWA({
        registerType: 'prompt',
        injectRegister: 'auto',
        includeAssets: ['paw.svg', 'push-handler.js'],
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
          importScripts: [`${base}push-handler.js`],
          globPatterns: ['**/*.{js,css,html,svg,ico,png,webmanifest}'],
          navigateFallback: 'index.html',
          runtimeCaching: [],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    ...(command === 'serve'
      ? { server: { host: '0.0.0.0', port: devPort, strictPort: true, https: mobileHttps } }
      : {}),
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      coverage: { reporter: ['text', 'html'] },
    },
  };
});
