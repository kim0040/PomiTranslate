import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

async function boot(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
}
async function step(page: Page, name: string) {
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

test('the bundled Pretendard face is what text is set in, and Japanese keeps its own stack', async ({ page }) => {
  await boot(page, 'scenario=selected');
  await page.evaluate(() => document.fonts.ready);
  const faces = await page.evaluate(async () => {
    await document.fonts.load('400 16px "Pomi Sans"', '한글 Aa');
    return {
      family: getComputedStyle(document.body).fontFamily,
      loaded: document.fonts.check('400 16px "Pomi Sans"', '한글 Aa'),
      status: [...document.fonts].filter((face) => face.family.includes('Pomi')).map((face) => face.status)
    };
  });
  expect(faces.family.startsWith('"Pomi Sans"')).toBe(true);
  expect(faces.loaded).toBe(true);
  // The file is served from the app itself: the packaged CSP only allows 'self'.
  const response = await page.request.get('/fonts/PretendardVariable.woff2');
  expect(response.ok()).toBe(true);
  expect(Number(response.headers()['content-length'] ?? 1)).toBeGreaterThan(1_000_000);

  await page.goto('/?scenario=selected&locale=ja');
  await expect(page.locator('.boot')).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily.startsWith('"Pomi Latin"'))).toBe(true);
});

test('the review table shows at least eight single-line rows at 840x620 and no empty band', async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 620 });
  await boot(page, 'scenario=review&count=300');
  await step(page, '후보 검토');
  await expect(page.locator('tr[data-index="0"]')).toBeVisible();
  const view = await page.locator('.viewport').boundingBox();
  expect(view).not.toBeNull();
  const rows = await page.locator('tr[data-index]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
  const inside = rows.filter((r) => r.top >= view!.y && r.bottom <= view!.y + view!.height + 1);
  expect(inside.length).toBeGreaterThanOrEqual(8);
  for (const r of rows) expect(r.height).toBeLessThanOrEqual(45);
  // Rows reach the bottom of the table: nothing blank between the last row and the footer.
  const lastBottom = Math.max(...rows.map((r) => r.bottom));
  expect(lastBottom).toBeGreaterThanOrEqual(view!.y + view!.height - 45);
});

test('the filters popover holds category and sort, counts what is applied, and Escape returns focus', async ({ page }) => {
  await boot(page, 'scenario=review&count=300');
  await step(page, '후보 검토');
  const trigger = page.getByRole('button', { name: /^필터(?! 초기화)/ });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const kinds = page.getByRole('group', { name: '텍스트 유형' });
  await expect(kinds).toBeVisible();
  await expect(page.locator('#review-sort')).toBeVisible();
  await kinds.getByRole('button', { name: /^표지판/ }).click();
  await expect(trigger).toContainText('적용 중');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // Pressing a chip refetches the list; focus must stay on the chip so Escape still finds the popover.
  await expect(kinds.getByRole('button', { name: /^표지판/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
});

test('the bulk actions live in a popover next to the primary button', async ({ page }) => {
  await boot(page, 'scenario=review');
  await step(page, '후보 검토');
  await page.getByRole('button', { name: '일괄 작업' }).click();
  await expect(page.getByRole('button', { name: '현재 표시된 항목 모두 제외' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '현재 표시된 항목 모두 제외' })).toHaveCount(0);
});

test('at the narrowest window the stepper reads "n/5단계 · name" and the page title is not repeated', async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 620 });
  await boot(page, 'scenario=review');
  await step(page, '후보 검토');
  await expect(page.getByRole('navigation', { name: '작업 단계' })).toContainText('3/5단계 · 후보 검토');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
});

test('a finished translation has one primary next action and a numbers strip', async ({ page }) => {
  await boot(page, 'scenario=result-success');
  await step(page, '번역 진행');
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await expect(page.getByRole('heading', { name: '번역 결과', exact: true })).toBeVisible();
  await expect(page.locator('main .btn-primary')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '월드 폴더 열기' })).toBeVisible();
  await expect(page.getByText('적용한 번역문', { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('the coverage list on the scan result is collapsed until asked for', async ({ page }) => {
  await boot(page, 'scenario=scanned');
  await step(page, '월드 스캔');
  const coverage = page.locator('details.coverage');
  await expect(coverage).toBeVisible();
  expect(await coverage.evaluate((el: HTMLDetailsElement) => el.open)).toBe(false);
  await coverage.locator('summary').click();
  expect(await coverage.evaluate((el: HTMLDetailsElement) => el.open)).toBe(true);
});

test('both themes keep their text and control contrast on the page, the cards and the active navigation item', async ({ page }) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await boot(page, `scenario=selected&theme=${scheme}`);
    const violations = (await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()).violations;
    expect(violations, scheme).toEqual([]);
  }
});
