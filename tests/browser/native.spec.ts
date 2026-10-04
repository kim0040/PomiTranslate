import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// Desktop behaviour driven through the same events the Tauri shell sends: menu commands, dropped
// folders, window chrome calls. The fixture records chrome calls instead of performing them.
async function boot(page: Page, scenario: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=${scenario}`);
  await expect(page.locator('.boot')).toHaveCount(0);
}
async function step(page: Page, name: string) {
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}
const emit = (page: Page, name: string, payload: unknown) => page.evaluate(([n, p]) => (window as any).__pomiEmit(n, p), [name, payload] as const);

test('review keeps the source column readable at the default window size with a row selected', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await boot(page, 'review');
  await step(page, '후보 검토');
  await page.locator('tr[data-index="1"]').click();
  await expect(page.locator('#manual-translation')).toBeVisible();
  for (const width of [1180, 1100, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    // Columns follow the measured table width, which settles one frame after the resize.
    await expect.poll(() => page.locator('td.c-source').first().evaluate((cell) => cell.getBoundingClientRect().width),
      { message: `source column at ${width}px` }).toBeGreaterThan(200);
    await expect(page.locator('td.c-source').first()).toContainText('Welcome to Roguefire');
  }
});

test('each screen opens at its top instead of keeping the previous scroll position', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 620 });
  await boot(page, 'result-success');
  await step(page, '번역 진행');
  await page.locator('#main-content').evaluate((pane) => pane.scrollTo({ top: pane.scrollHeight }));
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  const heading = page.getByRole('heading', { name: '번역 결과', exact: true });
  await expect(heading).toBeInViewport();
  expect(await page.locator('#main-content').evaluate((pane) => pane.scrollTop)).toBe(0);
});

test('menu commands open settings, open a world and focus search on review', async ({ page }) => {
  await boot(page, 'review');
  await emit(page, 'pomi-menu', 'settings');
  await expect(page.getByRole('heading', { name: '환경 설정', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__pomiDialogFiles = null; });
  await emit(page, 'pomi-menu', 'open-world');
  await expect(page.getByRole('navigation', { name: '작업 단계' })).toBeVisible();
  await step(page, '후보 검토');
  await emit(page, 'pomi-menu', 'find');
  await expect(page.locator('#review-search')).toBeFocused();
  const labels = await page.evaluate(() => ((window as any).__pomiChrome ?? []).filter((c: any) => c.command === 'set_menu_labels').at(-1)?.args.labels);
  expect(labels).toEqual({
    openWorld: '월드 열기…', settings: '설정…', find: '찾기…', help: 'PomiTranslate 도움말', tour: '시작 안내',
    shortcuts: '단축키', licenses: '오픈소스 라이선스', report: '문제 신고…', updates: '업데이트 확인…',
    appearance: '화면 모드', themeSystem: '시스템', themeLight: '라이트', themeDark: '다크'
  });
});

test('a folder dropped on the window opens as the selected world', async ({ page }) => {
  await boot(page, 'empty');
  await expect(page.getByRole('heading', { name: '번역할 월드를 선택해 주세요', exact: true })).toBeVisible();
  await emit(page, 'tauri://drag-enter', { paths: ['/tmp/world'] });
  await expect(page.getByText('월드 폴더를 놓아 열기', { exact: true })).toBeVisible();
  await emit(page, 'tauri://drag-drop', { paths: ['/private/tmp/pomi-eval/Roguefire/level.dat'] });
  await expect(page.getByText('월드 폴더를 놓아 열기', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '스캔 시작', exact: true })).toBeVisible();
  const inspected = await page.evaluate(() => (window as any).__pomiRequests.filter((r: any) => r.type === 'world.inspect').length);
  expect(inspected).toBe(1);
});

test('launcher worlds are listed with their icons and open on click', async ({ page }) => {
  await boot(page, 'selected');
  await step(page, '월드 선택');
  await expect(page.getByRole('heading', { name: 'Minecraft 월드', exact: true })).toBeVisible();
  const tile = page.getByRole('button', { name: /Skyblock Classic/ });
  await expect(tile).toBeVisible();
  await expect(page.locator('.tile img').first()).toHaveJSProperty('naturalWidth', 16);
  await tile.click();
  expect(await page.evaluate(() => (window as any).__pomiRequests.filter((r: any) => r.type === 'world.inspect').length)).toBe(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('window title and task progress follow the job', async ({ page }) => {
  await boot(page, 'run-progress');
  await step(page, '번역 진행');
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await expect(page.locator('.sidebar')).toContainText('번역 중');
  await expect.poll(() => page.evaluate(() => ((window as any).__pomiChrome ?? [])
    .filter((c: any) => c.command === 'plugin:window|set_title').map((c: any) => c.args.value).at(-1))).toContain('Roguefire');
  await expect.poll(() => page.evaluate(() => ((window as any).__pomiChrome ?? [])
    .filter((c: any) => c.command === 'plugin:window|set_progress_bar').map((c: any) => c.args.value?.progress ?? null).at(-1))).toBe(67);
});

test('labels are not selectable text but source text is', async ({ page }) => {
  await boot(page, 'review');
  await step(page, '후보 검토');
  const nav = await page.getByRole('button', { name: '환경 설정', exact: true }).evaluate((el) => getComputedStyle(el).userSelect);
  const source = await page.locator('td.c-source').first().evaluate((el) => getComputedStyle(el).userSelect);
  expect(nav).toBe('none');
  expect(source).not.toBe('none');
  expect(await page.locator('body').evaluate((el) => getComputedStyle(el).cursor)).toBe('default');
});
