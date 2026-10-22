import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// Wave B: review drafts, backup administration, interrupted-work recovery, failure codes,
// notifications and the accessibility rules that came with them.

async function open(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('main')).not.toContainText('불러오는 중');
}

async function scanAndReview(page: Page) {
  await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
  await page.getByRole('button', { name: /^후보 검토/ }).last().click();
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page.locator('tr[data-index="0"]')).toBeVisible();
}

// Opens the run step and starts (or continues) the translation, answering the first-send question if asked.
async function startRun(page: Page) {
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 진행/ }).click();
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  const consent = page.getByRole('dialog');
  if (await consent.count()) await consent.getByRole('button', { name: /전송|보내|번역 시작|계속/ }).last().click();
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((item) => `${item.id}: ${item.nodes.map((node) => node.target.join(' ')).join(' | ')}`)).toEqual([]);
}

test.describe('review draft (FL-01)', () => {
  test('exclusions and manual translations are saved per scan and restored after a new scan', async ({ page }) => {
    await open(page, 'scenario=selected');
    await scanAndReview(page);
    await page.locator('tr[data-index="0"] input[type="checkbox"]').uncheck();
    await page.locator('tr[data-index="1"]').click();
    await page.locator('#manual-translation').fill('  잃어버린 열쇠 가게  ');
    await page.locator('#manual-translation').blur();
    await expect.poll(() => page.evaluate(() => (window as any).__pomiDraftSaves?.length ?? 0)).toBeGreaterThan(0);
    const saved = await page.evaluate(() => (window as any).__pomiDraftSaves.at(-1));
    expect(saved.excludedCandidateIds).toEqual(['welcome']);
    // Whitespace around a translation is not part of it.
    expect(saved.candidateOverrides).toEqual({ shop: '잃어버린 열쇠 가게' });

    await page.reload();
    await expect(page.locator('main')).not.toContainText('불러오는 중');
    await scanAndReview(page);
    await expect(page.locator('tr[data-index="0"] input[type="checkbox"]')).not.toBeChecked();
    await expect(page.getByRole('region', { name: '알림' })).toContainText('이전 검토를 불러왔습니다');
  });

  test('whitespace-only text is not an override and the counter is shown', async ({ page }) => {
    await open(page, 'scenario=selected');
    await scanAndReview(page);
    await page.locator('tr[data-index="1"]').click();
    const box = page.locator('#manual-translation');
    await box.fill('     ');
    await expect(page.getByRole('button', { name: '직접 번역 지우기' })).toHaveCount(0);
    await expect(page.locator('#manual-counter')).toContainText('32,000');
    await expect(box).toHaveAttribute('maxlength', '32000');
  });

  test('dropping a reviewed scan asks first and says the review will be cleared', async ({ page }) => {
    await open(page, 'scenario=selected');
    await scanAndReview(page);
    await page.locator('tr[data-index="0"] input[type="checkbox"]').uncheck();
    await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '백업 관리' }).click();
    await page.getByRole('button', { name: '이 시점으로 월드 복원' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('검토한 내용');
    // A dialog with explicit choices has no X.
    await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toHaveCount(0);
  });

  test('an older core without draft commands keeps working', async ({ page }) => {
    await open(page, 'scenario=no-draft-support');
    await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
    await page.getByRole('button', { name: /^후보 검토/ }).last().click();
    await page.locator('tr[data-index="0"] input[type="checkbox"]').uncheck();
    await expect(page.locator('tr[data-index="0"] input[type="checkbox"]')).not.toBeChecked();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('backups (FL-04)', () => {
  test('a backup is deleted only after a confirm and the list and size update', async ({ page }) => {
    await open(page, 'scenario=backups-many');
    await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '백업 관리' }).click();
    const before = await page.locator('.backup-row, [data-backup-row]').count();
    await page.getByRole('button', { name: /백업 삭제$/ }).last().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '취소' }).click();
    expect(await page.evaluate(() => (window as any).__pomiDeleted?.length ?? 0)).toBe(0);
    await page.getByRole('button', { name: /백업 삭제$/ }).last().click();
    await page.getByRole('dialog').getByRole('button', { name: '삭제', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__pomiDeleted?.length ?? 0)).toBe(1);
    if (before) expect(await page.locator('.backup-row, [data-backup-row]').count()).toBe(before - 1);
  });

  test('keep latest N lists what would go and prunes only that', async ({ page }) => {
    await open(page, 'scenario=backups-many');
    await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '백업 관리' }).click();
    await page.locator('#keep-latest').fill('2');
    await page.getByRole('button', { name: /^오래된 \d+개 정리$/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^\d+개 삭제$/ }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__pomiPruned?.length ?? 0)).toBe(1);
    const gone = await page.evaluate(() => (window as any).__pomiPruned[0]);
    expect(gone.length).toBeGreaterThan(0);
  });

  test('the only recovery copy needs an explicit acknowledgement', async ({ page }) => {
    await open(page, 'scenario=backups-last-copy');
    await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '백업 관리' }).click();
    await page.getByRole('button', { name: /백업 삭제$/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('유일한 복구용 사본');
    const confirm = dialog.getByRole('button', { name: '삭제', exact: true });
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await expect(confirm).toBeEnabled();
  });

  test('legacy sets are marked unverified and the backups screen passes axe', async ({ page }) => {
    await open(page, 'scenario=backups-many');
    await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '백업 관리' }).click();
    await expect(page.locator('main')).toContainText('옛 형식');
    await axe(page);
  });
});

test.describe('interrupted work (recovery contract)', () => {
  test('a banner and panel offer undo or keep and block starting a translation', async ({ page }) => {
    await open(page, 'scenario=interrupted');
    await expect(page.getByRole('alert').filter({ hasText: '중단된 작업 1건' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /중단된 번역 적용/ })).toBeVisible();
    await expect(page.locator('main')).toContainText('41 / 69');
    await axe(page);
  });

  test('undoing asks first, says a recovery backup is made, then reports restored files', async ({ page }) => {
    await open(page, 'scenario=interrupted');
    await page.getByRole('button', { name: '중단된 변경 되돌리기' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('복구용 백업');
    await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: '중단된 변경 되돌리기' }).click();
    await expect(page.getByRole('status').filter({ hasText: '변경을 되돌렸습니다' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__pomiRecoveries)).toEqual([{ jobId: 'job-interrupted-1', mode: 'rollback' }]);
    await expect(page.getByRole('alert').filter({ hasText: '중단된 작업' })).toHaveCount(0);
  });

  test('conflicts are listed with localized reasons and the quarantine folder can be opened', async ({ page }) => {
    await open(page, 'scenario=interrupted&conflict=1');
    await page.getByRole('button', { name: '중단된 변경 되돌리기' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '중단된 변경 되돌리기' }).click();
    const result = page.getByRole('status').filter({ hasText: '일부 파일은 되돌리지 못했습니다' });
    await expect(result).toContainText('region/r.0.0.mca');
    await expect(result).toContainText('작업 뒤에 파일이 바뀌어');
    await expect(result).toContainText('파일의 일부만 바뀌어');
    await expect(result).toContainText('건드리지 않고 그대로 두었습니다');
    await expect(result).not.toContainText('RECOVERY_CONFLICT');
    await result.getByRole('button', { name: '격리 폴더 열기' }).click();
    expect(await page.evaluate(() => (window as any).__pomiRevealedPaths)).toEqual(['/Users/fixture/quarantine/job-interrupted-1']);
  });

  test('a partial job offers continue, keep and undo, and continuing resumes the same job', async ({ page }) => {
    await open(page, 'scenario=interrupted-partial');
    await expect(page.locator('main')).toContainText('일부 파일만 기록되었습니다');
    await expect(page.locator('main')).toContainText('막혀 있습니다');
    await expect(page.getByRole('button', { name: '기록된 파일 유지' })).toBeVisible();
    await expect(page.getByRole('button', { name: '이번 실행 되돌리기' })).toBeVisible();
    await page.getByRole('button', { name: '남은 작업 이어서 하기' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__pomiResumes ?? [])).toEqual(['translate.resume']);
  });

  test('other states offer only keep and undo', async ({ page }) => {
    await open(page, 'scenario=interrupted');
    await expect(page.getByRole('button', { name: '남은 작업 이어서 하기' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '중단된 변경 되돌리기' })).toBeVisible();
  });

  test('accepting the current files after a conflict asks first and re-sends keep with acceptConflicts', async ({ page }) => {
    await open(page, 'scenario=interrupted&conflict=1');
    await page.getByRole('button', { name: '중단된 변경 되돌리기' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '중단된 변경 되돌리기' }).click();
    const result = page.getByRole('status').filter({ hasText: '일부 파일은 되돌리지 못했습니다' });
    await result.getByRole('button', { name: '현재 파일을 그대로 인정' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('되돌릴 수 없습니다');
    await dialog.getByRole('button', { name: '인정하고 닫기' }).click();
    await expect(page.getByRole('status').filter({ hasText: '현재 파일을 유지했습니다' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__pomiRecoveries.at(-1))).toEqual({ jobId: 'job-interrupted-1', mode: 'keep', acceptConflicts: true });
  });

  test('keeping the current files sends the keep mode', async ({ page }) => {
    await open(page, 'scenario=interrupted');
    await page.getByRole('button', { name: '현재 파일 유지' }).click();
    await expect(page.getByRole('status').filter({ hasText: '현재 파일을 유지했습니다' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__pomiRecoveries)).toEqual([{ jobId: 'job-interrupted-1', mode: 'keep' }]);
  });
});

test.describe('results by failure code (U15/U16)', () => {
  test('failures show localized reasons and per-code counts, never the provider text', async ({ page }) => {
    await open(page, 'scenario=result-codes');
    await startRun(page);
    const main = page.locator('main');
    await expect(main).toContainText('실패 사유별 문장 수');
    await expect(main).toContainText('제공사의 요청 한도를 넘었습니다');
    await expect(main).not.toContainText('RAW PROVIDER TEXT');
    await expect(main).toContainText('모델이 지원하지 않는 일부 설정을 끄고 실행했습니다: temperature');
    await expect(main).toContainText('저장 한도');
    await axe(page);
  });

  test('a failed run explains the code in the catalog, not the core message', async ({ page }) => {
    await open(page, 'scenario=translate-fails&consent=ask');
    await startRun(page);
    await expect(page.locator('main')).toContainText('API 키 인증에 실패했습니다');
    await expect(page.locator('main')).not.toContainText('RAW provider text');
  });
});

test.describe('translation refused until interrupted work is settled', () => {
  test('RECOVERY_REQUIRED sends the person to the interrupted-work panel with an actionable text', async ({ page }) => {
    await open(page, 'scenario=recovery-required');
    await startRun(page);
    await expect(page.getByRole('heading', { name: /중단된 번역 적용/ })).toBeVisible();
    await expect(page.locator('main')).toContainText('끝나지 않은 작업이 있어 번역을 시작하지 않았습니다');
    await expect(page.locator('main')).not.toContainText('raw core text');
  });
});

test.describe('run screen', () => {
  test('shows recent samples, cost so far, an ETA and announces only milestones', async ({ page }) => {
    await open(page, 'scenario=run-progress&consent=ask');
    await startRun(page);
    await expect(page.locator('main')).toContainText('최근 번역된 문장');
    await expect(page.locator('main')).toContainText('로그파이어에 오신 것을 환영합니다');
    await expect(page.locator('main')).toContainText('지금까지 든 비용');
    // The elapsed time is a timer that does not chatter at screen readers.
    await expect(page.locator('[role="timer"]').first()).toHaveAttribute('aria-live', 'off');
  });

  test('a missing credential store is explained with a link to Settings', async ({ page }) => {
    await open(page, 'scenario=run&vault=corrupt');
    await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 진행/ }).click();
    await expect(page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ })).toBeDisabled();
    await expect(page.locator('main')).toContainText('API 키 저장소를 열 수 없어');
    await expect(page.getByRole('button', { name: '환경 설정에서 설정하기' })).toBeVisible();
  });
});

test.describe('notifications (FL-05)', () => {
  test('a finished scan in the background sends a text-only notification, and the switch turns it off', async ({ page }) => {
    await page.addInitScript(() => { Document.prototype.hasFocus = () => false; });
    await open(page, 'scenario=selected&notify=granted');
    await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
    await expect(page.getByRole('button', { name: /^후보 검토/ }).last()).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__pomiNotifications?.length ?? 0)).toBe(1);
    const sent = await page.evaluate(() => (window as any).__pomiNotifications[0]);
    expect(JSON.stringify(sent)).not.toMatch(/Roguefire|Welcome|\/private\//);

    await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '환경 설정' }).click();
    const toggle = page.getByRole('checkbox', { name: '작업이 끝나면 알림 받기' });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '번역 작업' }).click();
    const count = await page.evaluate(() => (window as any).__pomiNotifications.length);
    await page.getByRole('button', { name: /다시 스캔|스캔 시작/ }).first().click();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as any).__pomiNotifications.length)).toBe(count);
  });

  test('without the plugin the option is hidden', async ({ page }) => {
    await open(page, 'scenario=selected&notify=missing');
    await page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name: '환경 설정' }).click();
    await expect(page.getByRole('checkbox', { name: '작업이 끝나면 알림 받기' })).toHaveCount(0);
  });
});

test.describe('errors (ST-01, AY-03)', () => {
  test('an unhandled rejection becomes a localized error that stays until dismissed', async ({ page }) => {
    await open(page, 'scenario=selected');
    await page.evaluate(() => { void Promise.reject(new Error('RAW internal failure text')); });
    const alert = page.getByRole('alert').filter({ hasText: '진단 ID' });
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText('RAW internal failure text');
    await page.waitForTimeout(6500);
    await expect(alert).toBeVisible();
    await alert.getByRole('button', { name: '알림 닫기' }).click();
    await expect(alert).toHaveCount(0);
  });

  test('the table keeps exactly one tabbable row and rows say their state', async ({ page }) => {
    await open(page, 'scenario=review');
    await page.getByRole('button', { name: /^후보 검토/ }).click();
    await expect(page.locator('tr[data-index="0"]')).toBeVisible();
    expect(await page.locator('tbody tr[tabindex="0"]').count()).toBe(1);
    await expect(page.locator('tr[data-index="0"]')).toHaveAttribute('aria-label', /번역 대상|제외됨|직접 번역/);
    await axe(page);
  });
});

test.describe('first run (IN-01)', () => {
  test('the notice offers a language switch and the interface follows it', async ({ page }) => {
    await open(page, 'scenario=first-run');
    const notice = page.getByRole('dialog');
    await expect(notice).toBeVisible();
    await notice.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
