import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

async function review(page: Page) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto('/?scenario=review');
  await page.getByRole('button', { name: /^후보 검토/ }).click();
  await expect(page.locator('tr[data-index="0"]')).toBeVisible();
}

for (const viewport of [
  { width: 1180, height: 800 }, { width: 1024, height: 768 },
  { width: 840, height: 620 }, { width: 800, height: 1000 },
  { width: 1180, height: 500 }
]) {
  test(`review detail and footer remain usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await review(page);
    await page.locator('tr[data-index="0"]').focus();
    await page.keyboard.press('Enter');
    const editor = page.locator('#manual-translation');
    await expect(editor).toBeFocused();
    await editor.fill('원문을 직접 검토한 번역문입니다. 긴 문장도 입력할 수 있어야 합니다.');
    expect(await editor.evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(200);
    if (await page.getByRole('dialog').count()) await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '번역 진행 단계로 이동' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '번역 진행', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `output/playwright/run-${viewport.width}x${viewport.height}.png`, fullPage: true });
  });
}

test('continuous resize across sidebar and detail breakpoints preserves draft and focus', async ({ page }) => {
  await review(page);
  await page.locator('tr[data-index="0"]').click();
  const editor = page.locator('#manual-translation');
  await editor.fill('Continuous resize draft');
  await editor.focus();
  for (const width of [1440, 1180, 1101, 1100, 1099, 1024, 841, 840, 839, 800, 600, 521, 520, 519, 400, 320, 519, 840, 1099, 1100, 1440]) {
    await page.setViewportSize({ width, height: width < 600 ? 568 : 620 });
    await expect(editor).toHaveValue('Continuous resize draft');
    await expect(editor).toBeFocused();
    await expect(editor).toBeVisible();
    await expect.poll(() => editor.evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThan(180);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
});

for (const locale of ['en', 'ja']) {
  test(`${locale} review and settings fit a short narrow window in dark mode`, async ({ page }) => {
    await review(page);
    await page.getByRole('button', { name: '환경 설정', exact: true }).click();
    await page.getByRole('tab', { name: '앱' }).click();
    await page.locator('#application-settings').getByRole('radio', { name: '다크' }).check();
    // The display language applies at once, like the appearance: no Save step.
    await page.locator('#ui-language').selectOption(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await page.setViewportSize({ width: 840, height: 480 });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `output/playwright/settings-${locale}-dark-840.png`, fullPage: true });
    await page.getByRole('button', { name: locale === 'en' ? 'Translate' : '翻訳作業', exact: true }).click();
    await expect(page.getByRole('grid')).toBeVisible();
    await page.locator('tr[data-index="0"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#manual-translation')).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `output/playwright/review-${locale}-dark-840.png`, fullPage: true });
  });
}
