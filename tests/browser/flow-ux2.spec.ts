import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

async function open(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
}
const requests = (page: Page) => page.evaluate(() => (window as unknown as { __pomiRequests: { type: string }[] }).__pomiRequests.map((request) => request.type));
const count = async (page: Page, type: string) => (await requests(page)).filter((item) => item === type).length;
async function toRun(page: Page) {
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
}
async function runAndFinish(page: Page) {
  await toRun(page);
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await expect(page.getByRole('heading', { name: '번역 결과', exact: true })).toBeVisible();
}
const hero = (page: Page) => page.locator('main section.hero');

test.describe('a failed run with nothing to resume (U17)', () => {
  test('offers "translate again" from the same scan as the one main action, and says so', async ({ page }) => {
    await open(page, 'scenario=result-failed');
    await runAndFinish(page);
    await expect(hero(page)).toContainText('월드 파일은 그대로입니다. 같은 스캔 결과로 바로 다시 번역할 수 있고');
    await expect(page.locator('main .btn-primary')).toHaveCount(1);
    await expect(page.locator('main .btn-primary')).toHaveText('같은 스캔으로 다시 번역');
    await expect(page.getByRole('button', { name: '남은 문장만 이어서 시도' })).toHaveCount(0);
    // Scanning from the start is still there, but quiet.
    await expect(hero(page).getByRole('button', { name: '처음부터 다시 스캔' })).toHaveClass(/btn-quiet/);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    // The button goes to the run step with its cost; nothing is sent until Start is pressed.
    await hero(page).getByRole('button', { name: '같은 스캔으로 다시 번역' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '번역 준비', exact: true })).toBeVisible();
    await expect(page.getByText('예상 비용')).toBeVisible();
    // (The first run of the fixture continued a saved job, so it was the one translate.resume.)
    expect(await count(page, 'translate.start')).toBe(0);
    await page.getByRole('button', { name: '번역 시작', exact: true }).click();
    await expect(page.getByRole('heading', { name: '번역 결과', exact: true })).toBeVisible();
    expect(await count(page, 'translate.start')).toBe(1);
    expect(await count(page, 'translate.resume')).toBe(1);
    expect(await count(page, 'scan.start')).toBe(0);
  });

  test('"scan from the start" really goes back to the scan step', async ({ page }) => {
    await open(page, 'scenario=result-failed');
    await runAndFinish(page);
    await hero(page).getByRole('button', { name: '처음부터 다시 스캔' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '번역할 문장 찾기', exact: true })).toBeVisible();
  });

  test('a stopped run without saved progress does not promise to continue the saved sentences', async ({ page }) => {
    await open(page, 'scenario=result-needs_retry-bare');
    await runAndFinish(page);
    await expect(hero(page)).toContainText('이어서 할 저장된 번역도 없습니다');
    await expect(hero(page)).not.toContainText('남은 문장만 이어서');
    await expect(page.locator('main .btn-primary')).toHaveText('같은 스캔으로 다시 번역');
  });
});

test.describe('a failed run that kept a checkpoint (U17)', () => {
  // Since the 2026-10-24 merge a readable saved table makes "retry only the failed sentences" the main action
  // (review-apply.spec); continuing the remaining sentences leads when the job can be resumed but its table
  // cannot be read (?notable=1).
  test('offers the failed-only retry first when the saved table can be read', async ({ page }) => {
    await open(page, 'scenario=result-failed-resume');
    await runAndFinish(page);
    await expect(page.locator('main .btn-primary')).toHaveCount(1);
    await expect(page.locator('main .btn-primary')).toHaveText(/^\s*실패한 \d+개만 다시 번역$/);
    await expect(page.getByRole('button', { name: '같은 스캔으로 다시 번역' })).toHaveCount(0);
    await expect(hero(page)).not.toContainText('남은 문장만 이어서 번역합니다');
  });

  test('offers to continue the remaining sentences, and the text matches', async ({ page }) => {
    await open(page, 'scenario=result-failed-resume&notable=1');
    await runAndFinish(page);
    await expect(hero(page)).toContainText('저장된 번역 2개는 그대로 쓰고 남은 문장만 이어서 번역합니다.');
    await expect(page.locator('main .btn-primary')).toHaveCount(1);
    await expect(page.locator('main .btn-primary')).toHaveText('남은 문장만 이어서 시도');
    await expect(page.getByRole('button', { name: '같은 스캔으로 다시 번역' })).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    const before = await count(page, 'translate.resume');
    await page.getByRole('button', { name: '남은 문장만 이어서 시도' }).click();
    await expect(page.getByRole('heading', { name: '번역 결과', exact: true })).toBeVisible();
    expect(await count(page, 'translate.resume')).toBe(before + 1);
    expect(await count(page, 'translate.start')).toBe(0);
  });
});

test.describe('the scan step on a return visit (U7)', () => {
  test('summarises the last translation without starting a scan', async ({ page }) => {
    // history=none: the core keeps no job record, so the summary falls back to the newest backup.
    await open(page, 'scenario=selected&history=none');
    await expect(page.getByRole('heading', { level: 1, name: '번역할 문장 찾기', exact: true })).toBeVisible();
    const summary = page.locator('main .summary');
    await expect(summary).toContainText('마지막 번역');
    await expect(summary).toContainText('번역 백업');
    await expect(summary).toContainText('백업한 파일 69개');
    await expect(summary).not.toContainText('스캔 결과');
    // The main action is the scan, and nothing was started for the person.
    await expect(page.locator('main .btn-primary')).toHaveText('스캔 시작');
    expect(await requests(page)).not.toContain('scan.start');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test('says there is nothing saved for a world that was never translated', async ({ page }) => {
    await open(page, 'scenario=selected&backups=none&history=none');
    await expect(page.locator('main .summary-empty')).toContainText('저장된 스캔 결과나 번역 기록이 없습니다');
    await expect(page.locator('main .summary')).toHaveCount(0);
  });

  test('the core record of the last job and scan is summarised when there is one', async ({ page }) => {
    await open(page, 'scenario=selected');
    const summary = page.locator('main .summary');
    await expect(summary).toContainText('스캔 결과');
    await expect(summary).toContainText('번역 후보 6개');
    await expect(summary).toContainText('마지막 번역');
    await expect(summary).toContainText('일부만 번역됨');
    await expect(summary).toContainText('변경한 파일 4개');
    expect(await requests(page)).not.toContain('scan.start');
  });

  test('a saved job shows what is saved and makes "continue" the main action', async ({ page }) => {
    await open(page, 'scenario=scanned');
    const card = page.locator('main .resumed');
    await expect(card).toContainText('이전에 중단된 작업 기록이 있습니다');
    await expect(card).toContainText('스캔 결과');
    await expect(card).toContainText('번역 후보 6개');
    await expect(card).toContainText('저장된 작업');
    await expect(card).toContainText('저장된 번역 2개가 있어 남은 문장만 이어서 번역할 수 있습니다.');
    await expect(page.locator('main .btn-primary')).toHaveCount(1);
    await expect(page.locator('main .btn-primary')).toHaveText('이어서 번역');
    expect(await requests(page)).not.toContain('scan.start');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.locator('main .btn-primary').click();
    await expect(page.getByRole('heading', { level: 1, name: '번역 준비', exact: true })).toBeVisible();
  });

  test('after a run in this session the world step reports its status and changed files', async ({ page }) => {
    await open(page, 'scenario=result-partial');
    await runAndFinish(page);
    await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^월드 고르기/ }).click();
    const summary = page.locator('main .summary');
    await expect(summary).toContainText('일부만 번역됨');
    await expect(summary).toContainText('변경한 파일 4개');
  });
});

test.describe('the backups list (U8)', () => {
  test('one card names the world and lists compact rows', async ({ page }) => {
    await open(page, 'scenario=backups-many');
    await page.getByRole('button', { name: '백업 관리', exact: true }).click();
    const card = page.locator('main .list-card');
    await expect(card.getByRole('heading', { level: 2 })).toContainText('Roguefire');
    await expect(card).toContainText('백업 7개 보존 중');
    // The world card above the list is gone: the name and the count appear once.
    await expect(page.getByText('선택한 월드', { exact: true })).toHaveCount(0);
    await expect(page.getByText('백업 7개 보존 중')).toHaveCount(1);
    const rows = card.locator('.backup-list > li');
    await expect(rows).toHaveCount(7);
    // Time, kind, size and the actions fit in one or two lines.
    for (const index of [0, 1, 2]) expect((await rows.nth(index).boundingBox())!.height).toBeLessThan(76);
    await expect(rows.first()).toContainText('번역 전 자동 백업');
    await expect(rows.first()).toContainText('1.8 MB');
    await expect(rows.first().getByRole('button', { name: '이 시점으로 월드 복원' })).toBeVisible();
  });

  test('the id line opens on request and passes axe', async ({ page }) => {
    await open(page, 'scenario=backups-many');
    await page.getByRole('button', { name: '백업 관리', exact: true }).click();
    const first = page.locator('main .backup-list > li').first();
    const more = first.getByRole('button', { name: '상세 정보' });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(first.locator('.backup-id')).toHaveCount(0);
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(first.locator('.backup-id')).toContainText('2026-09-29T16-24-18Z-translation');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test('an unrestored world with no backups still names the world', async ({ page }) => {
    await open(page, 'scenario=selected&backups=none');
    await page.getByRole('button', { name: '백업 관리', exact: true }).click();
    await expect(page.locator('main .list-card').getByRole('heading', { level: 2 })).toContainText('Roguefire');
    await expect(page.getByText('보관된 백업이 없습니다', { exact: false })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

test('the scan support card on the About page has no state badge in its header (U10)', async ({ page }) => {
  await open(page, 'scenario=selected');
  await page.getByRole('button', { name: '정보', exact: true }).click();
  const card = page.locator('.about .sections details').nth(1);
  await expect(card.locator('summary h2')).toHaveText('스캔 지원 범위');
  await expect(card.locator('summary .pill')).toHaveCount(0);
  await card.locator('summary').click();
  // The labels stay where they belong: on the lists inside.
  await expect(card.locator('h3 .pill').first()).toBeVisible();
});

test.describe('elapsed time and the remaining-time estimate (U11)', () => {
  async function runWithClock(page: Page, mode: string) {
    await page.clock.install();
    await open(page, `scenario=run-progress&progress=${mode}`);
    await toRun(page);
    await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
    await expect(page.getByRole('progressbar')).toBeVisible();
  }
  const elapsed = (page: Page) => page.evaluate(() => ({
    side: document.querySelector('.sidebar .state .sub')?.textContent?.trim() ?? '',
    page: (document.querySelector('main [role="timer"]')?.textContent ?? '').replace(/^[^:：]*[:：]\s*/, '').trim()
  }));

  test('the sidebar and the run screen read one clock', async ({ page }) => {
    await runWithClock(page, 'eta');
    for (const seconds of [1, 1, 3, 2, 7]) {
      await page.clock.runFor(seconds * 1000);
      const { side, page: main } = await elapsed(page);
      expect(side).not.toBe('');
      expect(main).toBe(side);
    }
  });

  test('shows an approximate remaining time only after 10% and 20 seconds, at a steady pace', async ({ page }) => {
    await runWithClock(page, 'eta');
    const eta = page.getByText(/^남은 시간 약 /);
    // 18% after 15 s: enough progress, but not enough time.
    await page.clock.runFor(16_000);
    await expect(page.getByText('18 / 100', { exact: false }).first()).toBeVisible();
    await expect(eta).toHaveCount(0);
    // 36% after 31 s: a steady 1.2 sentences a second leaves about a minute.
    await page.clock.runFor(15_000);
    await expect(eta).toHaveCount(1);
    await expect(eta).toContainText('약');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test('hides the estimate when progress stalls, during a retry and while cancelling, and keeps the clock running', async ({ page }) => {
    const eta = page.getByText(/^남은 시간 약 /);
    await runWithClock(page, 'eta-retry');
    // Events every 5 s up to 36% at 30 s; the estimate is shown just after.
    await page.clock.runFor(31_000);
    await expect(eta).toHaveCount(1);
    // A rate-limit retry is reported at 33 s: no countdown while it lasts.
    await page.clock.runFor(3_000);
    await expect(page.getByText(/재시도 중입니다/)).toBeVisible();
    await expect(eta).toHaveCount(0);
    // 50 s without progress: still hidden, while the elapsed clock keeps running.
    const before = (await elapsed(page)).page;
    await page.clock.runFor(50_000);
    await expect(eta).toHaveCount(0);
    expect((await elapsed(page)).page).not.toBe(before);
  });

  test('hides the estimate once progress is older than three typical gaps, with no retry reported', async ({ page }) => {
    await runWithClock(page, 'eta');
    const eta = page.getByText(/^남은 시간 약 /);
    await page.clock.runFor(31_000);
    await expect(eta).toHaveCount(1);
    await page.clock.runFor(10_000);
    await expect(eta).toHaveCount(1);
    // Last progress at 30 s; at 50 s the limit (15 s) is long past, yet the old prediction would still show 10 s or more.
    await page.clock.runFor(10_000);
    await expect(eta).toHaveCount(0);
  });

  test('hides the estimate while cancelling', async ({ page }) => {
    await runWithClock(page, 'eta');
    const eta = page.getByText(/^남은 시간 약 /);
    await page.clock.runFor(31_000);
    await expect(eta).toHaveCount(1);
    await page.getByRole('button', { name: '번역 취소', exact: true }).click();
    await expect(page.getByRole('button', { name: /안전하게 정리하고 중단하는 중/ })).toBeDisabled();
    await expect(eta).toHaveCount(0);
  });

  test('hides the estimate while the pace is jumping about', async ({ page }) => {
    await runWithClock(page, 'eta-wobble');
    await page.clock.runFor(31_000);
    await expect(page.getByText('90 / 100', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/^남은 시간 약 /)).toHaveCount(0);
  });
});
