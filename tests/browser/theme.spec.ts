import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// Light, dark and system: picked in Settings or View > Appearance, applied at once to the page, the
// native window and the menu tick, kept in the settings file, and in place before the first paint.
async function boot(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
}
const chrome = (page: Page, command: string) => page.evaluate((name) => ((window as any).__pomiChrome ?? [])
  .filter((call: any) => call.command === name).map((call: any) => call.args), command);
const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByRole('tab', { name: '앱' }).click();
  return page.locator('#application-settings');
}

test('settings switch light, dark and system at once and keep the choice', async ({ page }) => {
  await boot(page, 'scenario=selected');
  const section = await openAppearance(page);
  await expect(section.getByRole('radio', { name: '라이트' })).toBeChecked();

  await section.getByRole('radio', { name: '다크' }).check();
  expect(await theme(page)).toBe('dark');
  expect(await background(page)).toBe('rgb(18, 15, 11)');
  await expect.poll(() => page.evaluate(() => (window as any).__pomiPrefs?.theme)).toBe('dark');
  await expect.poll(async () => (await chrome(page, 'plugin:window|set_theme')).at(-1)?.value).toBe('dark');
  await expect.poll(async () => (await chrome(page, 'set_menu_theme')).at(-1)?.choice).toBe('dark');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#120f0b');
  await expect(page.locator('.save-bar')).toHaveCount(0); // nothing to save
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await section.getByRole('radio', { name: '라이트' }).check();
  expect(await theme(page)).toBe('light');
  expect(await background(page)).toBe('rgb(249, 248, 247)');
  await expect.poll(() => page.evaluate(() => (window as any).__pomiPrefs?.theme)).toBe('light');
});

test('system follows the operating system while the app is open', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await boot(page, 'scenario=selected');
  const section = await openAppearance(page);
  await section.getByRole('radio', { name: '시스템' }).check();
  await expect(section).toContainText('지금: 라이트');
  expect(await theme(page)).toBe('light');
  await expect.poll(async () => (await chrome(page, 'plugin:window|set_theme')).at(-1)?.value ?? null).toBeNull();

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => theme(page)).toBe('dark');
  await expect(section).toContainText('지금: 다크');
  await expect.poll(async () => (await chrome(page, 'plugin:window|set_background_color')).at(-1)?.value).toBe('#120f0b');

  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('light');
});

test('an explicit mode ignores the operating system', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await boot(page, 'scenario=selected&theme=light');
  expect(await theme(page)).toBe('light');
  await page.emulateMedia({ colorScheme: 'light' });
  await boot(page, 'scenario=selected&theme=dark');
  expect(await theme(page)).toBe('dark');
});

test('View > Appearance in the menu bar changes the mode and ticks the choice', async ({ page }) => {
  await boot(page, 'scenario=review');
  await page.evaluate(() => (window as any).__pomiEmit('pomi-menu', 'theme-dark'));
  await expect.poll(() => theme(page)).toBe('dark');
  await expect.poll(async () => (await chrome(page, 'set_menu_theme')).at(-1)?.choice).toBe('dark');
  const labels = await page.evaluate(() => ((window as any).__pomiChrome ?? []).filter((c: any) => c.command === 'set_menu_labels').at(-1)?.args.labels);
  expect(labels).toMatchObject({ appearance: '화면 모드', themeSystem: '시스템', themeLight: '라이트', themeDark: '다크' });
});

test('the saved mode is on the page before the app code runs, so a dark start never paints light', async ({ page }) => {
  await page.route('**/src/main.ts', (route) => route.abort());
  await page.addInitScript(() => localStorage.setItem('pomi.theme.v1', 'dark'));
  await page.goto('/');
  expect(await theme(page)).toBe('dark');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#120f0b');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => localStorage.removeItem('pomi.theme.v1'));
  await page.goto('/');
  expect(await theme(page)).toBe('dark');
});

test('every screen passes contrast checks in dark mode', async ({ page }) => {
  await boot(page, 'scenario=review&theme=dark');
  const step = (name: string) => page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
  for (const name of ['월드 고르기', '번역할 문장 찾기', '번역할 문장 고르기', '번역 준비']) {
    await step(name);
    expect((await new AxeBuilder({ page }).analyze()).violations, name).toEqual([]);
  }
  for (const name of ['백업 관리', '환경 설정', '도움말', '정보']) {
    await page.getByRole('button', { name, exact: true }).click();
    expect((await new AxeBuilder({ page }).analyze()).violations, name).toEqual([]);
  }
  await expect(page.locator('.dark-wordmark').first()).toBeVisible();
});
