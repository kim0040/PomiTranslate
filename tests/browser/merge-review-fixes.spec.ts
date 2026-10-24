import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

// Regressions for the independent review of the 2026-10-24 merge: the unpriced banner may only repeat a
// refused request (H1), the review table keeps one tab stop when its active row scrolls away (M2) and
// unsaved review edits offer stay or discard, never a save that cannot succeed (M3). The fixture plays
// the sidecar; nothing here reaches a provider.
type Logged = { type: string; payload?: Record<string, any> };

async function open(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('main')).not.toContainText('불러오는 중');
}
const requests = (page: Page, ...types: string[]) =>
  page.evaluate((kinds) => (window as any).__pomiRequests.filter((item: Logged) => kinds.includes(item.type)) as Logged[], types);
const step = (page: Page, name: string) => page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
const reviewHeading = (page: Page) => page.getByRole('heading', { level: 1, name: '번역 결과 검토', exact: true });
const consent = (page: Page) => page.getByRole('button', { name: '한도 적용 없이 시작', exact: true });
const consentRetry = (page: Page) => page.getByRole('button', { name: '한도 적용 없이 다시 번역', exact: true });
const noPrice = (page: Page) => page.getByRole('alert').filter({ hasText: '이 모델은 가격 정보가 없어' });

/** A model without a price and a spending limit: acknowledge on the Run screen, which opens the review. */
async function acknowledgeOnRun(page: Page, query: string) {
  await open(page, `scenario=run&cap=5&unpriced=1&${query}`);
  await step(page, '번역 준비');
  await expect(noPrice(page)).toBeVisible();
  await consent(page).click();
  await expect(reviewHeading(page)).toBeVisible();
}

test.describe('the unpriced notice', () => {
  test('acknowledging on the Run screen opens the review without another start or a replaced job', async ({ page }) => {
    await acknowledgeOnRun(page, 'fail=0');
    const started = await requests(page, 'translate.start', 'translate.resume');
    expect(started).toHaveLength(1);
    expect(started[0].payload?.unpricedCapAck).toBe(true);
    // The review has nothing refused waiting: the notice and its button are gone, so nothing can start again.
    await expect(noPrice(page)).toHaveCount(0);
    await expect(consent(page)).toHaveCount(0);
    await expect(consentRetry(page)).toHaveCount(0);
    await expect(page.locator('tr[data-index]')).toHaveCount(5);
    await page.waitForTimeout(300);
    expect(await requests(page, 'translate.start', 'translate.resume')).toHaveLength(1);
    await expect(reviewHeading(page)).toBeVisible();
  });

  test('a refused failed-only retry repeats exactly that retry once the person agrees', async ({ page }) => {
    await acknowledgeOnRun(page, 'fail=2');
    const startsBefore = (await requests(page, 'translate.start', 'translate.resume')).length;
    expect(startsBefore).toBe(1);
    await page.getByRole('button', { name: '다시 번역할 2개 번역' }).click();

    // The core refused the retry (no price, a limit is set): the notice offers to repeat that retry only.
    await expect(noPrice(page)).toBeVisible();
    await expect(reviewHeading(page)).toBeVisible();
    expect(await requests(page, 'translate.retry_failed')).toHaveLength(1);
    await consentRetry(page).click();

    await expect(page.getByRole('button', { name: '월드에 적용 (5개)' })).toBeVisible();
    const retries = await requests(page, 'translate.retry_failed');
    expect(retries.filter((item) => item.payload?.unpricedCapAck === true)).toHaveLength(1);
    expect(retries.filter((item) => item.payload?.unpricedCapAck === undefined)).toHaveLength(1);
    // The review job was kept: no new translation was started.
    expect(await requests(page, 'translate.start', 'translate.resume')).toHaveLength(startsBefore);
    await expect(noPrice(page)).toHaveCount(0);
  });

  test('the finished result screen offers no way to start a translation from the notice', async ({ page }) => {
    await open(page, 'scenario=result-success&cap=5&unpriced=1');
    await expect(consent(page)).toHaveCount(0);
    await expect(consentRetry(page)).toHaveCount(0);
    expect(await requests(page, 'translate.start', 'translate.resume')).toHaveLength(0);
  });
});

test.describe('a long translation review', () => {
  test('keeps one tab stop when the active row has scrolled out, and Enter opens the editor', async ({ page }) => {
    await open(page, 'scenario=run&count=300');
    await step(page, '번역 준비');
    await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
    await expect(reviewHeading(page)).toBeVisible();
    await expect(page.locator('tr[data-index="0"]')).toBeVisible();

    // Row 0 is the active row. Scroll far enough that it is no longer rendered.
    await page.locator('.viewport').evaluate((element) => { element.scrollTop = 64 * 120; });
    await expect(page.locator('tr[data-index="0"]')).toHaveCount(0);
    await expect(page.locator('tr[data-index][tabindex="0"]')).toHaveCount(1);

    // Tab from the control before the grid lands on that row; Enter opens its editor.
    await page.locator('.toolbar > button').last().focus();
    await page.keyboard.press('Tab');
    const stop = page.locator('tr[data-index][tabindex="0"]');
    await expect(stop).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#translation-edit')).toBeFocused();
  });
});

test.describe('closing with only unsaved review edits', () => {
  const emit = (page: Page, name: string, payload: unknown) => page.evaluate(([n, p]) => (window as any).__pomiEmit(n, p), [name, payload] as const);
  const shell = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__pomiShell ?? []);

  async function dirtyReview(page: Page) {
    await open(page, 'scenario=run');
    await step(page, '번역 준비');
    await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
    await expect(reviewHeading(page)).toBeVisible();
    await page.locator('tr[data-index="0"]').click();
    await page.locator('#translation-edit').fill('저장 전 검토 초안');
    await expect(page.locator('.counts')).toContainText('저장 전 수정 1');
  }

  for (const reason of ['quit', 'update'] as const) {
    test(`${reason}: stay keeps the edits, discard goes on, and there is no save action`, async ({ page }) => {
      await dirtyReview(page);
      await emit(page, 'pomi-exit-confirm', { job: false, dirty: true, reason, intent: 4 });
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: /저장하고|설정 저장/ })).toHaveCount(0);
      await expect(dialog.getByRole('button')).toHaveCount(2);
      if (reason === 'quit') await expect(dialog.getByRole('heading', { name: '저장하지 않은 번역 수정이 있습니다' })).toBeVisible();

      await dialog.getByRole('button', { name: '계속 수정', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('#translation-edit')).toHaveValue('저장 전 검토 초안');
      await expect.poll(() => shell(page)).toEqual(['exit_cancel']);

      await emit(page, 'pomi-exit-confirm', { job: false, dirty: true, reason, intent: 5 });
      await page.getByRole('dialog').getByRole('button', { name: reason === 'quit' ? '수정을 버리고 종료' : '수정을 버리고 설치', exact: true }).click();
      await expect.poll(() => shell(page)).toEqual(['exit_cancel', 'exit_confirm']);
      // Nothing was written to the world from the exit dialog.
      expect(await requests(page, 'translate.apply', 'translate.reapply')).toHaveLength(0);
    });
  }
});
