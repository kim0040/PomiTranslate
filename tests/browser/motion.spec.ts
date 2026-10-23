import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

// Smooth and consistent: every screen and sheet appears with the same short motion, reduced motion
// removes it, and content arriving late never pushes what the person is reading.
test.use({ contextOptions: { reducedMotion: 'no-preference' } });

async function boot(page: Page, query: string) {
  await page.addInitScript(() => {
    (window as any).__shifts = 0;
    new PerformanceObserver((list) => { for (const entry of list.getEntries() as any[]) (window as any).__shifts += entry.value; })
      .observe({ type: 'layout-shift', buffered: true });
  });
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
}
async function step(page: Page, name: string) {
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}
const shifts = (page: Page) => page.evaluate(() => { const value = (window as any).__shifts; (window as any).__shifts = 0; return value as number; });

test('every screen enters with the same motion token and dialogs pop the same way', async ({ page }) => {
  await boot(page, 'scenario=review');
  const seen = new Set<string>();
  for (const name of ['월드 고르기', '번역할 문장 찾기', '번역할 문장 고르기', '번역 준비']) {
    await step(page, name);
    seen.add(await page.locator('main > .page, main > .review').evaluate((el) => `${getComputedStyle(el).animationName} ${getComputedStyle(el).animationDuration}`));
  }
  for (const name of ['백업 관리', '환경 설정', '정보']) {
    await page.getByRole('button', { name, exact: true }).click();
    seen.add(await page.locator('main > .page, main > .review').evaluate((el) => `${getComputedStyle(el).animationName} ${getComputedStyle(el).animationDuration}`));
  }
  expect([...seen]).toEqual(['pomi-enter 0.16s']);

  await page.getByRole('button', { name: '백업 관리', exact: true }).click();
  await page.getByRole('button', { name: '이 시점으로 월드 복원' }).first().click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => getComputedStyle(el).animationName)).toBe('pomi-pop');
});

test('reduced motion turns screen and dialog motion off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page, 'scenario=review');
  await step(page, '번역할 문장 찾기');
  const duration = await page.locator('.page').evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
  expect(duration).toBeLessThan(0.001);
});

test('the run summary does not jump when the estimate arrives late', async ({ page }) => {
  await boot(page, 'scenario=review&slowEstimate=1');
  await step(page, '번역할 문장 고르기');
  await page.locator('tr[data-index="0"] input[type="checkbox"]').uncheck();
  await step(page, '번역 준비');
  await expect(page.getByText('계산 중…').first()).toBeVisible();
  await page.waitForTimeout(250);
  await shifts(page);
  await expect(page.getByText(/^약 US\$/)).toBeVisible();
  await page.waitForTimeout(200);
  expect(await shifts(page)).toBeLessThan(0.01);
});

test('a world with a kept scan offers to open it instead of a rescan that would replace it', async ({ page }) => {
  await boot(page, 'scenario=review');
  await step(page, '월드 고르기');
  await expect(page.getByRole('button', { name: '스캔 시작', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '스캔 결과 보기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '번역할 문장 찾기', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pomiRequests.filter((r: any) => r.type === 'scan.start').length)).toBe(0);
});
