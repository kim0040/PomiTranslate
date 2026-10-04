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

async function dirtySettings(page: Page, draft = 'native-close-draft') {
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.locator('#model').fill(draft);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiUnsavedSettings)).toBe(true);
}

async function requestClose(page: Page, source: 'window' | 'quit') {
  await page.evaluate((closeSource) => (window as any).__pomiEmit('pomi-close-requested', closeSource), source);
  const dialog = page.getByRole('dialog', { name: '앱을 닫기 전에 변경 사항을 확인하세요' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.close')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNativeCalls.some((call: any) => call.command === 'close_guard_ack'))).toBe(true);
  return dialog;
}

for (const choice of [
  { name: '저장하고 닫기', source: 'window' as const, save: true, finish: true },
  { name: '저장하지 않고 닫기', source: 'quit' as const, save: false, finish: true },
  { name: '계속 편집', source: 'quit' as const, save: false, finish: false }
]) {
  test(`native close request offers the existing settings dialog: ${choice.name}`, async ({ page }) => {
    await boot(page);
    await dirtySettings(page);
    const dialog = await requestClose(page, choice.source);
    await dialog.getByRole('button', { name: choice.name, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const calls = await page.evaluate(() => (window as any).__pomiNativeCalls);
    expect(calls.some((call: any) => call.command === 'finish_close' && call.args.source === choice.source)).toBe(choice.finish);
    expect(await page.evaluate(() => (window as any).__pomiRequests.some((request: any) => request.type === 'settings.set'))).toBe(choice.save);
  });
}

test('Escape chooses the safe stay action for a close request', async ({ page }) => {
  await boot(page);
  await dirtySettings(page);
  const dialog = await requestClose(page, 'window');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pomiNativeCalls.some((call: any) => call.command === 'finish_close'))).toBe(false);
  await expect(page.locator('#model')).toHaveValue('native-close-draft');
});

test('startup-stopped uses Korean catalog text instead of the raw Rust error', async ({ page }) => {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto('/?scenario=startup-stopped');
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('번역 코어가 결과를 반환하기 전에 종료되었습니다');
  await expect(alert).not.toContainText(/Translation core stopped before it returned a result|CORE_STOPPED/);
});

test('stepper shows the current label and step count at 840px while keeping accessible names', async ({ page }) => {
  await boot(page, 'selected', 840, 620);
  const stepper = page.getByRole('navigation', { name: '작업 단계' });
  await expect(stepper.locator('.step-count')).toHaveText('2/5');
  await expect(stepper.locator('.name')).toHaveCount(1);
  await expect(stepper.locator('.name')).toHaveText('월드 스캔');
  await expect(stepper.getByRole('button', { name: /월드 선택/ })).toHaveCount(1);
});

test('stepper keeps all five step names at the default window and only compacts when they cannot fit', async ({ page }) => {
  await boot(page, 'selected', 1180, 800);
  const stepper = page.getByRole('navigation', { name: '작업 단계' });
  await expect(stepper.locator('.name')).toHaveText(['월드 선택', '월드 스캔', '후보 검토', '번역 진행', '완료 결과']);
  await expect(stepper.locator('.step-count')).toHaveCount(0);
  expect(await page.locator('.toolbar').evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  // Any window above the minimum band keeps the names.
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect(stepper.locator('.name')).toHaveCount(5);
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

test('scan home explains scanning and shows the latest saved job and resume action', async ({ page }) => {
  await boot(page, 'selected');
  await expect(page.getByText('월드 파일을 읽어 번역 후보를 찾으며 API는 호출하지 않습니다.')).toBeVisible();
  const latest = page.getByRole('region', { name: '이 월드의 최근 작업' });
  // The scan card below already names the world, so the summary does not repeat it.
  await expect(latest.getByRole('heading', { level: 2 })).toHaveText('이 월드의 최근 작업');
  await expect(latest).not.toContainText('Roguefire');
  await expect(page.locator('main').getByRole('heading', { level: 2, name: /^Roguefire/ })).toHaveCount(1);
  await expect(latest).toContainText('최근 번역');
  await expect(latest).toContainText('번역 4개 · 실패 2개');
  await expect(latest).toContainText('6');
  const facts = latest.locator('.home-facts > div');
  const scanDate = (await facts.nth(0).locator('dd').innerText()).trim();
  const translationDate = (await facts.nth(2).locator('dd').innerText()).split(' · ')[0];
  await expect(facts.nth(1).locator('dd')).toHaveText('6');
  expect(scanDate).not.toBe(translationDate);

  await boot(page, 'unscanned');
  await expect(page.getByText('월드 파일을 읽어 번역 후보를 찾으며 API는 호출하지 않습니다.')).toBeVisible();
  const unscanned = page.getByRole('region', { name: '이 월드의 최근 작업' });
  await expect(unscanned.locator('.home-facts > div').nth(0).locator('dd')).toHaveText('확인 불가');
  await expect(unscanned.locator('.home-facts > div').nth(1).locator('dd')).toHaveText('확인 불가');
  await expect(unscanned).toContainText('번역 기록이 없습니다.');

  await boot(page, 'home-resume');
  const summary = page.getByRole('region', { name: '이 월드의 최근 작업' });
  await expect(summary).toContainText('번역 후보');
  await expect(summary).toContainText('일부 완료');
  await expect(summary).toContainText('번역 4개 · 실패 2개');
  await expect(summary).toContainText('6');
  await expect(page.getByRole('heading', { name: '중단한 작업을 이어서 진행할 수 있습니다' })).toBeVisible();
  await page.getByRole('button', { name: '이어서 작업' }).click();
  await expect(page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 진행/ })).toHaveAttribute('aria-current', 'step');
});

test('backup rows are compact, restore needs confirmation, the dialog has no X and passes axe', async ({ page }) => {
  await boot(page, 'selected', 840, 620);
  await page.getByRole('button', { name: '백업 관리', exact: true }).click();
  const rows = page.locator('.backup-row');
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

test('About links to the readable support guide and Help opens the CometAPI key page', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: '정보', exact: true }).click();
  const support = page.getByRole('link', { name: '형식별 지원 범위 자세히 보기' });
  await expect(support).toHaveAttribute('href', 'https://github.com/kim0040/PomiTranslate/blob/main/docs/support-matrix.md');
  await expect(page.locator('main')).not.toContainText('docs/support-matrix.md');
  await support.click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiOpened?.at(-1))).toBe('https://github.com/kim0040/PomiTranslate/blob/main/docs/support-matrix.md');

  await page.getByRole('button', { name: '도움말', exact: true }).click();
  await page.getByRole('button', { name: 'CometAPI', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiOpened?.at(-1))).toBe('https://www.cometapi.com/console/token');
});

test('candidate locations are friendly, teleport copies the command, and row menus work by mouse and keyboard', async ({ page }) => {
  await boot(page, 'review');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^후보 검토/ }).click();
  const row = page.locator('tr[data-index="1"]');
  await expect(row.locator('.c-where')).toContainText('오버월드');
  await expect(row.locator('.c-where')).toContainText('텍스트 디스플레이');
  await expect(row.locator('.c-where')).toContainText('x 24 · y 70 · z 11');
  await row.click();
  const detailPlace = page.locator('.places li').first();
  await expect(detailPlace).toHaveAttribute('title', /minecraft:text_display/);
  await detailPlace.getByRole('button', { name: '텔레포트 명령 복사' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiClipboard.at(-1))).toBe('/execute in minecraft:overworld run tp @s 24 70 11');

  await row.click({ button: 'right' });
  let menu = page.getByRole('menu', { name: '후보 작업 메뉴' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '번역 대상에서 제외' }).click();
  await expect(row.locator('input[type="checkbox"]')).not.toBeChecked();

  await row.focus();
  await page.keyboard.press('Shift+F10');
  menu = page.getByRole('menu', { name: '후보 작업 메뉴' });
  await menu.getByRole('menuitem', { name: '번역 대상에 포함' }).click();
  await expect(row.locator('input[type="checkbox"]')).toBeChecked();

  await row.focus();
  await page.keyboard.press('Shift+F10');
  menu = page.getByRole('menu', { name: '후보 작업 메뉴' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: '직접 번역 입력' }).click();
  await expect(page.locator('#manual-translation')).toBeFocused();
  await expect(page.locator('#manual-translation')).toBeVisible();

  await row.focus();
  await page.keyboard.press('Shift+F10');
  menu = page.getByRole('menu', { name: '후보 작업 메뉴' });
  await menu.getByRole('menuitem', { name: '원문 복사' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiClipboard.at(-1))).toBe('The Lost Key Shop');

  const customRow = page.locator('tr[data-index="3"]');
  await customRow.click();
  await expect(page.locator('.places li').first()).toContainText('custom:sky');
});

test('candidate menu supports roving keyboard focus, activation, Tab close, and excluded-row editing', async ({ page }) => {
  await boot(page, 'review');
  await step(page, '후보 검토');
  const row = page.locator('tr[data-index="0"]');
  await row.focus();
  await page.keyboard.press('Shift+F10');
  let menu = page.getByRole('menu', { name: '후보 작업 메뉴' });
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
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^후보 검토/ }).click();
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

test('an empty narrow review area collapses its unused side panel', async ({ page }) => {
  await boot(page, 'review', 840, 620);
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^후보 검토/ }).click();
  await expect(page.locator('.detailwrap')).toHaveCount(0);
  // The panel is the 40px hint at once: no frame may show the old 340px column (reduced-motion transitions used to).
  const hint = page.locator('.detail-hint');
  await expect(hint).toBeVisible();
  expect(await hint.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(48);
  expect(await page.locator('.workarea').evaluate((element) => getComputedStyle(element).transitionProperty)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('long jobs request notification permission lazily and notify once while unfocused', async ({ page }) => {
  await boot(page);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotificationPermissionRequests)).toBe(0);
  await page.evaluate(() => {
    const realNow = Date.now.bind(Date);
    let calls = 0;
    Date.now = () => realNow() + calls++ * 11_000;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
  });
  await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotifications.length)).toBe(1);
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^후보 검토/ }).click();
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 진행/ }).click();
  await page.getByRole('button', { name: /번역 시작/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotifications.length)).toBe(2);
  await page.getByRole('button', { name: '백업 관리', exact: true }).click();
  await page.locator('.backup-row').first().getByRole('button', { name: '이 시점으로 월드 복원' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '이 시점으로 월드 복원' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotifications.length)).toBe(3);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotificationPermissionRequests)).toBe(1);
  const notices = await page.evaluate(() => (window as any).__pomiNotifications);
  expect(notices.every((notice: any) => notice.title === 'PomiTranslate' && notice.body.includes('Roguefire'))).toBe(true);
  expect(JSON.stringify(notices)).not.toContain('/private/');
});

test('notify_on_finish false suppresses native permission prompts and delivery', async ({ page }) => {
  await boot(page, 'selected&notify=off');
  await page.evaluate(() => {
    const realNow = Date.now.bind(Date);
    let calls = 0;
    Date.now = () => realNow() + calls++ * 11_000;
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
  });
  await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
  await expect(page.locator('.working')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotifications.length)).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNotificationPermissionRequests)).toBe(0);
});

for (const theme of ['light', 'dark']) {
  for (const viewport of [{ width: 1180, height: 800 }, { width: 840, height: 620 }]) {
    test(`${theme} review and backups fit ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await boot(page, `review&theme=${theme}`, viewport.width, viewport.height);
      await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^후보 검토/ }).click();
      await expect(page.locator('tr[data-index="0"]')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: `output/playwright/native-review-${theme}-${viewport.width}.png`, fullPage: true });
      await page.getByRole('button', { name: '백업 관리', exact: true }).click();
      await expect(page.locator('.backup-row')).toHaveCount(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.screenshot({ path: `output/playwright/native-backups-${theme}-${viewport.width}.png`, fullPage: true });
    });
  }
}
