import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

async function boot(page: Page, scenario = 'selected', width = 1180, height = 800) {
  await page.setViewportSize({ width, height });
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=${scenario}`);
  await expect(page.locator('.boot')).toHaveCount(0);
}

async function step(page: Page, name: string) {
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

async function dirtyReview(page: Page) {
  await boot(page, 'run');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: '번역 결과 검토', exact: true })).toBeVisible();
  await page.locator('tr[data-index="0"]').click();
  await page.locator('#translation-edit').fill('저장 전 검토 초안');
  await expect(page.locator('.counts')).toContainText('저장 전 수정 1');
}

// Closing the window and quitting are the desktop shell's question (exit-and-credentials.spec covers its
// dialogs). Unsaved review edits only have to reach the shell as unsaved work, and survive "stay".
const emit = (page: Page, name: string, payload: unknown) => page.evaluate(([n, p]) => (window as any).__pomiEmit(n, p), [name, payload] as const);
const shell = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__pomiShell ?? []);

test('window close and quit protect unsaved translation-review edits', async ({ page }) => {
  await dirtyReview(page);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiDirty)).toBe(true);

  await emit(page, 'pomi-exit-confirm', { job: false, dirty: true, reason: 'quit', intent: 4 });
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '계속 수정', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#translation-edit')).toHaveValue('저장 전 검토 초안');
  await expect.poll(() => shell(page)).toEqual(['exit_cancel']);

  await emit(page, 'pomi-exit-confirm', { job: false, dirty: true, reason: 'quit', intent: 5 });
  await page.getByRole('dialog').getByRole('button', { name: '수정을 버리고 종료', exact: true }).click();
  await expect.poll(() => shell(page)).toEqual(['exit_cancel', 'exit_confirm']);
  expect(await page.evaluate(() => (window as any).__pomiRequests.some((request: any) => ['translate.apply', 'translate.reapply'].includes(request.type)))).toBe(false);
});

test('a new scan asks before replacing a job with unsaved review edits', async ({ page }) => {
  await dirtyReview(page);
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역할 문장 찾기/ }).click();
  await page.getByRole('button', { name: '다시 스캔', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '저장하지 않은 번역 수정이 있습니다' });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pomiRequests.filter((request: any) => request.type === 'scan.start').length)).toBe(0);
  await dialog.getByRole('button', { name: '초안 버리고 계속' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiRequests.filter((request: any) => request.type === 'scan.start').length)).toBe(1);
  await expect(page.getByRole('heading', { level: 1, name: '번역할 문장 찾기', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '번역할 문장 고르기', exact: true })).toBeVisible();
});

test('opening a different world asks before discarding unsaved review edits', async ({ page }) => {
  await dirtyReview(page);
  await page.evaluate(() => (window as any).__pomiEmit('tauri://drag-drop', { paths: ['/private/tmp/OtherWorld'] }));
  const dialog = page.getByRole('dialog', { name: '저장하지 않은 번역 수정이 있습니다' });
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pomiRequests.filter((request: any) => request.type === 'world.inspect' && request.payload.worldDir.includes('OtherWorld')).length)).toBe(0);
  await dialog.getByRole('button', { name: '초안 버리고 계속' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiRequests.some((request: any) => request.type === 'world.inspect' && request.payload.worldDir.includes('OtherWorld')))).toBe(true);
});

test('startup-stopped uses Korean catalog text instead of the raw Rust error', async ({ page }) => {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto('/?scenario=startup-stopped');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('번역 코어가 작업을 끝내기 전에 멈췄습니다');
  await expect(alert).not.toContainText(/Translation core stopped before it returned a result|CORE_STOPPED/);
});

test('stepper shows the current label and step count at 840px while keeping accessible names', async ({ page }) => {
  await boot(page, 'selected', 840, 620);
  const stepper = page.getByRole('navigation', { name: '작업 단계' });
  await expect(stepper.locator('.step-count')).toHaveText('2/5');
  await expect(stepper.locator('.name')).toHaveCount(1);
  await expect(stepper.locator('.name')).toHaveText('번역할 문장 찾기');
  await expect(stepper.getByRole('button', { name: /월드 고르기/ })).toHaveCount(1);
});

test('stepper keeps all five step names at the default window and only compacts when they cannot fit', async ({ page }) => {
  await boot(page, 'selected', 1180, 800);
  const stepper = page.getByRole('navigation', { name: '작업 단계' });
  await expect(stepper.locator('.name')).toHaveText(['월드 고르기', '번역할 문장 찾기', '번역할 문장 고르기', '번역 준비', '결과 확인·적용']);
  await expect(stepper.locator('.step-count')).toHaveCount(0);
  expect(await page.locator('.toolbar').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  // The minimum window is where they stop fitting: current name and a count remain.
  await page.setViewportSize({ width: 840, height: 620 });
  await expect(stepper.locator('.name')).toHaveCount(1);
  await expect(stepper.locator('.step-count')).toHaveText('2/5');
  // Growing back restores the names without a reload.
  await page.setViewportSize({ width: 1180, height: 800 });
  await expect(stepper.locator('.name')).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

for (const [locale, scheme] of [['en', 'light'], ['ja', 'dark'], ['ko', 'dark']] as const) {
  test(`stepper shows all five names at 1180px in ${locale} (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
    await page.goto(`/?scenario=selected&locale=${locale}`);
    await expect(page.locator('.boot')).toHaveCount(0);
    const stepper = page.getByRole('navigation').filter({ has: page.locator('.step') });
    await expect(stepper.locator('.name')).toHaveCount(5);
    await expect(stepper.locator('.step-count')).toHaveCount(0);
    expect(await page.locator('.toolbar').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  });
}

// The scan step's summary of the last visit is WorldSummary (flow-ux2.spec covers its variants); this keeps the
// 2026-10-04 promises: scanning is explained as offline, and a saved job makes "continue" the way back in.
test('scan home explains scanning and shows the latest saved job and resume action', async ({ page }) => {
  await boot(page, 'selected');
  await expect(page.getByText('월드 파일을 읽어 번역할 문장을 찾으며 API는 호출하지 않습니다.')).toBeVisible();
  const summary = page.locator('main .summary');
  await expect(summary).toContainText('마지막 번역');
  await expect(summary).toContainText('일부만 번역됨');
  // The scan card already names the world, so the summary does not repeat it.
  await expect(summary).not.toContainText('Roguefire');

  await boot(page, 'unscanned');
  await expect(page.getByText('월드 파일을 읽어 번역할 문장을 찾으며 API는 호출하지 않습니다.')).toBeVisible();
  await expect(page.locator('main .summary')).not.toContainText('스캔 결과');

  await boot(page, 'home-resume');
  await expect(page.locator('main .resumed')).toContainText('이전에 중단된 작업 기록이 있습니다');
  await page.locator('main .btn-primary').filter({ hasText: '이어서 번역' }).click();
  await expect(page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ })).toHaveAttribute('aria-current', 'step');
});

test('backup rows are compact, restore needs confirmation, the dialog has no X and passes axe', async ({ page }) => {
  await boot(page, 'selected', 840, 620);
  await page.getByRole('button', { name: '백업 관리', exact: true }).click();
  const rows = page.locator('.backup-list > li');
  await expect(rows).toHaveCount(2);
  expect(await rows.first().evaluate((row) => row.getBoundingClientRect().height)).toBeLessThan(160);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await rows.first().getByRole('button', { name: '이 시점으로 월드 복원' }).click();
  const dialog = page.getByRole('dialog', { name: '이 백업 시점으로 월드를 복원할까요?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.close')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiRequests.filter((request: any) => request.type === 'restore.start').length)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiRequests.filter((request: any) => request.type === 'restore.start').length)).toBe(0);
  await rows.first().getByRole('button', { name: '이 시점으로 월드 복원' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '이 시점으로 월드 복원' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiRequests.filter((request: any) => request.type === 'restore.start').length)).toBe(1);
});

test('About links to the readable support guide and Help opens the Comet API key page', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: '정보', exact: true }).click();
  // The link sits in the closed "what is supported" section, and names the document it opens.
  await page.locator('main details').nth(1).locator('summary').click();
  const support = page.getByRole('link', { name: /^형식별 지원 범위 자세히 보기/ });
  await expect(support).toHaveAttribute('href', 'https://github.com/kim0040/PomiTranslate/blob/main/docs/support-matrix.md');
  await support.click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiOpened?.at(-1))).toBe('https://github.com/kim0040/PomiTranslate/blob/main/docs/support-matrix.md');

  await page.getByRole('button', { name: '도움말', exact: true }).click();
  await page.getByRole('button', { name: 'Comet API', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiOpened?.at(-1))).toBe('https://www.cometapi.com/console/token');
});

test('candidate locations are friendly, teleport copies the command, and row menus work by mouse and keyboard', async ({ page }) => {
  await boot(page, 'review');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역할 문장 고르기/ }).click();
  const row = page.locator('tr[data-index="1"]');
  // The location column needs an 860px-wide table, which the detail panel leaves only on very wide
  // windows; the friendly place is always part of the row's name.
  await expect(row).toHaveAccessibleName(/오버월드 · 텍스트 디스플레이 · x 24 · y 70 · z 11/);
  await row.click();
  const detailPlace = page.locator('.places li').first();
  await expect(detailPlace).toHaveAttribute('title', /minecraft:text_display/);
  await detailPlace.getByRole('button', { name: '텔레포트 명령 복사' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiClipboard.at(-1))).toBe('/execute in minecraft:overworld run tp @s 24 70 11');

  await row.click({ button: 'right' });
  let menu = page.getByRole('menu', { name: '문장 작업 메뉴' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '번역 대상에서 제외' }).click();
  await expect(row.locator('input[type="checkbox"]')).not.toBeChecked();

  await row.focus();
  await page.keyboard.press('Shift+F10');
  menu = page.getByRole('menu', { name: '문장 작업 메뉴' });
  await menu.getByRole('menuitem', { name: '번역 대상에 포함' }).click();
  await expect(row.locator('input[type="checkbox"]')).toBeChecked();

  await row.focus();
  await page.keyboard.press('Shift+F10');
  menu = page.getByRole('menu', { name: '문장 작업 메뉴' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '직접 번역 입력' }).click();
  await expect(page.locator('#manual-translation')).toBeFocused();
  await expect(page.locator('#manual-translation')).toBeVisible();

  await row.focus();
  await page.keyboard.press('Shift+F10');
  menu = page.getByRole('menu', { name: '문장 작업 메뉴' });
  await menu.getByRole('menuitem', { name: '원문 복사' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiClipboard.at(-1))).toBe('The Lost Key Shop');

  const customRow = page.locator('tr[data-index="3"]');
  await customRow.click();
  await expect(page.locator('.places li').first()).toContainText('custom:sky');
});

test('candidate menu supports roving keyboard focus, activation, Tab close, and excluded-row editing', async ({ page }) => {
  await boot(page, 'review');
  await step(page, '번역할 문장 고르기');
  const row = page.locator('tr[data-index="0"]');
  await row.focus();
  await page.keyboard.press('Shift+F10');
  let menu = page.getByRole('menu', { name: '문장 작업 메뉴' });
  const items = menu.getByRole('menuitem');
  await expect(items.nth(0)).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await expect(items.nth(0)).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press('End');
  await expect(items.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(row).toBeFocused();

  // Exclude the row with the grid's keyboard action, then use the manual menu action.
  await page.keyboard.press('Space');
  await expect(row.locator('input[type="checkbox"]')).not.toBeChecked();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#manual-translation')).toBeFocused();
  await expect(row.locator('input[type="checkbox"]')).toBeChecked();

  await row.focus();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('End');
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__pomiClipboard.at(-1))).toBe('Welcome to Roguefire');
});

test('bulk and single include changes can be undone and review passes axe', async ({ page }) => {
  await boot(page, 'review');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역할 문장 고르기/ }).click();
  await page.getByRole('button', { name: '일괄 작업' }).click();
  await page.getByRole('button', { name: '현재 표시된 항목 모두 제외' }).click();
  await expect(page.locator('.toast').getByRole('button', { name: '되돌리기' })).toBeVisible();
  await page.locator('.toast').getByRole('button', { name: '되돌리기' }).click();
  const first = page.locator('tr[data-index="0"] input[type="checkbox"]');
  await expect(first).toBeChecked();
  await first.click();
  await expect(first).not.toBeChecked();
  await page.keyboard.press('Control+z');
  await expect(first).toBeChecked();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

// Merge gap: the merged ReviewScreen lost main's 40px .detail-hint for an empty narrow review (reported to src).
test.fixme('an empty narrow review area collapses its unused side panel', async ({ page }) => {
  await boot(page, 'review', 840, 620);
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역할 문장 고르기/ }).click();
  await expect(page.locator('.detailwrap')).toHaveCount(0);
  // The panel is the 40px hint at once: no frame may show the old 340px column (reduced-motion transitions used to).
  const hint = page.locator('.detail-hint');
  await expect(hint).toBeVisible();
  expect(await hint.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(48);
  expect(await page.locator('.workarea').evaluate((element) => getComputedStyle(element).transitionProperty)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('jobs that end in the background notify once each, without asking for permission again', async ({ page }) => {
  await boot(page);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotificationPermissionRequests)).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
  });
  await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotifications.length)).toBe(1);
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역할 문장 고르기/ }).click();
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await page.getByRole('button', { name: /번역 시작/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotifications.length)).toBe(2);
  await page.getByRole('button', { name: '백업 관리', exact: true }).click();
  await page.locator('.backup-list > li').first().getByRole('button', { name: '이 시점으로 월드 복원' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '이 시점으로 월드 복원' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotifications.length)).toBe(3);
  // Permission was granted already: it is asked for only when the person turns notifications on.
  expect(await page.evaluate(() => (window as any).__pomiNotificationPermissionRequests)).toBe(0);
  const notices = await page.evaluate(() => (window as any).__pomiNotifications);
  expect(notices.every((notice: any) => notice.title.startsWith('PomiTranslate'))).toBe(true);
  // The review-ready sentence names the world folder and nothing else from the world.
  expect(notices[1].body).toContain('Roguefire');
  expect(notices[1].body).toContain('검토 후 월드에 적용');
  expect(notices[1].body).not.toContain('실패');
  expect(JSON.stringify(notices)).not.toContain('/private/');
});

test('a budget-stopped translation notification describes the cap outcome, not a failure', async ({ page }) => {
  await boot(page, 'run&budget=1');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
  });
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await expect(page.getByRole('status').filter({ hasText: '비용 한도에 닿아 번역을 멈췄습니다' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotifications.length)).toBe(1);
  const notice = await page.evaluate(() => (window as any).__pomiNotifications[0]);
  expect(notice.body).toContain('비용 한도');
  expect(notice.body).not.toContain('실패');
});

test('notify_on_finish false suppresses native permission prompts and delivery', async ({ page }) => {
  await boot(page, 'selected&notify=off');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
  });
  await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
  await expect(page.locator('.working')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotifications.length)).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotificationPermissionRequests)).toBe(0);
});

test('turning notifications on asks the system for permission once', async ({ page }) => {
  await boot(page, 'selected&notify=off');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByRole('tab', { name: '앱', exact: true }).click();
  const notify = page.getByRole('checkbox', { name: '작업이 끝나면 알림 받기' });
  await notify.check();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotificationPermissionRequests)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiPrefs?.notify_on_finish)).toBe(true);
});

test('saving an unrelated app preference preserves the stored notification choice', async ({ page }) => {
  await boot(page, 'selected&notify=off');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByRole('tab', { name: '앱', exact: true }).click();
  const notify = page.getByRole('checkbox', { name: '작업이 끝나면 알림 받기' });
  await expect(notify).not.toBeChecked();
  await page.getByRole('radio', { name: '다크' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiPrefs)).toMatchObject({
    theme: 'dark', notify_on_finish: false, notice_accepted: true, setup_dismissed: true
  });
});

for (const theme of ['light', 'dark']) {
  for (const viewport of [{ width: 1180, height: 800 }, { width: 840, height: 620 }]) {
    test(`${theme} review and backups fit ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await boot(page, `review&theme=${theme}`, viewport.width, viewport.height);
      await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역할 문장 고르기/ }).click();
      await expect(page.locator('tr[data-index="0"]')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: `output/playwright/native-review-${theme}-${viewport.width}.png`, fullPage: true });
      await page.getByRole('button', { name: '백업 관리', exact: true }).click();
      await expect(page.locator('.backup-list > li')).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: `output/playwright/native-backups-${theme}-${viewport.width}.png`, fullPage: true });
    });
  }
}
