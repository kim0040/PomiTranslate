import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// The settings screen: a section list that follows the scroll (a column beside the sections from 900px,
// a strip under the toolbar below), a save bar that exists only while there is something to save, and
// no horizontal overflow in any language, mode or zoom.
const SECTIONS = [
  ['provider-settings', 'AI 제공사'], ['translation-settings', '번역 언어·문체'], ['scope-section', '스캔 범위'],
  ['speed-settings', '속도·요청 한도'], ['application-settings', '화면·언어'], ['manage-section', '설정 파일'],
  ['updates', '업데이트'], ['data-settings', '데이터'], ['reset-section', '초기화']
] as const;

async function open(page: Page, query = '') {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=selected${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
  await page.evaluate(() => (window as any).__pomiEmit('pomi-menu', 'settings'));
  await expect(page.locator('.section-nav')).toBeVisible();
}
const current = (page: Page) => page.locator('.section-nav a[aria-current="true"]');
const overflow = (page: Page) => page.evaluate(() => {
  const main = document.getElementById('main-content')!;
  return { page: document.documentElement.scrollWidth - innerWidth, pane: main.scrollWidth - main.clientWidth };
});
const paneTop = (page: Page, id: string) => page.evaluate((target) => {
  const main = document.getElementById('main-content')!;
  return document.getElementById(target)!.getBoundingClientRect().top - main.getBoundingClientRect().top;
}, id);

test('wide window: a section list beside sections that keep a readable width', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const nav = (await page.locator('.section-nav').boundingBox())!;
  const form = (await page.locator('#settings-form').boundingBox())!;
  expect(nav.x + nav.width).toBeLessThanOrEqual(form.x);
  expect(nav.width).toBeLessThanOrEqual(200);
  expect(form.width).toBeLessThanOrEqual(721);
  await expect(page.locator('.section-nav a')).toHaveCount(SECTIONS.length);
  for (const [id, label] of SECTIONS) {
    await expect(page.locator(`.section-nav a[href="#${id}"]`)).toHaveText(label);
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  // One heading for the page: the toolbar does not repeat it.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(current(page)).toHaveCount(1);
  await expect(current(page)).toHaveText('AI 제공사');
  // The ids that menu commands and other tests rely on are still there.
  for (const id of ['application-settings', 'scope-settings', 'settings-management', 'key-management', 'ui-language', 'target-language', 'provider', 'model']) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  await expect(page.locator('.danger-zone button.btn-danger')).toHaveCount(1);
  expect(await overflow(page)).toEqual({ page: 0, pane: 0 });
});

test('scrolling moves the highlight and the last section wins at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  // The last sections can never reach the top of a pane that ends under them; the bottom rule covers those.
  for (const [id, label] of SECTIONS.slice(0, 6)) {
    await page.evaluate((target) => {
      const main = document.getElementById('main-content')!;
      main.scrollTop += document.getElementById(target)!.getBoundingClientRect().top - main.getBoundingClientRect().top - 24;
    }, id);
    await expect(current(page)).toHaveText(label);
  }
  await page.evaluate(() => document.getElementById('main-content')!.scrollTo(0, 99999));
  await expect(current(page)).toHaveText('초기화');
  await page.evaluate(() => document.getElementById('main-content')!.scrollTo(0, 0));
  await expect(current(page)).toHaveText('AI 제공사');
});

test('the section list works from the keyboard, moves focus to the section and honours reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const link = page.locator('.section-nav a[href="#updates"]');
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  // Reduced motion: the move is immediate, and the section is where it was asked to be.
  await expect.poll(() => paneTop(page, 'updates')).toBeLessThan(40);
  await expect(page.locator('#updates')).toBeFocused();
  await expect(current(page)).toHaveText('업데이트');
  expect(await page.evaluate(() => location.hash)).toBe('');
  // Tab continues from the section into its own content, not back at the top of the page.
  await page.keyboard.press('Tab');
  await expect(page.locator('#updates button').first()).toBeFocused();
  // A collapsed section opens when it is chosen.
  await page.locator('.section-nav a[href="#scope-section"]').click();
  await expect(page.locator('#scope-settings')).toHaveJSProperty('open', true);
  await expect(current(page)).toHaveText('스캔 범위');
  await page.locator('.section-nav a[href="#reset-section"]').click();
  await expect(current(page)).toHaveText('초기화');
});

test('save bar exists only while something is unsaved; Enter on a clean page saves nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await expect(page.locator('.action-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '저장', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '저장된 설정과 같습니다' })).toBeVisible();
  await page.locator('#target-language').focus();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as any).__pomiRequests.filter((request: { type: string }) => request.type === 'settings.set').length)).toBe(0);
  await page.locator('#target-language').fill('English');
  await expect(page.locator('.action-bar')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '저장하지 않은 변경사항' })).toBeVisible();
  // The bar is pinned to the bottom edge of the pane.
  const bar = (await page.locator('.action-bar').boundingBox())!;
  expect(bar.y + bar.height).toBeGreaterThan(780);
  await expect(page.getByRole('button', { name: '변경 취소', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '변경 취소', exact: true }).click();
  await expect(page.locator('.action-bar')).toHaveCount(0);
  await expect(page.locator('#target-language')).toHaveValue('한국어');
  await expect(page.locator('.section-nav a:focus')).toHaveCount(1);
  // Leaving with a change still asks first.
  await page.locator('#target-language').fill('English');
  await page.getByRole('button', { name: '백업 관리', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '저장하지 않은 설정이 있습니다' })).toBeVisible();
});

test('narrow window: the section list is a pinned strip and nothing is lost', async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 620 });
  await open(page);
  const strip = page.locator('.section-nav');
  expect(await strip.evaluate((nav) => getComputedStyle(nav.querySelector('ul')!).flexDirection)).toBe('row');
  await expect(page.locator('.section-nav a')).toHaveCount(SECTIONS.length);
  // The strip stays at the top of the pane while the sections scroll under it.
  await page.evaluate(() => document.getElementById('main-content')!.scrollTo(0, 900));
  const main = (await page.locator('#main-content').boundingBox())!;
  const pinned = (await strip.boundingBox())!;
  expect(Math.abs(pinned.y - main.y)).toBeLessThan(2);
  await page.locator('.section-nav a[href="#data-settings"]').click();
  await expect(current(page)).toHaveText('데이터');
  await expect.poll(() => paneTop(page, 'data-settings')).toBeGreaterThan(pinned.height - 2);
  await expect(page.locator('#data-settings')).toBeInViewport();
  expect(await overflow(page)).toEqual({ page: 0, pane: 0 });
});

for (const locale of ['ko', 'en', 'ja']) {
  for (const theme of ['light', 'dark']) {
    for (const [width, height, scale] of [[1600, 1000, 1], [1280, 800, 1], [840, 620, 1], [640, 400, 2]] as const) {
      test(`${locale} ${theme} ${width}x${height}@${scale}: nothing overflows and axe finds nothing`, async ({ browser }) => {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce', colorScheme: theme });
        const page = await context.newPage();
        await open(page, `&locale=${locale}&theme=${theme}`);
        expect(await overflow(page)).toEqual({ page: 0, pane: 0 });
        // Every collapsible section open, the longest state of the page.
        await page.evaluate(() => document.querySelectorAll('main details').forEach((details) => ((details as HTMLDetailsElement).open = true)));
        expect(await overflow(page)).toEqual({ page: 0, pane: 0 });
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await page.locator('#target-language').fill('x');
        expect(await overflow(page)).toEqual({ page: 0, pane: 0 });
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await context.close();
      });
    }
  }
}

for (const theme of ['light', 'dark']) {
  test(`${theme}: the mode previews keep their own colours on neutral surfaces`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', colorScheme: theme as 'light' | 'dark' });
    const page = await context.newPage();
    await open(page, `&theme=${theme}`);
    const colours = await page.evaluate(() => ({
      light: getComputedStyle(document.querySelector('.preview.light .mini.light')!).backgroundColor,
      dark: getComputedStyle(document.querySelector('.preview.dark .mini.dark')!).backgroundColor
    }));
    expect(colours).toEqual({ light: 'rgb(250, 250, 250)', dark: 'rgb(23, 24, 28)' });
    // The selected tile says so with a mark, not by colour alone.
    await expect(page.locator('.theme-option.selected .name svg')).toHaveCount(1);
    await context.close();
  });
}
