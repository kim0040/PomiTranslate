import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// Translate -> review/edit -> apply, failed-only retry, post-apply corrections, the spending cap and
// the richer progress screen. The fixture plays the sidecar; nothing here reaches a provider.
type Logged = { type: string; payload?: Record<string, any> };

async function open(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('main')).not.toContainText('불러오는 중');
}
const step = (page: Page, name: string) => page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
const requests = (page: Page, type: string) => page.evaluate((kind) => (window as any).__pomiRequests.filter((item: Logged) => item.type === kind) as Logged[], type);
const startButton = (page: Page) => page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ });
const reviewHeading = (page: Page) => page.getByRole('heading', { level: 1, name: '번역 결과 검토', exact: true });
const row = (page: Page, text: string) => page.locator('tr[data-index]').filter({ hasText: text });

/** From a resumable fixture to the review table. */
async function toReview(page: Page, query = 'scenario=run') {
  await open(page, query);
  await step(page, '번역 진행');
  const overCap = page.getByRole('alert').filter({ hasText: '예상 비용이 설정한 한도를 넘습니다' });
  await expect.poll(async () => (await overCap.isVisible()) || !(await startButton(page).isDisabled())).toBe(true);
  if (await overCap.isVisible().catch(() => false)) await overCap.getByRole('button', { name: '그래도 시작' }).click();
  else await startButton(page).click();
  await expect(reviewHeading(page)).toBeVisible();
}

test('translating stops for review and writes nothing until the person applies', async ({ page }) => {
  await toReview(page);
  await expect(page.locator('tr[data-index]')).toHaveCount(5);
  await expect(page.getByRole('button', { name: '월드에 적용 (5개)' })).toBeEnabled();
  // Review mode must not have sent anything that writes.
  expect(await requests(page, 'translate.apply')).toHaveLength(0);
  expect(await requests(page, 'translate.reapply')).toHaveLength(0);
  const resumes = await requests(page, 'translate.resume');
  expect(resumes).toHaveLength(1);
  // The result step is not reachable before something was applied.
  await expect(page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^완료 결과/ })).toBeDisabled();
});

test('a broken formatting code is refused per row, then a fixed edit is applied with zero provider requests', async ({ page }) => {
  await toReview(page, 'scenario=run&tokens=1');
  await row(page, '§6A blade').click();
  const editor = page.locator('#translation-edit');
  await expect(editor).toHaveValue('§6모든 전투를 기억하는 검§r');
  await expect(page.locator('.tokens')).toContainText('§6');

  // Dropping the § codes would write a broken sign: the apply is refused and the row says why.
  await editor.fill('모든 전투를 기억하는 검');
  await expect(row(page, '모든 전투를 기억하는 검')).toContainText('수정됨');
  await expect(page.getByRole('button', { name: '월드에 적용 (5개)' })).toBeEnabled();
  await page.getByRole('button', { name: '월드에 적용 (5개)' }).click();
  const confirm = page.getByRole('dialog', { name: '월드에 적용할까요?' });
  await expect(confirm).toContainText('쓰기 전에 변경될 파일을 먼저 백업하고 확인합니다');
  await expect(confirm).toContainText('AI에 요청을 보내지 않아');
  await confirm.getByRole('button', { name: '월드에 적용', exact: true }).click();

  await expect(reviewHeading(page)).toBeVisible();
  await expect(page.locator('#translation-error')).toContainText('서식 코드');
  await expect(page.getByRole('alert').filter({ hasText: '고쳐야 할 번역문이 1개 있습니다' })).toBeVisible();
  await expect(row(page, '§6A blade')).toContainText('고쳐 주세요');
  let applies = await requests(page, 'translate.apply');
  expect(applies).toHaveLength(1);
  expect(applies[0].payload?.edits).toEqual({ lore: '모든 전투를 기억하는 검' });
  expect(applies[0].payload?.fingerprint).toBe('fixture-world-fingerprint');

  // Editing the row clears its refusal; with the codes back the apply goes through.
  await editor.fill('§6모든 전투를 기억하는 날카로운 검§r');
  await expect(page.locator('#translation-error')).toHaveCount(0);
  await page.getByRole('button', { name: '월드에 적용 (5개)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '월드에 적용', exact: true }).click();

  await expect(page.getByRole('status').filter({ hasText: '번역을 성공적으로 마쳤습니다' })).toBeVisible();
  applies = await requests(page, 'translate.apply');
  expect(applies).toHaveLength(2);
  expect(applies[1].payload?.edits).toEqual({ lore: '§6모든 전투를 기억하는 날카로운 검§r' });
  // No provider request in the whole apply, and the stats say the rows were applied, not just prepared.
  expect(await requests(page, 'translate.retry_failed')).toHaveLength(0);
  const stats = page.locator('.stats');
  await expect(stats.locator('.stat').filter({ hasText: '월드에 적용됨' })).toContainText('5');
  // The apply call itself sent nothing, but the stat is the job's total (the translate run's request), like the tokens and cost next to it.
  const requestStat = stats.locator('.stat').filter({ hasText: 'API 요청 수' });
  await expect(requestStat.locator('.v')).toHaveText('1');
  await expect(requestStat).toContainText('작업 전체');
  expect((await requests(page, 'translate.apply')).length).toBe(2);
  await expect(stats.getByText('번역문 준비')).toHaveCount(0);
});

test('search and state chips narrow the table, and edits survive leaving and coming back', async ({ page }) => {
  await toReview(page, 'scenario=run&fail=2');
  await expect(page.getByRole('button', { name: /^전체 5$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^실패 2$/ })).toBeVisible();
  await page.getByRole('button', { name: /^실패 2$/ }).click();
  await expect(page.locator('tr[data-index]')).toHaveCount(2);
  await page.getByRole('button', { name: /^전체/ }).click();
  await page.getByRole('searchbox', { name: '번역 결과 검색' }).fill('북문');
  await expect(page.locator('tr[data-index]')).toHaveCount(1);
  await expect(page.locator('tr[data-index]')).toContainText('Merchant of the Northern Gate');

  await row(page, 'Merchant of the Northern Gate').click();
  await page.locator('#translation-edit').fill('북문 상인');
  await expect(page.locator('.counts')).toContainText('저장 전 수정 1');

  // Leave for another page and another step: the unsaved edit is still there.
  await page.getByRole('button', { name: '백업 관리', exact: true }).click();
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await expect(reviewHeading(page)).toBeVisible();
  await expect(page.locator('.counts')).toContainText('저장 전 수정 1');
  await row(page, 'Merchant of the Northern Gate').click();
  await expect(page.locator('#translation-edit')).toHaveValue('북문 상인');
  // Reverting goes back to the AI's own answer.
  await page.getByRole('button', { name: 'AI 번역으로 되돌리기' }).click();
  await expect(page.locator('#translation-edit')).toHaveValue('북문의 상인');
  await expect(page.locator('.counts')).not.toContainText('저장 전 수정');
});

test('failed rows are retried on their own, with the cost shown first', async ({ page }) => {
  await toReview(page, 'scenario=run&fail=2');
  // A failed row says why in plain Korean and keeps the provider text behind a disclosure.
  await row(page, 'Welcome to Roguefire').click();
  await expect(page.locator('.detail .failed')).toContainText('제공사의 응답이 너무 늦어');
  await expect(page.locator('.detail .raw')).toBeHidden();
  await page.locator('.detail summary').click();
  await expect(page.locator('.detail .raw')).toContainText('ReadTimeout');

  const retry = page.getByRole('button', { name: '다시 번역할 2개 번역' });
  await expect(retry).toBeVisible();
  await expect(page.getByText(/예상 비용 약 US\$/)).toBeVisible();
  await expect(page.getByRole('button', { name: '월드에 적용 (3개)' })).toBeVisible();
  await retry.click();

  await expect(page.getByRole('button', { name: '월드에 적용 (5개)' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^실패 0$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /다시 번역$/ })).toHaveCount(0);
  expect(await requests(page, 'translate.retry_failed')).toHaveLength(1);
});

test('normal retry counts and preflights the failed plus glossary-stale rows', async ({ page }) => {
  await toReview(page, 'scenario=run&fail=1&stale=1&estimateRange=1&cap=0.0001');
  await expect(page.getByRole('button', { name: '다시 번역할 2개 번역' })).toBeVisible();
  await expect(page.getByText('요청 1–2회')).toBeVisible();
  const retry = page.getByRole('button', { name: '다시 번역할 2개 번역' });
  await retry.click();
  const confirmation = page.getByRole('dialog', { name: '예상 비용이 설정한 한도를 넘습니다' });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('예상 비용');
  await expect(confirmation).toContainText('요청 1–2회');
  await expect(confirmation).not.toContainText('US$0.00017');
  await confirmation.getByRole('button', { name: '그래도 시작' }).click();
  await expect(reviewHeading(page)).toBeVisible();
  const request = (await requests(page, 'translate.retry_failed')).at(-1)!;
  expect(request.payload?.budgetOverride).toBe(true);
  expect(request.payload?.refreshGlossary).toBeUndefined();
  expect(await page.evaluate(() => (window as any).__pomiRetrySent)).toEqual(['welcome', 'shop']);
});

test('the run summary presents glossary reminder estimates as a request range', async ({ page }) => {
  await open(page, 'scenario=run&estimateRange=1');
  await step(page, '번역 진행');
  await expect(page.locator('.group').filter({ hasText: '예상 요청 횟수' })).toContainText('요청 1–2회');
});

test('saved manual edits remain revertible when they also mismatch the glossary', async ({ page }) => {
  await toReview(page, 'scenario=run&editedMismatch=1');
  const first = page.locator('tr[data-index="0"]');
  await expect(first).toContainText('수정됨');
  await expect(first).toContainText('용어 확인');
  await first.click();
  await expect(page.getByRole('button', { name: 'AI 번역으로 되돌리기' })).toBeVisible();
  const editor = page.locator('#translation-edit');
  await expect(editor).toHaveValue('별칭');
  await page.getByRole('button', { name: 'AI 번역으로 되돌리기' }).click();
  await expect(editor).toHaveValue('로그파이어에 오신 것을 환영합니다');
  await page.getByRole('button', { name: '월드에 적용 (5개)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '월드에 적용', exact: true }).click();
  const apply = (await requests(page, 'translate.apply')).at(-1)!;
  expect(apply.payload?.edits).toMatchObject({ welcome: null });
});

test('Japanese source text has no invented English language metadata', async ({ page }) => {
  await toReview(page, 'scenario=run&sourceLang=ja');
  const first = page.locator('tr[data-index="0"]');
  await expect(first.locator('.c-source .txt')).toHaveText('ようこそ、ローグファイアへ');
  await expect(first.locator('.c-source .txt')).not.toHaveAttribute('lang', 'en');
  await first.click();
  await expect(page.locator('.detail .source')).toHaveText('ようこそ、ローグファイアへ');
  await expect(page.locator('.detail .source')).not.toHaveAttribute('lang', 'en');
});

test('a failed reapply exposes both the recovery snapshot and a safe retry action', async ({ page }) => {
  await toReview(page, 'scenario=run&reapplyInterrupted=1');
  await page.getByRole('button', { name: '월드에 적용 (5개)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '월드에 적용', exact: true }).click();
  await expect(page.getByRole('button', { name: '번역문 수정' })).toBeVisible();
  await page.getByRole('button', { name: '번역문 수정' }).click();
  await row(page, 'Merchant of the Northern Gate').click();
  await page.locator('#translation-edit').fill('북문의 상인님');
  await page.getByRole('button', { name: '수정한 1개 다시 적용' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '복원하고 다시 적용' }).click();

  const recovery = page.getByRole('alert').filter({ hasText: '다시 적용을 끝내지 못했습니다' });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('button', { name: '복구 스냅샷으로 되돌리기' })).toBeVisible();
  await expect(recovery.getByRole('button', { name: '다시 적용' })).toBeEnabled();
  await recovery.getByRole('button', { name: '복구 스냅샷으로 되돌리기' }).click();
  const confirmRestore = page.getByRole('dialog', { name: '복구 스냅샷으로 되돌릴까요?' });
  await confirmRestore.getByRole('button', { name: '복구 스냅샷으로 복원' }).click();
  const restore = (await requests(page, 'restore.start')).at(-1)!;
  expect(restore.payload?.backupSetId).toBe('recovery-before-reapply');
});

test('after applying, the translations can be corrected: restore, apply again, zero requests', async ({ page }) => {
  await toReview(page);
  await page.getByRole('button', { name: '월드에 적용 (5개)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '월드에 적용', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '번역을 성공적으로 마쳤습니다' })).toBeVisible();
  await expect(page.getByText('Minecraft에서 월드를 열어 번역을 확인해 보세요')).toBeVisible();

  // The world folder opens through the native command for the selected world only.
  await page.getByRole('button', { name: '월드 폴더 열기' }).click();
  expect(await page.evaluate(() => (window as any).__pomiWorldRevealed)).toContain('Roguefire');

  await page.getByRole('button', { name: '번역문 수정' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '번역문 수정', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /다시 적용$/ })).toBeDisabled();
  await row(page, 'Merchant of the Northern Gate').click();
  await page.locator('#translation-edit').fill('북문의 상인님');
  await page.getByRole('button', { name: '수정한 1개 다시 적용' }).click();
  const confirm = page.getByRole('dialog', { name: '수정한 번역을 다시 적용할까요?' });
  await expect(confirm).toContainText('복구용 스냅샷');
  await expect(confirm).toContainText('번역 전에 만든 백업으로 월드를 복원합니다');
  await confirm.getByRole('button', { name: '복원하고 다시 적용' }).click();

  await expect(page.getByRole('status').filter({ hasText: '번역을 성공적으로 마쳤습니다' })).toBeVisible();
  const reapplies = await requests(page, 'translate.reapply');
  expect(reapplies).toHaveLength(1);
  expect(reapplies[0].payload?.edits).toEqual({ merchant: '북문의 상인님' });
  expect(await requests(page, 'translate.apply')).toHaveLength(1);
  expect(await requests(page, 'translate.retry_failed')).toHaveLength(0);

  // The edit is in the saved table the next time it is opened.
  await page.getByRole('button', { name: '번역문 수정' }).click();
  await page.getByRole('button', { name: /^수정됨 1$/ }).click();
  await expect(page.locator('tr[data-index]')).toHaveCount(1);
  await expect(page.locator('tr[data-index]')).toContainText('북문의 상인님');
});

test('a world that changed after applying explains why it cannot be applied again', async ({ page }) => {
  await toReview(page, 'scenario=run&worldChanged=1');
  await page.getByRole('button', { name: '월드에 적용 (5개)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '월드에 적용', exact: true }).click();
  await page.getByRole('button', { name: '번역문 수정' }).click();
  await row(page, 'The Lost Key Shop').click();
  await page.locator('#translation-edit').fill('열쇠 가게');
  await page.getByRole('button', { name: '수정한 1개 다시 적용' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '복원하고 다시 적용' }).click();
  await expect(page.getByRole('alert').filter({ hasText: '월드가 바뀌어 다시 적용할 수 없습니다' })).toBeVisible();
  // The edit is kept, so nothing typed is lost.
  await expect(page.getByRole('heading', { level: 1, name: '번역문 수정', exact: true })).toBeVisible();
  await expect(page.locator('.counts')).toContainText('저장 전 수정 1');
});

test('an estimate above the spending cap blocks the start until it is confirmed', async ({ page }) => {
  await open(page, 'scenario=run');
  await step(page, '번역 진행');
  const cap = page.getByLabel('비용 한도');
  await expect(cap).toHaveValue('0');
  await expect(page.getByText('0이면 제한하지 않습니다.')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '예상 비용이 설정한 한도를 넘습니다' })).toHaveCount(0);

  await cap.fill('0.0001');
  await cap.press('Enter');
  const warning = page.getByRole('alert').filter({ hasText: '예상 비용이 설정한 한도를 넘습니다' });
  await expect(warning).toContainText('$0.0001');
  await expect(page.getByRole('button', { name: '이어서 번역', exact: true })).toBeDisabled();
  const saved = await requests(page, 'settings.set');
  expect(saved.at(-1)?.payload?.maxCostUsd).toBe(0.0001);

  // "Change cap" goes to the field; the warning disappears once the cap is high enough.
  await warning.getByRole('button', { name: '설정 변경' }).click();
  await expect(cap).toBeFocused();
  await cap.fill('5');
  await cap.press('Enter');
  await expect(warning).toHaveCount(0);
  await expect(page.getByRole('button', { name: '이어서 번역', exact: true })).toBeEnabled();

  // Back over the cap: "Start anyway" bypasses only the estimate preflight.
  await cap.fill('0.0001');
  await cap.press('Enter');
  await warning.getByRole('button', { name: '그래도 시작' }).click();
  await expect(reviewHeading(page)).toBeVisible();
  const starts = await requests(page, 'translate.resume');
  expect(starts.at(-1)?.payload?.budgetOverride).toBe(true);
  const settings = (await requests(page, 'settings.set')).at(-1)?.payload;
  expect(settings?.maxCostUsd).toBe(0.0001);

  // Nonsense is not saved.
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 진행/ }).click();
});

test('an invalid cap is rejected inline and the review switch is saved', async ({ page }) => {
  await open(page, 'scenario=run');
  await step(page, '번역 진행');
  const cap = page.getByLabel('비용 한도');
  await cap.fill('abc');
  await cap.press('Enter');
  await expect(page.getByText('0부터 1000 사이의 숫자를 입력해 주세요.')).toBeVisible();
  expect((await requests(page, 'settings.set')).filter((item) => item.payload?.maxCostUsd !== undefined && item.payload.maxCostUsd !== 0)).toHaveLength(0);

  const review = page.getByRole('checkbox', { name: '적용 전에 번역 결과 검토' });
  await expect(review).toBeChecked();
  await review.uncheck();
  await expect.poll(async () => (await requests(page, 'settings.set')).at(-1)?.payload?.reviewBeforeApply).toBe(false);
  // Without review the failure policy matters again.
  await expect(page.getByText('일부 문장 번역 실패 시 동작')).toBeVisible();
});

test('hitting the cap stops with a clear explanation and can be continued once without the cap', async ({ page }) => {
  await open(page, 'scenario=run&budget=1');
  await step(page, '번역 진행');
  await startButton(page).click();
  const callout = page.getByRole('status').filter({ hasText: '비용 한도에 닿아 번역을 멈췄습니다' });
  await expect(callout).toContainText('지금까지의 번역은 보관되어 있어');
  await expect(page.locator('.stats').locator('.stat').filter({ hasText: '번역문 준비' })).toContainText('3');
  await expect(page.locator('.stats').getByText('월드에 적용됨')).toHaveCount(0);
  // Rows the cap kept from being sent are their own count, not failures, and nothing says "unknown reason".
  const stats = page.locator('.stats');
  await expect(stats.locator('.stat').filter({ hasText: '비용 한도로 보내지 않음' }).locator('.v')).toHaveText('2');
  await expect(stats.locator('.stat').filter({ hasText: '번역 실패' }).locator('.v')).toHaveText('0');
  await expect(page.locator('main')).not.toContainText('알 수 없는 이유');
  await expect(page.getByRole('heading', { name: '번역 실패 문장 목록' })).toHaveCount(0);
  // Continuing is the way to send them.
  await expect(callout.getByRole('button', { name: '이번만 한도 없이 이어서 번역' })).toBeVisible();
  await callout.getByRole('button', { name: '이번만 한도 없이 이어서 번역' }).click();
  const confirmation = page.getByRole('dialog', { name: '이번 번역에서만 한도를 끌까요?' });
  await expect(confirmation).toContainText('비용 한도가 적용되지 않습니다');
  await confirmation.getByRole('button', { name: '한도 없이 이어서 번역' }).click();
  await expect(reviewHeading(page)).toBeVisible();
  const resumes = await requests(page, 'translate.resume');
  expect(resumes.at(-1)?.payload?.budgetDisabled).toBe(true);
  expect(resumes.at(-1)?.payload?.budgetOverride).toBeUndefined();
});

test('starting above the estimate keeps the runtime cap and offers the cap editor after it stops', async ({ page }) => {
  await open(page, 'scenario=run&overCap=1&cap=0.0001');
  await step(page, '번역 진행');
  const warning = page.getByRole('alert').filter({ hasText: '예상 비용이 설정한 한도를 넘습니다' });
  await expect(warning).toContainText('실행 중 한도는 계속 적용');
  await warning.getByRole('button', { name: '그래도 시작' }).click();
  await expect(page.getByRole('status').filter({ hasText: '비용 한도에 닿아 번역을 멈췄습니다' })).toBeVisible();
  const resumes = await requests(page, 'translate.resume');
  expect(resumes.at(-1)?.payload?.budgetOverride).toBe(true);
  expect(resumes.at(-1)?.payload?.budgetDisabled).toBeUndefined();
  const raise = page.getByRole('button', { name: '한도 올리기' });
  await raise.click();
  await expect(page.getByLabel('비용 한도')).toBeFocused();
});

test('rows the cost cap kept from sending are labeled as such in the review, not as an unknown failure', async ({ page }) => {
  await toReview(page, 'scenario=run&fail=2&failCode=budget_unsent');
  await row(page, 'Welcome to Roguefire').click();
  await expect(page.locator('.detail .failed')).toContainText('비용 한도로 보내지 않았습니다');
  await expect(page.locator('.detail .failed')).not.toContainText('알 수 없는 이유');
  // The retry still sends them.
  await expect(page.getByRole('button', { name: '다시 번역할 2개 번역' })).toBeVisible();
});

test('a cancelled result counts the unsent rows apart from failures and the retry button', async ({ page }) => {
  await open(page, 'scenario=result-cancelled');
  await step(page, '번역 진행');
  await startButton(page).click();
  const stats = page.locator('.stats');
  await expect(stats.locator('.stat').filter({ hasText: '보내지 않은 문장' }).locator('.v')).toHaveText('4');
  await expect(stats.locator('.stat').filter({ hasText: '번역 실패' }).locator('.v')).toHaveText('0');
  await expect(page.getByRole('heading', { name: '번역 실패 문장 목록' })).toHaveCount(0);
});

test('a tiny cost cap and tiny estimates keep their significant digits', async ({ page }) => {
  await open(page, 'scenario=run');
  await step(page, '번역 진행');
  const cap = page.getByLabel('비용 한도');
  await cap.fill('0.0001');
  await cap.press('Enter');
  await expect(page.locator('main')).toContainText('US$0.0001');
  // The remaining estimate includes only four provider-bound rows after a saved manual override.
  await expect(page.locator('main')).toContainText('US$0.00017');
  await expect(page.locator('main')).toContainText('US$0.00034');
  await expect(page.locator('main')).not.toContainText(/US\$0\.00(?!\d)/);
});

test('failure reasons are readable per code, with the provider text behind "details"', async ({ page }) => {
  await open(page, 'scenario=result-failed');
  await step(page, '번역 진행');
  await startButton(page).click();
  const list = page.locator('section').filter({ has: page.getByRole('heading', { name: '번역 실패 문장 목록' }) });
  await expect(list).toContainText('실패한 문장 6개 전체입니다.');
  for (const text of ['제공사의 응답이 너무 늦어', '요청이 너무 많아', 'AI의 답을 쓸 수 없었습니다', '제공사에 연결하지 못했습니다', '잔액이나 사용 한도', '안전 필터가']) {
    await expect(list).toContainText(text);
  }
  // Raw English from the provider is never the main text.
  await expect(list.getByText('ReadTimeout')).toBeHidden();
  await list.locator('summary').first().click();
  await expect(list.getByText('ReadTimeout')).toBeVisible();
  // The primary action retries only the failed rows; scanning again is secondary.
  const retry = page.getByRole('button', { name: '실패한 6개만 다시 번역' });
  await expect(retry).toHaveClass(/btn-primary/);
  await expect(page.getByRole('button', { name: '처음부터 다시 스캔' })).toHaveClass(/btn-secondary/);
  await retry.click();
  await expect(reviewHeading(page)).toBeVisible();
  await expect(page.getByRole('button', { name: '월드에 적용 (6개)' })).toBeVisible();
  expect(await requests(page, 'translate.retry_failed')).toHaveLength(1);
});

test('a failed run with no saved translations offers to translate again', async ({ page }) => {
  await open(page, 'scenario=result-failed&nocp=1');
  await step(page, '번역 진행');
  await startButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: '번역에 실패했습니다' })).toBeVisible();
  const again = page.getByRole('button', { name: '다시 번역', exact: true });
  await expect(again).toHaveClass(/btn-primary/);
  await expect(page.getByRole('button', { name: /다시 번역$/ }).filter({ hasText: '실패한' })).toHaveCount(0);
  await again.click();
  await expect.poll(async () => (await requests(page, 'translate.start')).length).toBe(1);
});

test('a partly applied run lists every failure and offers the retry and the corrections', async ({ page }) => {
  await open(page, 'scenario=result-partial');
  await step(page, '번역 진행');
  await startButton(page).click();
  await expect(page.getByText('실패한 문장 2개 전체입니다.')).toBeVisible();
  await expect(page.locator('.stats').locator('.stat').filter({ hasText: '월드에 적용됨' })).toBeVisible();
  await expect(page.getByRole('button', { name: '실패한 2개만 다시 번역' })).toHaveClass(/btn-primary/);
  await expect(page.getByRole('button', { name: '번역문 수정' })).toBeVisible();
  await expect(page.getByRole('button', { name: '월드 폴더 열기' })).toBeVisible();
  // The stat and the list agree, and the preview points to the full translations instead of repeating them.
  await expect(page.locator('.stats').locator('.stat').filter({ hasText: '번역 실패' }).locator('.v')).toHaveText('2');
  await expect(page.locator('.stats').locator('.stat').filter({ hasText: '보내지 않은 문장' })).toHaveCount(0);
  const preview = page.locator('section').filter({ has: page.getByRole('heading', { name: '번역 결과 미리보기' }) });
  await expect(preview.locator('tbody tr')).toHaveCount(3);
  await preview.getByRole('button', { name: '전체 번역문 보기' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '번역문 수정', exact: true })).toBeVisible();
  expect(await requests(page, 'translations.page')).not.toHaveLength(0);
});

test('progress shows the time left after two batches and the latest translations, on one shared clock', async ({ page }) => {
  await open(page, 'scenario=run-progress');
  await step(page, '번역 진행');
  await startButton(page).click();
  await expect(page.getByRole('heading', { name: '번역을 진행하고 있습니다' })).toBeVisible();
  await expect(page.getByText('남은 시간 계산 중…')).toBeVisible();
  const recent = page.getByRole('region', { name: '최근 번역' });
  await expect(recent.locator('li')).toHaveCount(2);
  await expect(recent).toContainText('로그파이어에 오신 것을 환영합니다');
  await expect(page.getByText(/^남은 시간 약 /)).toBeVisible();
  await expect(recent.locator('li')).toHaveCount(3);
  await expect(page.getByText('남은 시간 계산 중…')).toHaveCount(0);

  // The sidebar and the run screen read the same clock, so the same second is shown in both.
  const same = await page.evaluate(() => {
    const side = document.querySelector('.sidebar .state .sub')?.textContent?.trim() ?? '';
    const main = document.querySelector('.live .line .muted')?.textContent ?? '';
    return { side, main };
  });
  expect(same.side).not.toBe('');
  expect(same.main).toContain(same.side);
});

test('a saved job that was never applied opens straight into the review and says where it came from', async ({ page }) => {
  await open(page, 'scenario=awaiting-review');
  await expect(reviewHeading(page)).toBeVisible();
  await expect(page.getByText('지난 작업의 번역이 아직 적용되지 않았습니다')).toBeVisible();
  await expect(page.locator('tr[data-index]')).toHaveCount(5);
  // Nothing was translated or written to get here.
  expect(await requests(page, 'translate.resume')).toHaveLength(0);
  expect(await requests(page, 'translate.start')).toHaveLength(0);
  await page.getByRole('button', { name: '월드에 적용 (5개)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '월드에 적용', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '번역을 성공적으로 마쳤습니다' })).toBeVisible();
});

test('single-pass runs still work when review is switched off', async ({ page }) => {
  await open(page, 'scenario=run&review=0&fail=1');
  await step(page, '번역 진행');
  await startButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: '일부 텍스트만 번역되었습니다' })).toBeVisible();
  await expect(page.getByText('실패한 문장 1개 전체입니다.')).toBeVisible();
  expect(await requests(page, 'translate.apply')).toHaveLength(0);
});

for (const theme of ['light', 'dark']) {
  test(`the review view is accessible in ${theme} mode`, async ({ page }) => {
    await toReview(page, `scenario=run&fail=1&tokens=1&theme=${theme}`);
    await row(page, 'Welcome to Roguefire').click();
    await page.locator('.detail summary').click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    // An edit with a refusal shows its error styling; check that state too.
    await row(page, '§6A blade').click();
    await page.locator('#translation-edit').fill('');
    await expect(page.locator('#translation-error')).toContainText('비워 둘 수 없습니다');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

for (const size of [{ width: 1180, height: 800 }, { width: 840, height: 620 }]) {
  test(`the review view fits ${size.width}x${size.height} without sideways scrolling and keeps apply in reach`, async ({ page }) => {
    await page.setViewportSize(size);
    await toReview(page, 'scenario=run&fail=2');
    await row(page, 'The Lost Key Shop').click();
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth - window.innerWidth,
      main: (document.querySelector('main') as HTMLElement).scrollWidth - (document.querySelector('main') as HTMLElement).clientWidth
    }));
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.main).toBeLessThanOrEqual(0);
    const apply = page.getByRole('button', { name: /^월드에 적용 \(/ });
    await expect(apply).toBeInViewport();
    // The source column stays readable beside the detail panel.
    const width = await page.locator('td.c-source').first().evaluate((cell) => cell.getBoundingClientRect().width);
    expect(width).toBeGreaterThan(160);
    // Beside the table when there is room, as a sheet when there is not: the editor is always reachable.
    await expect(page.locator('#translation-edit')).toBeVisible();
  });
}

const locales = [
  { locale: 'en', steps: 'Steps', run: 'Translate', resume: 'Resume Translation', title: 'Review translations', apply: /^Apply to world \(4\)$/, retry: 'Retry 1 sentences' },
  { locale: 'ja', steps: '手順一覧', run: '翻訳', resume: '翻訳を再開', title: '翻訳結果の確認', apply: /^ワールドに適用 \(4件\)$/, retry: '1件を再翻訳' }
];
for (const item of locales) {
  test(`the review view reads in ${item.locale}`, async ({ page }) => {
    await open(page, `scenario=run&fail=1&locale=${item.locale}`);
    await page.getByRole('navigation', { name: item.steps }).getByRole('button', { name: new RegExp(`^${item.run}`) }).click();
    await page.getByRole('button', { name: item.resume, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: item.title, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: item.apply })).toBeVisible();
    await expect(page.getByRole('button', { name: item.retry })).toBeVisible();
  });
}
