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
  await page.locator('#target-language').selectOption('English');
  await page.getByRole('button', { name: '키 변경', exact: true }).click();
  await page.locator('#api-key').fill('synthetic-unsaved-key');
  await page.getByRole('button', { name: '모델 목록 불러오기', exact: true }).click();
  await expect(page.locator('#target-language')).toHaveValue('English');
  await expect(page.locator('#api-key')).toHaveValue('synthetic-unsaved-key');
  expect(await calls(page, 'settings.set')).toBe(0);
  expect(await calls(page, 'translate.start')).toBe(0);
  // Without a typed key only the public catalog is read; the typed key goes out once, as a draft, and nowhere else.
  const lookups = await page.evaluate(() => (window as unknown as { __pomiRequests: { type: string; publicCatalog?: boolean; connectionCheck?: boolean; hasDraftKey?: boolean }[] }).__pomiRequests.filter((request) => request.type === 'models.list'));
  expect(lookups.filter((request) => !request.hasDraftKey).every((request) => request.publicCatalog === true)).toBe(true);
  expect(lookups.filter((request) => request.hasDraftKey).map((request) => request.connectionCheck)).toEqual([true]);
  const leaked = await page.evaluate(() => (window as unknown as { __pomiRequests: { type: string; hasApiKey?: boolean }[] }).__pomiRequests.filter((request) => request.type !== 'models.list' && request.hasApiKey));
  expect(leaked).toEqual([]);
  await page.getByRole('button', { name: '변경 취소', exact: true }).click();
  await expect(page.locator('#target-language')).toHaveValue('한국어');
  await expect(page.locator('#api-key')).toHaveCount(0);
  // Nothing is left to save, so the save bar is gone.
  await expect(page.locator('.save-bar')).toHaveCount(0);
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await page.getByRole('button', { name: /^후보 검토/ }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '7');
});

test('an authenticated model lookup works with a typed key that is not saved', async ({ page }) => {
  await settings(page, '&missingKey=1');
  await page.locator('#provider').selectOption('openai');
  await expect(page.locator('#api-key')).toBeVisible();
  // No key typed and none saved: the lookup says what is missing and asks nothing.
  await page.getByRole('button', { name: '모델 목록 불러오기', exact: true }).click();
  await expect(page.getByText('API 키를 입력하거나 저장한 뒤 목록을 불러올 수 있습니다.', { exact: true })).toBeVisible();
  expect(await calls(page, 'models.list')).toBe(0);
  await page.locator('#api-key').fill('synthetic-unsaved-openai-key');
  await page.getByRole('button', { name: '모델 목록 불러오기', exact: true }).click();
  await expect(page.getByText('모델 지원 정보 확인됨').or(page.getByText('이 ID를 모델 목록에서 찾지 못했습니다'))).toBeVisible();
  const draft = await page.evaluate(() => (window as unknown as { __pomiRequests: { type: string; provider?: string; hasDraftKey?: boolean }[] }).__pomiRequests.filter((request) => request.type === 'models.list'));
  expect(draft).toEqual([expect.objectContaining({ provider: 'openai', hasDraftKey: true, connectionCheck: true })]);
  await page.locator('#model').click();
  await expect(page.getByRole('option', { name: /GPT-5 Mini/ })).toBeVisible();
  expect(await calls(page, 'settings.set')).toBe(0);
  await expect(page.locator('#api-key')).toHaveValue('synthetic-unsaved-openai-key');
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
  await page.getByRole('button', { name: '키 관리 및 보안', exact: true }).click();
  await page.locator('#credential-mode').selectOption('session');
  await expect(page.getByText('번역 탭에 저장하지 않은 변경 1개', { exact: true })).toBeVisible();
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
  await expect(page.locator('.save-bar')).toHaveCount(0);
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
  test(`settings save bar stays reachable without covering fields at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 620 });
    await settings(page);
    await expect(page.getByText('모델 기본값: 켜짐 · 강하게 (high)', { exact: true })).toBeAttached();
    const save = page.getByRole('button', { name: '저장', exact: true });
    // The bar only exists once there is something to save.
    await expect(page.locator('.save-bar')).toHaveCount(0);
    await page.locator('#model').fill('edited-model');
    await expect(save).toBeEnabled();
    await expect(save).toBeInViewport();
    await page.locator('#style-prompt').focus();
    const editor = await page.locator('#style-prompt').boundingBox();
    const bar = await page.locator('.save-bar').boundingBox();
    expect(editor!.y + editor!.height).toBeLessThanOrEqual(bar!.y);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(save).toBeInViewport();
    expect(await save.evaluate((button) => {
      const box = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `output/playwright/settings-ux-${width}.png` });
  });
}
