import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

type Locale = 'ko' | 'en' | 'ja';

async function scanned(page: Page, chunks: string, locale: Locale = 'ko') {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=selected&chunks=${chunks}&locale=${locale}`);
  await expect(page.locator('.boot')).toHaveCount(0);
  await page.getByRole('button', { name: /^(스캔 시작|Start Scan|スキャン開始)$/ }).click();
  await expect(page.locator('.action-bar')).toBeVisible();
}
const card = (page: Page) => page.getByTestId('chunk-coverage');
async function goStep(page: Page, name: RegExp) {
  await page.getByRole('navigation', { name: /작업 단계|Steps|ステップ/ }).getByRole('button', { name }).click();
}
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

test('mixed versions: level.dat, the chunk range and a details table, in Korean', async ({ page }) => {
  await scanned(page, 'mixed');
  await expect(card(page).getByRole('heading', { name: '청크 검사 범위' })).toBeVisible();
  await expect(page.getByTestId('chunk-level')).toHaveText('4189');
  await expect(page.getByTestId('chunk-versions')).toContainText('혼합');
  await expect(page.getByTestId('chunk-versions')).toContainText('4189–4556');
  await expect(page.getByTestId('chunk-versions')).toContainText('버전이 없는 청크 있음');
  await expect(card(page).locator('[data-status="processed"]')).toContainText('120');
  // Mixed is not newer than tested, so there is no warning and no confirmation to give.
  await expect(page.getByTestId('newer-version-notice')).toHaveCount(0);
  const details = card(page).locator('details.more');
  await expect(details.locator('table').first()).toBeHidden();
  await details.locator('summary').click();
  await expect(details.getByRole('table').first()).toBeVisible();
  await expect(details.getByRole('table').first()).toContainText('버전 없음');
  await expect(details.getByRole('table').nth(1)).toContainText('LZ4');
  await expect(details.getByRole('heading', { name: '네더 · 지형' })).toBeVisible();
  await axe(page);
});

test('skipped and unreadable chunks are counted beside the result', async ({ page }) => {
  await scanned(page, 'skipped');
  await expect(card(page).locator('[data-status="skipped_unsupported"]')).toContainText('15');
  await expect(card(page).locator('[data-status="unreadable"]')).toContainText('4');
  await expect(card(page).locator('[data-status="not_inspected"]')).toContainText('6');
  await expect(card(page)).toContainText('스캔에서 제외되었습니다');
  await card(page).locator('summary').click();
  await expect(card(page).getByRole('table').nth(1)).toContainText('127');
  await axe(page);
});

test('zero candidates with skipped chunks never reads as "this world has no text"', async ({ page }) => {
  await scanned(page, 'empty');
  const warning = page.getByText('월드의 일부를 검사하지 못했습니다');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('건너뜀(미지원) 15');
  await expect(warning).toContainText('읽을 수 없음 4');
  await expect(warning).toContainText('번역할 글이 없다는 뜻은 아닙니다');
  await axe(page);
});

test('an older core without chunk coverage keeps the earlier screen', async ({ page }) => {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto('/?scenario=selected');
  await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
  await expect(page.locator('.action-bar')).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByTestId('newer-version-notice')).toHaveCount(0);
  await goStep(page, /^후보 검토/);
  await expect(page.getByTestId('chunk-coverage-compact')).toHaveCount(0);
});

test('the review header carries the one-line version summary', async ({ page }) => {
  await scanned(page, 'mixed');
  await goStep(page, /^후보 검토/);
  const line = page.getByTestId('chunk-coverage-compact');
  await expect(line).toContainText('혼합');
  await expect(line).toContainText('4189–4556');
  await axe(page);
});

test('newer chunks: warned on the scan, confirmed once on the run step, then sent', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url());
  });
  await scanned(page, 'newer');
  const notice = page.getByTestId('newer-version-notice');
  await expect(notice).toContainText('검증된 데이터 버전 4556');
  await expect(notice).toContainText('이 월드 4800');
  await expect(notice).toContainText('백업은 항상 만들어집니다');
  await expect(card(page).getByTestId('chunk-versions')).toContainText('검증된 버전보다 새로움');
  await axe(page);

  await goStep(page, /^번역 진행/);
  const start = page.getByRole('button', { name: '번역 시작', exact: true });
  const confirm = page.getByRole('checkbox', { name: /내용을 이해했으며/ });
  await expect(start).toBeDisabled();
  await expect(page.getByText('위 항목에 동의해야 시작할 수 있습니다.')).toBeVisible();
  await axe(page);
  await confirm.check();
  await expect(start).toBeEnabled();
  await expect(page.getByText('위 항목에 동의해야 시작할 수 있습니다.')).toHaveCount(0);
  await start.click();
  await expect(page.getByRole('heading', { name: '번역 결과', exact: true })).toBeVisible();
  const sent = await page.evaluate(() => (window as any).__pomiRequests.filter((item: any) => item.type === 'translate.start'));
  expect(sent).toHaveLength(1);
  expect(sent[0].acceptNewerVersion).toBe(true);
  expect(external).toEqual([]);
});

test('a covered world is never asked, and its request carries no confirmation', async ({ page }) => {
  await scanned(page, 'clean');
  await expect(page.getByTestId('chunk-versions')).toHaveText('4189');
  await goStep(page, /^번역 진행/);
  await expect(page.getByRole('checkbox', { name: /내용을 이해했으며/ })).toHaveCount(0);
  await page.getByRole('button', { name: '번역 시작', exact: true }).click();
  await expect(page.getByRole('heading', { name: '번역 결과', exact: true })).toBeVisible();
  const sent = await page.evaluate(() => (window as any).__pomiRequests.filter((item: any) => item.type === 'translate.start'));
  expect(sent[0].acceptNewerVersion).toBeUndefined();
});

for (const [locale, title, mixed, newer] of [
  ['en', 'Chunk coverage', 'Mixed', 'newer game version than this app has been tested with'],
  ['ja', 'チャンク検査範囲', '混在', 'より新しいゲームバージョンで保存']
] as const) {
  test(`${locale}: texts are localized and accessible`, async ({ page }) => {
    await scanned(page, 'newer', locale);
    await expect(card(page).getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByTestId('chunk-versions')).toContainText(mixed);
    await expect(page.getByTestId('newer-version-notice')).toContainText(newer);
    await card(page).locator('summary').click();
    await axe(page);
  });
}

test('the summary does not make the page scroll sideways at a narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await scanned(page, 'skipped');
  await card(page).locator('summary').click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('dark theme keeps the summary, the warning and the confirmation readable', async ({ page }) => {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto('/?scenario=selected&chunks=newer&theme=dark');
  await expect(page.locator('.boot')).toHaveCount(0);
  await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
  await expect(card(page)).toBeVisible();
  await card(page).locator('summary').click();
  await axe(page);
  await goStep(page, /^번역 진행/);
  await expect(page.getByRole('checkbox', { name: /내용을 이해했으며/ })).toBeVisible();
  await axe(page);
});

test('a file with too many version combinations says the distribution is truncated, and the range stays exact', async ({ page }) => {
  await scanned(page, 'overflow', 'en');
  await expect(page.getByTestId('chunk-versions')).toContainText('Mixed');
  await expect(page.getByTestId('chunk-versions')).toContainText('4000–5000');
  await card(page).locator('summary').click();
  await expect(page.getByTestId('chunk-distribution-truncated')).toContainText('12 more chunks are not listed here');
  // Overflow is its own row, never shown as "Not read".
  await expect(card(page).getByRole('table').nth(1)).toContainText('Not itemised');
  await axe(page);
});

test('a scan continued from an old checkpoint with no candidates says finished files were not searched again', async ({ page }) => {
  await scanned(page, 'resumed-empty', 'en');
  const warning = page.getByText('This scan continued a saved job, so files');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('not proof that the world has no text');
  await expect(card(page)).toContainText('may be incomplete');
  await axe(page);
});

test.describe('continuing an interrupted job of a newer world after a restart', () => {
  async function restarted(page: Page) {
    await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
    await page.goto('/?scenario=interrupted-partial&chunks=newer&locale=en');
    await expect(page.locator('.boot')).toHaveCount(0);
    await page.reload(); // the app starts again: the job and its saved plan come back from the core
    await expect(page.locator('.boot')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue the remaining work' })).toBeVisible();
  }
  const resumes = (page: Page) => page.evaluate(() => (window as any).__pomiResumes ?? []);
  const confirmBox = (page: Page) => page.getByTestId('interrupted-newer').getByRole('checkbox', { name: /I understand/ });

  test('Continue asks for the confirmation in the recovery flow, keeps the job, then resumes with it', async ({ page }) => {
    await restarted(page);
    await page.getByRole('button', { name: 'Continue the remaining work' }).click();
    // The confirmation is in the interrupted job's own panel; nothing was sent and the person is still on the world screen.
    const panel = page.getByTestId('interrupted-newer');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('newer-version-notice')).toContainText('newer game version than this app has been tested with');
    await expect(confirmBox(page)).toBeFocused();
    const go = panel.getByRole('button', { name: 'Continue the remaining work' });
    await expect(go).toBeDisabled();
    expect(await resumes(page)).toEqual([]);
    await axe(page);

    await confirmBox(page).check();
    await expect(go).toBeEnabled();
    await go.click();
    // The same tick reached the core (the fixture refuses without it) and the job is settled.
    await expect.poll(() => resumes(page)).toEqual(['translate.resume']);
    await expect(page.getByTestId('interrupted-newer')).toHaveCount(0);
  });

  test('cancelling leaves the job open and unticked', async ({ page }) => {
    await restarted(page);
    await page.getByRole('button', { name: 'Continue the remaining work' }).click();
    await confirmBox(page).check();
    await page.getByTestId('interrupted-newer').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('interrupted-newer')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue the remaining work' })).toBeVisible();
    expect(await resumes(page)).toEqual([]);
    // Continue asks again from the start.
    await page.getByRole('button', { name: 'Continue the remaining work' }).click();
    await expect(confirmBox(page)).not.toBeChecked();
  });

  test('a box ticked on the run step counts when Continue is chosen for the same saved scan', async ({ page }) => {
    await restarted(page);
    await page.getByRole('button', { name: 'Continue the remaining work' }).click();
    await confirmBox(page).check();
    await goStep(page, /^Translate/);
    await expect(page.getByRole('checkbox', { name: /I understand/ })).toBeChecked();
    await goStep(page, /^Select World/);
    await page.getByRole('button', { name: 'Continue the remaining work' }).click();
    await expect.poll(() => resumes(page)).toEqual(['translate.resume']);
  });
});
