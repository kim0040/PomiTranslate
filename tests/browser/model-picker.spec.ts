import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

async function settings(page: Page, parameters = '', loaded = true) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=review&model=google/gemini-2.5-flash-lite${parameters}`);
  await page.getByRole('button', { name: parameters.includes('locale=en') ? 'Settings' : '환경 설정', exact: true }).click();
  // The public catalog of OpenRouter loads by itself.
  if (loaded) await expect(page.getByText(parameters.includes('locale=en') ? 'Model support information verified' : '모델 지원 정보 확인됨')).toBeVisible();
}
const saves = (page: Page) => page.evaluate(() => (window as unknown as { __pomiSettingsSaves: Record<string, unknown>[] }).__pomiSettingsSaves);

test('the model is a combobox with recommended and all groups, prices, context and reasoning', async ({ page }) => {
  await settings(page);
  const model = page.locator('#model');
  await expect(model).toHaveAttribute('role', 'combobox');
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('datalist')).toHaveCount(0);
  await model.click();
  await expect(model).toHaveAttribute('aria-expanded', 'true');
  const list = page.getByRole('listbox', { name: '모델 목록' });
  await expect(list).toBeVisible();
  await expect(list.getByText('추천', { exact: true })).toBeVisible();
  await expect(list.getByText('전체', { exact: true })).toBeVisible();
  // Recommended: the cheapest fast text models first, five at most.
  const options = list.getByRole('option');
  await expect(options.first()).toContainText('Gemini 2.5 Flash Lite');
  await expect(options.first()).toContainText('google/gemini-2.5-flash-lite');
  await expect(options.first()).toContainText('US$0.10 / US$0.40');
  await expect(options.first()).toContainText('1M');
  await expect(options.nth(1)).toContainText('GPT-5 Mini');
  await expect(options.nth(1)).toContainText('추론');
  await expect(options.nth(1)).toContainText('400K');
  await expect(options.nth(2)).toContainText('Claude Haiku 4.5');
  // The selected one is marked.
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/model-picker-open.png' });
});

test('search narrows the list, and the keyboard chooses', async ({ page }) => {
  await settings(page);
  const model = page.locator('#model');
  await model.fill('haiku');
  const options = page.getByRole('listbox', { name: '모델 목록' }).getByRole('option');
  await expect(page.getByRole('listbox').getByText('검색 결과 1개', { exact: true })).toBeVisible();
  await expect(options.filter({ hasText: 'Claude Haiku 4.5' })).toHaveCount(1);
  await expect(options.filter({ hasText: 'GPT-5 Mini' })).toHaveCount(0);
  await model.fill('gpt');
  await expect(options.filter({ hasText: /GPT-5 Mini/ })).toHaveCount(1);
  await expect(options.filter({ hasText: /GPT-5\.1/ })).toHaveCount(1);
  await model.fill('gpt 5.1');
  await expect(options.filter({ hasText: /GPT-5\.1/ })).toHaveCount(1);
  await expect(options.filter({ hasText: /GPT-5 Mini/ })).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(model).toHaveAttribute('aria-activedescendant', /model-opt-0/);
  await page.keyboard.press('Enter');
  await expect(model).toHaveValue('openai/gpt-5.1');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  // Choosing is a draft: it needs the save button, like every other setting.
  expect(await saves(page)).toEqual([]);
  await expect(page.getByText('번역 탭에 저장하지 않은 변경 1개', { exact: true })).toBeVisible();
});

test('Escape closes the list without closing anything else', async ({ page }) => {
  await settings(page);
  await page.locator('#model').click();
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.locator('#model')).toBeFocused();
  await expect(page.getByRole('heading', { level: 1, name: '환경 설정' })).toBeVisible();
});

test('a model id that is not in the list can be typed and saved', async ({ page }) => {
  await settings(page);
  const model = page.locator('#model');
  await model.fill('my-lab/custom-translator-1');
  const custom = page.getByRole('option', { name: /목록에 없는 모델 ID 사용/ });
  await expect(custom).toContainText('my-lab/custom-translator-1');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(model).toHaveValue('my-lab/custom-translator-1');
  await expect(page.getByText('이 ID를 모델 목록에서 찾지 못했습니다.')).toBeVisible();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await saves(page)).length).toBe(1);
  expect((await saves(page))[0]).toMatchObject({ model: 'my-lab/custom-translator-1' });
});

test('models unsuited to translation are hidden, counted, and can be shown', async ({ page }) => {
  await settings(page);
  const model = page.locator('#model');
  await model.click();
  const note = page.getByText('번역에 맞지 않는 모델 3개 숨김', { exact: true });
  await expect(note).toBeVisible();
  await expect(page.getByRole('option', { name: /Whisper/ })).toHaveCount(0);
  await expect(page.getByRole('option', { name: /GPT Image 1/ })).toHaveCount(0);
  // They stay out of search results too.
  await model.fill('whisper');
  await expect(page.getByRole('option', { name: /Whisper/ })).toHaveCount(0);
  await model.fill('');
  await page.getByRole('button', { name: '함께 보기' }).click();
  await expect(page.getByText('번역에 맞지 않는 모델 3개도 표시 중')).toBeVisible();
  await model.fill('whisper');
  const shown = page.getByRole('option', { name: /Whisper/ });
  await expect(shown).toHaveCount(1);
  await expect(shown).toContainText('번역에 부적합');
  await page.getByRole('button', { name: '다시 숨기기' }).click();
  await expect(page.getByRole('option', { name: /Whisper/ })).toHaveCount(0);
});

test('the list is reachable by the toggle button and works at the smallest window', async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 620 });
  await settings(page);
  await page.getByRole('button', { name: '모델 목록 열기 또는 닫기' }).click();
  await expect(page.getByRole('listbox')).toBeVisible();
  const box = await page.getByRole('listbox').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(840);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '모델 목록 열기 또는 닫기' }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
});

test('without a model list, the field still takes any id', async ({ page }) => {
  await settings(page, '&modelError=1', false);
  await expect(page.getByText('모델 목록을 불러오지 못했습니다.', { exact: false }).first()).toBeVisible();
  await page.locator('#model').click();
  await expect(page.getByText('불러온 모델 목록이 없습니다. 모델 ID를 직접 입력하세요.')).toBeVisible();
  await page.locator('#model').fill('anything-goes');
  await expect(page.getByRole('option', { name: /목록에 없는 모델 ID 사용/ })).toBeVisible();
});

test('the picker looks right in dark mode and in English', async ({ page }) => {
  await settings(page, '&theme=dark&locale=en');
  await page.locator('#model').click();
  await expect(page.getByRole('listbox', { name: 'Models' })).toBeVisible();
  await expect(page.getByText('Recommended', { exact: true })).toBeVisible();
  await expect(page.getByText('3 models not suited to translation are hidden')).toBeVisible();
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/model-picker-dark-en.png' });
});
