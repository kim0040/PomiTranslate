import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// The settings screen: two parts ("번역" needs saving, "앱" applies at once), a section list for the part on
// screen that follows the scroll (a column beside the sections from 900px, a strip under the toolbar below), a
// save bar that exists only while there is something to save, and no horizontal overflow in any language,
// mode or zoom.
const TRANSLATION_SECTIONS = [
  ['provider-settings', 'AI 제공사'], ['translation-settings', '번역 언어·문체'], ['scope-section', '스캔 범위'],
  ['speed-settings', '속도·요청 한도'], ['manage-section', '설정 파일']
] as const;
const APP_SECTIONS = [
  ['application-settings', '화면·언어'], ['updates', '업데이트'], ['data-settings', '데이터'], ['reset-section', '초기화']
] as const;

const showApp = async (page: Page) => {
  await page.locator('[role="tab"]').filter({ hasText: /^(앱|App|アプリ)$/ }).click();
  await expect(page.locator('#settings-panel-app')).toBeVisible();
};
async function open(page: Page, query = '', part: 'translation' | 'app' = 'translation') {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=selected${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
  await page.evaluate(() => (window as any).__pomiEmit('pomi-menu', 'settings'));
  await expect(page.locator('.section-nav')).toBeVisible();
  if (part === 'app') await showApp(page);
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
  await expect(page.locator('.section-nav a')).toHaveCount(TRANSLATION_SECTIONS.length);
  for (const [id, label] of TRANSLATION_SECTIONS) {
    await expect(page.locator(`.section-nav a[href="#${id}"]`)).toHaveText(label);
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  // The app part's sections are not on the page until that part is chosen.
  for (const [id] of APP_SECTIONS) await expect(page.locator(`#${id}`)).toHaveCount(0);
  // One heading for the page: the toolbar does not repeat it.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(current(page)).toHaveCount(1);
  await expect(current(page)).toHaveText('AI 제공사');
  // The ids that menu commands and other tests rely on are still there.
  for (const id of ['scope-settings', 'settings-management', 'key-management', 'target-language', 'provider', 'model']) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  expect(await overflow(page)).toEqual({ page: 0, pane: 0 });
  await showApp(page);
  await expect(page.locator('.section-nav a')).toHaveCount(APP_SECTIONS.length);
  for (const [id, label] of APP_SECTIONS) {
    await expect(page.locator(`.section-nav a[href="#${id}"]`)).toHaveText(label);
    await expect(page.locator(`#${id}`)).toHaveCount(1);
  }
  await expect(page.locator('#ui-language')).toHaveCount(1);
  await expect(page.locator('#provider-settings')).toHaveCount(0);
  await expect(current(page)).toHaveText('화면·언어');
  await expect(page.locator('.danger-zone button.btn-danger')).toHaveCount(1);
  expect(await overflow(page)).toEqual({ page: 0, pane: 0 });
});

test('two parts: the tab list is accessible, arrow keys switch, and the app part has no save bar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const list = page.getByRole('tablist', { name: '설정 종류' });
  await expect(list.getByRole('tab')).toHaveText(['번역', '앱']);
  const translation = list.getByRole('tab', { name: '번역', exact: true });
  const app = list.getByRole('tab', { name: '앱', exact: true });
  await expect(translation).toHaveAttribute('aria-selected', 'true');
  await expect(translation).toHaveAttribute('aria-controls', 'settings-panel-translation');
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('번역');
  // Only the chosen tab is in the tab order; the arrows move to the other one and choose it.
  await expect(app).toHaveAttribute('tabindex', '-1');
  await translation.focus();
  await page.keyboard.press('ArrowRight');
  await expect(app).toBeFocused();
  await expect(app).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('앱');
  await expect(page.locator('#provider-settings')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '바로 적용됩니다' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(translation).toBeFocused();
  await page.keyboard.press('End');
  await expect(app).toBeFocused();
  await page.keyboard.press('Home');
  await expect(translation).toBeFocused();
  await expect(page.locator('#provider-settings')).toHaveCount(1);
  // The app part applies at once: changing the display language never raises the save bar.
  await app.click();
  await page.locator('#ui-language').selectOption('en');
  await expect(page.getByRole('tab', { name: 'App', exact: true })).toBeVisible();
  await expect(page.locator('.action-bar')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Applies at once' })).toBeVisible();
});

test('leaving the translation part with unsaved changes asks first, with the page-leave dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  const app = page.getByRole('tab', { name: '앱', exact: true });
  const translation = page.getByRole('tab', { name: '번역', exact: true });
  await page.locator('#target-language').fill('English');
  await expect(page.locator('.action-bar')).toBeVisible();
  await app.click();
  const dialog = page.getByRole('dialog', { name: '저장하지 않은 설정이 있습니다' });
  await expect(dialog).toBeVisible();
  // Keep editing: still on the translation part with the change.
  await dialog.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#target-language')).toHaveValue('English');
  await expect(translation).toHaveAttribute('aria-selected', 'true');
  // Arrow keys ask the same question; Escape is the safe answer, and focus stays on the chosen tab.
  await translation.focus();
  await page.keyboard.press('ArrowRight');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(translation).toBeFocused();
  await expect(page.locator('#target-language')).toHaveValue('English');
  // Discard and move: the draft is dropped, the app part is shown.
  await app.click();
  await dialog.getByRole('button', { name: '저장하지 않고 이동', exact: true }).click();
  await expect(app).toHaveAttribute('aria-selected', 'true');
  await expect(app).toBeFocused();
  await expect(page.locator('.action-bar')).toHaveCount(0);
  await translation.click();
  await expect(page.locator('#target-language')).toHaveValue('한국어');
  // Save and move: the change is committed first.
  await page.locator('#target-language').fill('English');
  await app.click();
  await dialog.getByRole('button', { name: '저장하고 이동', exact: true }).click();
  await expect(app).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => (window as any).__pomiRequests.filter((request: { type: string }) => request.type === 'settings.set').length)).toBe(1);
});

test('menu actions land on the right part', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await expect(page.getByRole('tab', { name: '번역', exact: true })).toHaveAttribute('aria-selected', 'true');
  // "Check for Updates…" lives in the app part, also when settings are already open.
  await page.evaluate(() => (window as any).__pomiEmit('pomi-menu', 'updates'));
  await expect(page.getByRole('tab', { name: '앱', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#updates')).toBeInViewport();
  // Coming back to settings from another page opens the translation part.
  await page.getByRole('button', { name: '정보', exact: true }).click();
  await page.evaluate(() => (window as any).__pomiEmit('pomi-menu', 'settings'));
  await expect(page.getByRole('tab', { name: '번역', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('scrolling moves the highlight and the last section wins at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await open(page);
  // The last sections can never reach the top of a pane that ends under them; the bottom rule covers those.
  for (const [id, label] of TRANSLATION_SECTIONS.slice(0, 2)) {
    await page.evaluate((target) => {
      const main = document.getElementById('main-content')!;
      main.scrollTop += document.getElementById(target)!.getBoundingClientRect().top - main.getBoundingClientRect().top - 24;
    }, id);
    await expect(current(page)).toHaveText(label);
  }
  await page.evaluate(() => document.getElementById('main-content')!.scrollTo(0, 99999));
  await expect(current(page)).toHaveText('설정 파일');
  await page.evaluate(() => document.getElementById('main-content')!.scrollTo(0, 0));
  await expect(current(page)).toHaveText('AI 제공사');
  // The app part has its own list, starting at its top.
  await showApp(page);
  await expect(current(page)).toHaveText('화면·언어');
  await page.evaluate(() => document.getElementById('main-content')!.scrollTo(0, 99999));
  await expect(current(page)).toHaveText('초기화');
});

test('the section list works from the keyboard, moves focus to the section and honours reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  await showApp(page);
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
  await page.locator('.section-nav a[href="#reset-section"]').click();
  await expect(current(page)).toHaveText('초기화');
  // A collapsed section opens when it is chosen.
  await page.getByRole('tab', { name: '번역', exact: true }).click();
  await page.locator('.section-nav a[href="#scope-section"]').click();
  await expect(page.locator('#scope-settings')).toHaveJSProperty('open', true);
  await expect(current(page)).toHaveText('스캔 범위');
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
  const strip = page.locator('.nav-column');
  expect(await page.locator('.section-nav').evaluate((nav) => getComputedStyle(nav.querySelector('ul')!).flexDirection)).toBe('row');
  await expect(page.locator('.section-nav a')).toHaveCount(TRANSLATION_SECTIONS.length);
  // The two parts and the section list stay at the top of the pane while the sections scroll under them.
  await page.evaluate(() => document.getElementById('main-content')!.scrollTo(0, 900));
  const main = (await page.locator('#main-content').boundingBox())!;
  const pinned = (await strip.boundingBox())!;
  expect(Math.abs(pinned.y - main.y)).toBeLessThan(2);
  await expect(page.getByRole('tab', { name: '앱', exact: true })).toBeInViewport();
  await showApp(page);
  await expect(page.locator('.section-nav a')).toHaveCount(APP_SECTIONS.length);
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
        // The app part, with its own sections open.
        await showApp(page);
        await page.evaluate(() => document.querySelectorAll('main details').forEach((details) => ((details as HTMLDetailsElement).open = true)));
        expect(await overflow(page)).toEqual({ page: 0, pane: 0 });
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        // Back in the translation part with a change: the save bar covers the bottom of the pane.
        await page.locator('[role="tab"]').first().click();
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
    await open(page, `&theme=${theme}`, 'app');
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
