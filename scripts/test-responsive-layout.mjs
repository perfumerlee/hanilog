import assert from 'node:assert/strict';
import { log } from 'node:console';
import { mkdirSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { env } from 'node:process';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const browserCandidates = [
  env.HANILOG_CHROMIUM_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const executablePath = browserCandidates.find((candidate) => existsSync(candidate));
assert.ok(executablePath, 'Set HANILOG_CHROMIUM_PATH to an installed Chrome or Edge executable.');

const screenshotsDir = resolve('test-results/responsive-layout');
mkdirSync(screenshotsDir, { recursive: true });
const server = await createServer({
  mode: 'demo',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 4176, strictPort: true },
});
let browser;

try {
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object', 'Vite test server did not start.');
  const origin = `https://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const viewports = [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 600, height: 900 },
    { width: 768, height: 1024 },
    { width: 820, height: 1180 },
    { width: 899, height: 900 },
    { width: 900, height: 820 },
    { width: 1024, height: 768 },
    { width: 1180, height: 820 },
    { width: 1200, height: 800 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ];
  const routes = ['/', '/?profile=1', '/record', '/trends', '/timeline', '/care', '/shared', '/notifications'];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(`${origin}/#${route}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.workspace-layout').waitFor();
      await page.locator('.workspace-content main').waitFor();
      const metrics = await page.evaluate(() => {
        const doc = globalThis.document;
        const win = globalThis.window;
        const nav = doc.querySelector('.app-nav');
        const content = doc.querySelector('.workspace-content');
        const navRect = nav.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const styles = win.getComputedStyle(nav);
        return {
          viewportWidth: win.innerWidth,
          documentWidth: doc.documentElement.scrollWidth,
          navPosition: styles.position,
          navWidth: navRect.width,
          navRight: navRect.right,
          navTop: navRect.top,
          contentLeft: contentRect.left,
          contentWidth: contentRect.width,
          desktopMoreVisible: win.getComputedStyle(doc.querySelector('.nav-more-toggle')).display !== 'none',
          mobileVisiblePrimaryLinks: [...doc.querySelectorAll('.nav-primary > .nav-item')]
            .filter((item) => item.checkVisibility()).length,
          visibleSecondaryLinks: win.getComputedStyle(doc.querySelector('.nav-secondary')).display === 'none'
            ? 0 : [...doc.querySelectorAll('.nav-secondary .nav-item')].filter((item) => item.checkVisibility()).length,
        };
      });

      assert.ok(metrics.documentWidth <= metrics.viewportWidth,
        `Horizontal overflow at ${viewport.width}x${viewport.height} on ${route}: ${JSON.stringify(metrics)}`);
      if (viewport.width >= 900) {
        assert.equal(metrics.navPosition, 'sticky', `Desktop sidebar must participate in layout on ${route}.`);
        assert.ok(metrics.navWidth >= 220 && metrics.navWidth <= 240,
          `Desktop sidebar width outside 220-240px on ${route}: ${metrics.navWidth}`);
        assert.ok(metrics.navRight <= metrics.contentLeft,
          `Sidebar overlaps content at ${viewport.width}px on ${route}: ${JSON.stringify(metrics)}`);
        assert.equal(metrics.desktopMoreVisible, false, 'Desktop must show the full route navigation, not the mobile More control.');
        assert.equal(metrics.visibleSecondaryLinks, 0, 'Mobile secondary routes must be hidden behind the desktop route list.');
      } else {
        assert.equal(metrics.navPosition, 'fixed', `Mobile/tablet navigation should be the bottom bar on ${route}.`);
        assert.equal(metrics.mobileVisiblePrimaryLinks, 2, 'Mobile must expose Blood Glucose and the centered Quick Record route.');
        assert.equal(metrics.visibleSecondaryLinks, 0, 'Secondary mobile routes must stay inside the closed More menu.');
        assert.ok(metrics.navTop >= viewport.height - 100, `Mobile bottom navigation expanded unexpectedly: ${JSON.stringify(metrics)}`);
      }

      if ([375, 1440].includes(viewport.width) && ['/', '/record', '/timeline', '/trends', '/shared', '/notifications', '/care'].includes(route)) {
        const routeName = route === '/' ? 'home' : route.slice(1);
        await page.screenshot({ path: resolve(screenshotsDir, `${viewport.width}x${viewport.height}-${routeName}.png`), fullPage: false });
      }

      if (route === '/trends' && [375, 390, 430, 768, 820, 1024, 1180, 1440].includes(viewport.width)) {
        await page.getByRole('button', { name: '기간 추세' }).click();
        await page.getByRole('button', { name: '90일' }).click();
        const chart = page.locator('.glucose-chart');
        assert.ok(await page.locator('.chart-point').count() >= 80, '90-day Demo chart should retain the actual dense measurement samples.');
        assert.ok(await page.locator('.actual-series-line').count() > 0, 'Actual measurements should be joined in measured segments.');
        const pathGeometry = await page.locator('.actual-series-line').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('d')));
        assert.ok(pathGeometry.some((path) => path?.includes('C')), 'Measured series should use curves only between actual measurements.');
        const geometryMatches = await chart.evaluate((svg) => {
          const pointPairs = new Set([...svg.querySelectorAll('.chart-point')].map((point) => `${point.getAttribute('cx')},${point.getAttribute('cy')}`));
          return [...svg.querySelectorAll('.actual-series-line')].every((path) => {
            const commands = (path.getAttribute('d') ?? '').match(/[MCL][^MCL]*/g) ?? [];
            for (const command of commands) {
              const numbers = command.slice(1).trim().split(/\s+/).map(Number);
              const point = `${numbers.at(-2)},${numbers.at(-1)}`;
              if (!pointPairs.has(point)) return false;
            }
            return true;
          });
        });
        assert.equal(geometryMatches, true, 'Every curve endpoint must exactly pass through an actual measurement point.');
        await page.screenshot({ path: resolve(screenshotsDir, `${viewport.width}x${viewport.height}-trends-default.png`), fullPage: false });
        const selectedPoint = page.locator('.chart-point').last();
        const expectedValue = await selectedPoint.evaluate((node) => node.parentElement?.querySelector('title')?.textContent?.match(/([\d.]+) mg\/dL/)?.[1]);
        await selectedPoint.click();
        await page.waitForFunction((value) => globalThis.document.querySelector('.sample-detail .share-selected-value strong')?.textContent?.includes(`${value} mg/dL`), expectedValue);
        assert.ok(await chart.evaluate((node) => node.getBoundingClientRect().width > 0), 'The chart must remain visible at the target viewport.');
        assert.equal(await page.getByRole('checkbox', { name: '계산 추세 보기' }).count(), 0,
          'The primary Health Trends view no longer exposes calculated-trend controls.');
      }

      if (route === '/?profile=1') {
        const file = `${viewport.width}x${viewport.height}-profile.png`;
        await page.screenshot({ path: resolve(screenshotsDir, file), fullPage: true });
        if ([375, 390, 430, 768, 820, 1024, 1180, 1440].includes(viewport.width)) {
          await page.locator('.profile-editor summary').click();
          assert.equal(await page.locator('.avatar-grid button').count(), 32);
          await page.getByLabel('특징으로 찾기').selectOption('짝귀');
          assert.equal(await page.locator('.avatar-grid button').count(), 8);
          await page.locator('.avatar-grid button').first().click();
          assert.equal(await page.locator('.avatar-grid button[aria-pressed=true]').count(), 1);
          await page.getByLabel('아바타 검색').fill('없는특징');
          assert.equal(await page.locator('.avatar-grid button').count(), 0);
          await page.getByLabel('아바타 검색').fill('');
          const syntheticPng = await page.evaluate(() => {
            const canvas = globalThis.document.createElement('canvas'); canvas.width = 160; canvas.height = 100;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = '#9eb08e'; ctx.fillRect(0, 0, 160, 100);
            ctx.fillStyle = '#faf5e8'; ctx.fillRect(35, 20, 70, 60);
            return canvas.toDataURL('image/png').split(',')[1];
          });
          await page.getByLabel('사진 파일 선택').setInputFiles({ name: 'synthetic-profile.png', mimeType: 'image/png', buffer: Buffer.from(syntheticPng, 'base64') });
          await page.getByRole('button', { name: '미리보기에 적용', exact: true }).click();
          await page.waitForFunction(() => globalThis.document.querySelector('.profile-portrait')?.getAttribute('src')?.startsWith('blob:'));
          assert.ok((await page.locator('.profile-portrait').getAttribute('src')).startsWith('blob:'),
            'Demo photo preview stays temporary and is not persisted.');
          await page.evaluate(() => globalThis.scrollTo(0, 0));
          await page.screenshot({ path: resolve(screenshotsDir, `${viewport.width}-profile-editor.png`), fullPage: true });
          await page.screenshot({ path: resolve(screenshotsDir, `${viewport.width}-profile-viewport.png`) });
          await page.getByRole('button', { name: '변경 취소' }).click();
          assert.ok((await page.locator('.profile-portrait').getAttribute('src')).endsWith('dog-1.svg'),
            'Cancelling an avatar preview restores the existing default avatar.');
          await page.locator('.profile-editor summary').focus();
          await page.keyboard.press('Enter');
          assert.equal(await page.locator('.profile-editor').getAttribute('open'), null);
          assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth));
          log(`PASS profile selection, filter, photo, cancellation, reset, keyboard ${viewport.width}px`);
        }
      }
    }

    if (viewport.width < 900) {
      await page.goto(`${origin}/#/`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: '더 보기' }).click();
      assert.equal(await page.locator('.nav-secondary .nav-item:visible').count(), 4,
        'More must reveal Profile, Timeline, Shared Care and Notifications routes.');
      await page.locator('.nav-secondary a[href="#/timeline"]').click();
      await page.waitForURL('**/#/timeline');
      await page.waitForFunction(() => globalThis.document.querySelector('.nav-more-toggle')?.getAttribute('aria-expanded') === 'false');
      assert.equal(await page.getByRole('button', { name: '더 보기' }).getAttribute('aria-expanded'), 'false',
        'Route changes must close the mobile More menu.');
    }

    if (viewport.width >= 900) {
      await page.goto(`${origin}/#/`, { waitUntil: 'domcontentloaded' });
      assert.equal(await page.locator('.app-nav .nav-item:visible').count(), 6,
        'Desktop sidebar must expose every supported route.');
      assert.deepEqual(await page.locator('.nav-desktop-list .nav-item:visible').allTextContents(),
        ['혈당 기록', '◷하루 타임라인', '+빠른 기록', '🐾반려동물 설정', '♡가족 공간과 보호자', '♧알림 및 전달 설정'],
        'Desktop sidebar order must match the caregiver workflow.');
      await page.goto(`${origin}/#/record`, { waitUntil: 'domcontentloaded' });
      const quickRecordColors = await page.locator('.nav-desktop-list .nav-record').evaluate((node) => ({
        text: globalThis.window.getComputedStyle(node).color,
        background: globalThis.window.getComputedStyle(node).backgroundColor,
      }));
      assert.equal(quickRecordColors.text, 'rgb(255, 255, 255)',
        `Active desktop Quick Record must stay readable: ${JSON.stringify(quickRecordColors)}`);
    }
    log(`PASS layout ${viewport.width}x${viewport.height}`);
  }

  await context.close();
} finally {
  if (browser) await browser.close();
  await server.close();
}

log(`Screenshots saved to ${screenshotsDir}`);
