import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// The settings screen layout. Since the 2026-10-24 merge the screen has four tabs (번역, 스캔 범위, 고급, 앱;
// settings-tabs.spec covers the tabs themselves). What this file keeps from the earlier two-part layout: a save
// bar that exists only while there is something to save, an Enter key that never saves a clean page, and no
// horizontal overflow or axe finding in any language, mode or zoom, with every section open.
async function open(page: Page, query = '') {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=selected${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
  await page.evaluate(() => (window as any).__pomiEmit('pomi-menu', 'settings'));
  await expect(page.getByRole('tablist')).toBeVisible();
}
const overflow = (page: Page) => page.evaluate(() => {
  const main = document.getElementById('main-content')!;
  return { page: document.documentElement.scrollWidth - innerWidth, pane: main.scrollWidth - main.clientWidth };
});
const settingsSaves = (page: Page) => page.evaluate(() => (window as any).__pomiRequests.filter((request: { type: string }) => request.type === 'settings.set').length);
/** Open every closed section of the tab on screen: the longest state of the page. */
async function openAll(page: Page) {
  for (;;) {
    const closed = page.locator('main .disclosure .toggle[aria-expanded="false"]:visible');
    if ((await closed.count()) === 0) return;
    await closed.first().click();
  }
}

test('save bar exists only while something is unsaved; Enter on a clean page saves nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await expect(page.locator('.save-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '저장', exact: true })).toHaveCount(0);
  await page.locator('#target-language').focus();
  await page.keyboard.press('Enter');
  expect(await settingsSaves(page)).toBe(0);
  await page.locator('#target-language').selectOption('English');
  await expect(page.locator('.save-bar')).toBeVisible();
  // The bar is pinned to the bottom edge of the pane.
  const bar = (await page.locator('.save-bar').boundingBox())!;
  expect(bar.y + bar.height).toBeGreaterThan(780);
  await expect(page.getByRole('button', { name: '변경 취소', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '변경 취소', exact: true }).click();
  await expect(page.locator('.save-bar')).toHaveCount(0);
  await expect(page.locator('#target-language')).toHaveValue('한국어');
  // Focus is not lost with the bar that held it.
  expect(await page.evaluate(() => !!document.activeElement && document.activeElement !== document.body)).toBe(true);
  // Leaving with a change still asks first.
  await page.locator('#target-language').selectOption('English');
  await page.getByRole('button', { name: '백업 관리', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '저장하지 않은 설정이 있습니다' })).toBeVisible();
  expect(await settingsSaves(page)).toBe(0);
});

for (const locale of ['ko', 'en', 'ja']) {
  for (const theme of ['light', 'dark'] as const) {
    for (const [width, height, scale] of [[1280, 800, 1], [640, 400, 2]] as const) {
      test(`${locale} ${theme} ${width}x${height}@${scale}: no tab overflows and axe finds nothing`, async ({ browser }) => {
        test.setTimeout(90_000);
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce', colorScheme: theme });
        const page = await context.newPage();
        await open(page, `&locale=${locale}&theme=${theme}`);
        const tabs = page.getByRole('tab');
        const count = await tabs.count();
        expect(count).toBe(4);
        for (let index = 0; index < count; index++) {
          await tabs.nth(index).click();
          await openAll(page);
          expect(await overflow(page), `tab ${index}`).toEqual({ page: 0, pane: 0 });
          expect((await new AxeBuilder({ page }).analyze()).violations, `tab ${index}`).toEqual([]);
        }
        // Back on the first tab with a change: the save bar covers the bottom of the pane.
        await tabs.first().click();
        const select = page.locator('#target-language');
        const value = await select.inputValue();
        const other = await select.locator('option').evaluateAll((options, current) => options.map((option) => (option as HTMLOptionElement).value).find((item) => item && item !== current), value);
        await select.selectOption(other!);
        await expect(page.locator('.save-bar')).toBeVisible();
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
    await page.getByRole('tab', { name: '앱', exact: true }).click();
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
