import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

async function open(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('main')).not.toContainText('불러오는 중');
}

test('a fresh install learns what is missing before scanning and returns to the run step after setup', async ({ page }) => {
  await open(page, 'scenario=selected&fresh=1');
  // Scanning works without a key, but the missing setup is said up front, not at step 4.
  const early = page.locator('.callout').filter({ hasText: 'AI 번역 설정이 아직 남아 있습니다' });
  await expect(early).toContainText('사용할 AI 모델을 아직 고르지 않았습니다.');
  await expect(early).toContainText('OpenAI API 키가 저장되어 있지 않습니다.');
  await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
  await page.getByRole('button', { name: /번역할 문장 고르기/ }).last().click();
  await page.getByRole('button', { name: '번역 준비 단계로 이동' }).click();

  // One notice lists everything that blocks the run.
  const blocking = page.getByRole('alert').filter({ hasText: '번역을 시작하려면 설정을 마쳐 주세요' });
  await expect(blocking).toHaveCount(1);
  await expect(page.getByRole('button', { name: '번역 시작', exact: true })).toBeDisabled();
  await blocking.getByRole('button', { name: '환경 설정에서 설정하기' }).click();

  await page.locator('#api-key').fill('sk-fixture');
  await page.locator('#model').fill('fixture-model');
  await page.getByRole('button', { name: '저장하고 돌아가기', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '번역 준비', exact: true })).toBeVisible();
  await expect(page.locator('main')).toContainText('OpenAI · fixture-model');
  await expect(page.getByRole('alert').filter({ hasText: '번역을 시작하려면' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '번역 시작', exact: true })).toBeEnabled();
});

test('settings opened from a step offer the way back without unsaved changes', async ({ page }) => {
  // A model that reasons, so the run step offers its reasoning setting.
  await open(page, 'scenario=run&model=deepseek/deepseek-v4.1-flash');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await page.getByRole('button', { name: '추론 설정 수정' }).click();
  await page.getByRole('button', { name: '"번역 준비" 단계로 돌아가기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '번역 준비', exact: true })).toBeVisible();
});

test('leaving settings with unsaved changes asks before dropping them', async ({ page }) => {
  await open(page, 'scenario=selected&missingKey=1');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.locator('#api-key').fill('sk-unsaved');
  await page.getByRole('button', { name: '백업 관리', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: '저장하지 않은 설정이 있습니다' });
  await expect(dialog).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog.getByRole('button', { name: '계속 편집' }).click();
  await expect(page.locator('#api-key')).toHaveValue('sk-unsaved');
  await expect(page.getByRole('heading', { level: 1, name: '환경 설정' })).toBeVisible();

  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '저장하지 않고 이동' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '번역할 문장 찾기' })).toBeVisible();
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.locator('#api-key')).toHaveValue('');

  // Saving from the question moves on as asked.
  await page.locator('#model').fill('saved-on-leave');
  await page.getByRole('button', { name: '도움말', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '저장하고 이동' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '도움말' })).toBeVisible();
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.locator('#model')).toHaveValue('saved-on-leave');
  await page.getByRole('button', { name: '정보', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('keyboard moves through a narrow review list without opening the detail sheet', async ({ page }) => {
  // About 620px of list area: too narrow for the side panel, so the detail is a sheet.
  await page.setViewportSize({ width: 720, height: 700 });
  await open(page, 'scenario=review');
  await page.getByRole('button', { name: /^번역할 문장 고르기/ }).click();
  const first = page.locator('tr[data-index="0"]');
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('tr[data-index="1"] input[type="checkbox"]')).not.toBeChecked();
  await expect(page.locator('tr[data-index="1"]')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#manual-translation')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('tr[data-index="1"]')).toBeFocused();
});

for (const viewport of [{ width: 1024, height: 680 }, { width: 840, height: 480 }]) {
  test(`a ${viewport.width}px window keeps the review detail beside the list`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, 'scenario=review');
    await page.getByRole('button', { name: /^번역할 문장 고르기/ }).click();
    await page.locator('tr[data-index="0"]').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const panel = page.locator('.detailwrap');
    await expect(panel.locator('#manual-translation')).toBeVisible();
    const first = await panel.locator('.source').innerText();
    await page.keyboard.press('ArrowDown');
    await expect(panel.locator('.source')).not.toHaveText(first);
    const table = await page.locator('.tablewrap').boundingBox();
    const side = await panel.boundingBox();
    expect(table!.x + table!.width).toBeLessThanOrEqual(side!.x);
    expect(side!.x + side!.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.locator('td.c-source').first().evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(120);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `output/playwright/review-side-detail-${viewport.width}.png` });
  });
}

test('a narrow window still explains why the next step is disabled', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 680 });
  await open(page, 'scenario=review');
  await page.getByRole('button', { name: /^번역할 문장 고르기/ }).click();
  await page.getByRole('button', { name: '현재 표시된 항목 모두 제외' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '번역 대상으로 선택된 문장이 없습니다' })).toBeVisible();
});

for (const viewport of [{ width: 840, height: 620 }, { width: 1180, height: 640 }]) {
  test(`a short ${viewport.width}x${viewport.height} window keeps the review next step on screen`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await open(page, 'scenario=review');
    await page.getByRole('button', { name: /^번역할 문장 고르기/ }).click();
    await expect(page.getByRole('button', { name: '번역 준비 단계로 이동' })).toBeInViewport({ ratio: 1 });
    await page.locator('main').evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
    await expect(page.getByRole('button', { name: '번역 준비 단계로 이동' })).toBeInViewport({ ratio: 1 });
    await expect(page.locator('tr[data-index="0"]')).toBeVisible();
  });
}

test('a model without reasoning shows no reasoning edit on the run step', async ({ page }) => {
  await open(page, 'scenario=run');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await expect(page.locator('main')).toContainText('이 모델은 추론 설정을 지원하지 않습니다');
  await expect(page.getByRole('button', { name: '추론 설정 수정' })).toHaveCount(0);
});

test('a saved job can start over only after a cost warning', async ({ page }) => {
  await open(page, 'scenario=run');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: '번역 준비', exact: true })).toBeVisible();
  // The notice title says a job was paused; the body no longer repeats it.
  await expect(page.locator('main')).toContainText('이전에 중단된 작업 기록이 있습니다');
  await expect(page.locator('main')).not.toContainText('이전에 중단된 작업이 있습니다.');
  await page.getByRole('button', { name: '처음부터 다시 번역' }).click();
  const dialog = page.getByRole('dialog', { name: '처음부터 다시 번역할까요?' });
  await expect(dialog).toContainText('API 요금이 다시 발생합니다');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '처음부터 다시 번역' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '처음부터 번역' }).click();
  // Translating stops for review first; nothing is written until the person applies.
  await expect(page.getByRole('heading', { level: 1, name: '번역 결과 검토', exact: true })).toBeVisible();
  const kinds = await page.evaluate(() => (window as unknown as { __pomiRequests: { type: string }[] }).__pomiRequests.map((request) => request.type));
  expect(kinds).toContain('translate.start');
  expect(kinds).not.toContain('translate.resume');
});

test('results say what to do next and how much of a failure list is shown', async ({ page }) => {
  await open(page, 'scenario=result-partial');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  // The whole list comes from the saved table, not from the result's short preview.
  await expect(page.getByText('실패한 문장 2개 전체입니다.')).toBeVisible();
});

test('without a saved table the result still says how much of the failure list is shown', async ({ page }) => {
  await open(page, 'scenario=result-partial&nocp=1');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await expect(page.getByText('실패한 2개 중 1개만 보여 줍니다.')).toBeVisible();
});

test('the success result points to checking the world in the game', async ({ page }) => {
  await open(page, 'scenario=result-success');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await expect(page.getByRole('status').filter({ hasText: '번역을 성공적으로 마쳤습니다' })).toContainText('Minecraft에서 월드를 열어 번역을 확인해 보세요');
});

test('backups explain why restore is unavailable during a job', async ({ page }) => {
  await open(page, 'scenario=run-progress');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await page.getByRole('button', { name: '백업 관리', exact: true }).click();
  await expect(page.getByText('작업이 진행 중이라 지금은 복원할 수 없습니다', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '이 시점으로 월드 복원' }).first()).toBeDisabled();
});

test('a toast never covers the action bar', async ({ page }) => {
  await open(page, 'scenario=run');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.locator('#model').fill('toast-fixture');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  const toast = page.locator('.toast').first();
  await expect(toast).toBeVisible();
  const toastBox = (await toast.boundingBox())!;
  const barBox = (await page.locator('.action-bar').boundingBox())!;
  expect(toastBox.y + toastBox.height).toBeLessThan(barBox.y);
});
