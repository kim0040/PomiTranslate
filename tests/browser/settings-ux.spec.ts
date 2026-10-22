import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

async function settings(page: Page, parameters = '') {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=review&model=deepseek/deepseek-v4.1-flash${parameters}`);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
}
async function calls(page: Page, type: string) {
  return page.evaluate((kind) => (window as unknown as { __pomiRequests: { type: string }[] }).__pomiRequests.filter((request) => request.type === kind).length, type);
}

test('model lookup never saves drafts, keys or invalidates reviewed candidates', async ({ page }) => {
  await settings(page);
  await expect(page.getByText('모델 기본값: 켜짐 · 강하게 (high)', { exact: true })).toBeVisible();
  await page.locator('#target-language').fill('unsaved-language');
  await page.getByRole('button', { name: '키 변경', exact: true }).click();
  await page.locator('#api-key').fill('synthetic-unsaved-key');
  await page.getByRole('button', { name: '모델 목록 불러오기', exact: true }).click();
  await expect(page.locator('#target-language')).toHaveValue('unsaved-language');
  await expect(page.locator('#api-key')).toHaveValue('synthetic-unsaved-key');
  expect(await calls(page, 'settings.set')).toBe(0);
  expect(await calls(page, 'translate.start')).toBe(0);
  const publicRequests = await page.evaluate(() => (window as unknown as { __pomiRequests: { type: string; publicCatalog?: boolean }[] }).__pomiRequests.filter((request) => request.type === 'models.list'));
  expect(publicRequests.every((request) => request.publicCatalog === true)).toBe(true);
  await page.getByRole('button', { name: '변경 취소', exact: true }).click();
  await expect(page.locator('#target-language')).toHaveValue('한국어');
  await expect(page.locator('#api-key')).toHaveCount(0);
  // Nothing left to save: the save bar is gone, not a disabled button.
  await expect(page.locator('.action-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '저장', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await page.getByRole('button', { name: /^후보 검토/ }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '7');
});

test('authenticated model lookup requests key saving without committing other drafts', async ({ page }) => {
  await settings(page, '&missingKey=1');
  await page.locator('#provider').selectOption('openai');
  await expect(page.locator('#api-key')).toBeVisible();
  await page.locator('#api-key').fill('synthetic-unsaved-openai-key');
  await page.getByRole('button', { name: '모델 목록 불러오기', exact: true }).click();
  await expect(page.getByText('새 API 키는 먼저 저장해 주세요. 모델 조회는 저장된 키만 사용합니다.', { exact: true })).toBeVisible();
  expect(await calls(page, 'settings.set')).toBe(0);
});

test('metadata failure offers retry and keeps model default available', async ({ page }) => {
  await settings(page, '&modelError=1');
  await expect(page.getByText('모델 목록을 불러오지 못했습니다. 네트워크와 저장된 키를 확인한 뒤 다시 불러와 주세요.', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: '모델 기본값', exact: true })).toBeEnabled();
  await expect(page.getByRole('radio', { name: '직접 설정', exact: true })).toBeDisabled();
  const attempts = await calls(page, 'models.list');
  await page.waitForTimeout(800);
  expect(await calls(page, 'models.list')).toBe(attempts);
  await page.evaluate(() => history.replaceState({}, '', location.href.replace('&modelError=1', '')));
  await page.getByRole('button', { name: '모델 목록 불러오기', exact: true }).click();
  await expect(page.getByText('모델 기본값: 켜짐 · 강하게 (high)', { exact: true })).toBeVisible();
  expect(await calls(page, 'settings.set')).toBe(0);
});

test('cached support information is explicitly marked', async ({ page }) => {
  await settings(page, '&cachedModels=1');
  await expect(page.getByText(/저장된 목록입니다. 최신 조회에 실패/)).toBeVisible();
});

test('unknown models cannot acquire unsupported reasoning controls', async ({ page }) => {
  await settings(page);
  await page.getByRole('radio', { name: '직접 설정', exact: true }).check();
  await page.locator('#openrouter-reasoning').selectOption('max');
  await page.locator('#model').fill('unknown-model');
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
  await expect(page.getByRole('radio', { name: '직접 설정', exact: true })).toBeDisabled();
  await page.getByRole('radio', { name: '모델 기본값', exact: true }).check();
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
});

test('key management is explicit and changing storage mode remains a draft', async ({ page }) => {
  await settings(page);
  await expect(page.locator('#api-key')).toHaveCount(0);
  await expect(page.locator('#credential-mode')).not.toBeVisible();
  await page.locator('#key-management > summary').click();
  await page.locator('#credential-mode').selectOption('session');
  await expect(page.getByText('저장하지 않은 변경사항', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '변경 취소', exact: true }).click();
  await expect(page.locator('#credential-mode')).toHaveValue('local');
  await page.getByRole('button', { name: '저장된 키 삭제', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
  expect(await calls(page, 'credentials.delete')).toBe(0);
});

test('run preflight shows the saved reasoning choice and cost boundary', async ({ page }) => {
  await settings(page);
  await page.getByRole('radio', { name: '직접 설정', exact: true }).check();
  await page.locator('#openrouter-reasoning').selectOption('max');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByText('저장된 설정과 같습니다', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await page.getByRole('button', { name: /^번역 진행/ }).click();
  await expect(page.getByRole('definition').filter({ hasText: '직접 설정 · 최대 (max)' })).toBeVisible();
  await expect(page.getByText('추론 토큰과 재시도는 이 추정에 포함되지 않으며 실제 비용이 늘어날 수 있습니다.', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'output/playwright/reasoning-preflight.png', fullPage: true });
  expect(await calls(page, 'translate.start')).toBe(0);
});

test('reasoning modes support keyboard navigation and focus reaches supported efforts', async ({ page }) => {
  await settings(page);
  const initial = page.getByRole('radio', { name: '모델 기본값', exact: true });
  await expect(page.getByText('모델 기본값: 켜짐 · 강하게 (high)', { exact: true })).toBeVisible();
  await initial.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: '추론 끄기', exact: true })).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: '직접 설정', exact: true })).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(page.locator('#openrouter-reasoning')).toBeFocused();
  // macOS headless Chrome does not drive the OS popup menu. Its keyboard selection
  // is checked in the native app; this browser case proves radio navigation and focus.
  await page.locator('#openrouter-reasoning').selectOption('max');
  await expect(page.locator('#openrouter-reasoning')).toHaveValue('max');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/reasoning-settings-custom.png' });
});

for (const width of [1440, 840, 320]) {
  test(`settings save bar appears only with a change and stays reachable without covering fields at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 620 });
    await settings(page);
    await expect(page.getByText('모델 기본값: 켜짐 · 강하게 (high)', { exact: true })).toBeAttached();
    // Clean page: no save bar and no Save button at all.
    await expect(page.locator('.action-bar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '저장', exact: true })).toHaveCount(0);
    await page.locator('#model').fill('edited-model');
    const save = page.getByRole('button', { name: '저장', exact: true });
    await expect(save).toBeEnabled();
    await expect(save).toBeInViewport();
    await page.locator('#style-prompt').focus();
    const editor = await page.locator('#style-prompt').boundingBox();
    const bar = await page.locator('.action-bar').boundingBox();
    expect(editor!.y + editor!.height).toBeLessThanOrEqual(bar!.y);
    await page.evaluate(() => document.getElementById('main-content')!.scrollTo(0, 99999));
    await expect(save).toBeInViewport();
    expect(await save.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => document.getElementById('main-content')!.scrollTo(0, 0));
    await page.screenshot({ path: `output/playwright/settings-ux-${width}.png` });
    // Saving removes the bar again and leaves focus on something that is still there.
    await save.click();
    await expect(page.locator('.action-bar')).toHaveCount(0);
    await expect(page.locator('.section-nav a:focus')).toHaveCount(1);
  });
}
