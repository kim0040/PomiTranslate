import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// What the page does with the answers of the Rust shell and the core: a reset that stopped half way,
// the update question, a Custom key that must be typed again, undone resumes, and the live feed.
// The fixture stands in for the shell (tests/frontend/tauri-fixture-init.js).
async function boot(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
}
const emit = (page: Page, name: string, payload: unknown) => page.evaluate(([n, p]) => (window as any).__pomiEmit(n, p), [name, payload] as const);
const shell = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__pomiShell ?? []);
const calls = (page: Page): Promise<{ command: string; args: { intent: number } }[]> => page.evaluate(() => (window as any).__pomiCalls ?? []);
const requests = (page: Page, type: string): Promise<number> => page.evaluate((t) => (window as any).__pomiRequests.filter((r: { type: string }) => r.type === t).length, type);
const toRun = (page: Page) => page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 진행/ }).click();
const openSettings = (page: Page) => page.getByRole('button', { name: '환경 설정', exact: true }).click();
// Updates, data and reset live in the "App" part, which applies at once and has nothing unsaved.
const openAppSettings = async (page: Page) => {
  await openSettings(page);
  await page.getByRole('tab', { name: '앱', exact: true }).click();
};
async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((item) => `${item.id}: ${item.nodes.map((node) => node.target.join(' ')).join(' | ')}`)).toEqual([]);
}

async function toResetConfirm(page: Page) {
  await openAppSettings(page);
  await page.getByRole('button', { name: '초기화…' }).click();
  await page.getByRole('dialog', { name: '앱을 초기화할까요?' }).getByRole('button', { name: '초기화 계속', exact: true }).click();
  return page.getByRole('dialog', { name: '정말 초기화할까요?' });
}

test.describe('reset that stops half way (2, 8)', () => {
  test('an unconfirmed keychain stops before the core, says what is left, and Try again finishes it', async ({ page }) => {
    await boot(page, 'scenario=selected&reset=unconfirmed-once');
    const confirm = await toResetConfirm(page);
    await confirm.getByRole('button', { name: '초기화', exact: true }).click();
    const left = confirm.getByRole('alert');
    await expect(left).toContainText('초기화를 끝내지 못했습니다.');
    await expect(left).toContainText('일부는 이미 지워졌고 나머지는 지우지 못했습니다');
    // "Could not delete", with what the person can do by hand.
    await expect(left).toContainText('삭제하지 못했습니다');
    await expect(left).toContainText('PomiTranslate 항목을 직접 삭제');
    await expect(left).toContainText('다시 시도하면 멈춘 곳부터 이어서');
    expect(await requests(page, 'app.reset')).toBe(0);
    expect(await page.evaluate(() => sessionStorage.getItem('pomi.fixture.reset'))).toBeNull();
    await axe(page);
    await Promise.all([page.waitForEvent('load'), confirm.getByRole('button', { name: '다시 시도', exact: true }).click()]);
    expect(await page.evaluate(() => sessionStorage.getItem('pomi.fixture.reset'))).toBe('true');
  });

  test('a refused reset is explained in the dialog and keeps the person where they are', async ({ page }) => {
    for (const [mode, text] of [['busy', '다른 작업이 현재 진행 중입니다'], ['state-unknown', '번역 코어가 멈췄는지 확인하지 못해']] as const) {
      await boot(page, `scenario=selected&reset=${mode}`);
      const confirm = await toResetConfirm(page);
      await confirm.getByRole('button', { name: '초기화', exact: true }).click();
      await expect(confirm.getByRole('alert')).toContainText(text);
      await expect(confirm.getByRole('button', { name: '초기화', exact: true })).toBeEnabled();
      expect(await requests(page, 'app.reset')).toBe(0);
    }
  });
});

test.describe('the update question (3, 4, 8)', () => {
  async function askToInstall(page: Page, query: string) {
    await boot(page, `scenario=selected&update=available&${query}`);
    // The fixture plays the shell: it asks the question as if settings were unsaved.
    await openAppSettings(page);
    await page.getByRole('button', { name: '지금 확인' }).click();
    await page.getByRole('button', { name: '설치하고 다시 시작' }).click();
    return page.getByRole('dialog', { name: '업데이트를 설치할까요?' });
  }

  test('unsaved settings raise the update question; Save and install saves, then confirms with the intent', async ({ page }) => {
    const dialog = await askToInstall(page, 'install=ask');
    await expect(dialog).toContainText('저장하지 않은 설정이 있습니다');
    await axe(page);
    await dialog.getByRole('button', { name: '저장하고 설치', exact: true }).click();
    await expect.poll(() => shell(page)).toEqual(['exit_confirm']);
    expect(await calls(page)).toEqual([{ command: 'exit_confirm', args: { intent: 7 } }]);
    expect(await requests(page, 'settings.set')).toBe(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pomiInstalled)).toBe(true);
  });

  test('Install without saving confirms and does not save', async ({ page }) => {
    const dialog = await askToInstall(page, 'install=ask');
    await dialog.getByRole('button', { name: '저장하지 않고 설치', exact: true }).click();
    await expect.poll(() => shell(page)).toEqual(['exit_confirm']);
    expect(await requests(page, 'settings.set')).toBe(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Cancel calls the install off with exit_cancel and says nothing was installed', async ({ page }) => {
    const dialog = await askToInstall(page, 'install=ask');
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    // The toast goes away after a few seconds, so it is checked first.
    await expect(page.getByText('업데이트를 취소했습니다. 아무것도 설치하지 않았습니다.')).toBeVisible();
    await expect.poll(() => shell(page)).toEqual(['exit_cancel']);
    expect(await calls(page)).toEqual([{ command: 'exit_cancel', args: { intent: 7 } }]);
    expect(await page.evaluate(() => (window as any).__pomiInstalled)).toBeUndefined();
  });

  test('an answer to a question that is gone closes the dialog and does nothing else', async ({ page }) => {
    await boot(page, 'scenario=selected&exit=gone');
    await emit(page, 'pomi-exit-confirm', { job: false, dirty: true, reason: 'update', intent: 2 });
    await page.getByRole('dialog', { name: '업데이트를 설치할까요?' }).getByRole('button', { name: '저장하지 않고 설치', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);

    await boot(page, 'scenario=selected&exit=gone-quit');
    await emit(page, 'pomi-exit-confirm', { job: false, dirty: true, reason: 'quit', intent: 2 });
    await page.getByRole('dialog', { name: '저장하지 않은 설정이 있습니다' }).getByRole('button', { name: '저장하지 않고 종료', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a new question replaces the one on screen and answers go to the new intent', async ({ page }) => {
    await boot(page, 'scenario=selected');
    await emit(page, 'pomi-exit-confirm', { job: false, dirty: true, reason: 'update', intent: 4 });
    await expect(page.getByRole('dialog', { name: '업데이트를 설치할까요?' })).toBeVisible();
    await emit(page, 'pomi-exit-confirm', { job: true, dirty: false, reason: 'quit', intent: 5 });
    await page.getByRole('dialog', { name: '작업 중에 종료할까요?' }).getByRole('button', { name: '작업을 취소하고 종료', exact: true }).click();
    expect(await calls(page)).toEqual([{ command: 'exit_confirm', args: { intent: 5 } }]);
  });

  for (const [mode, text] of [
    ['busy', '작업이 진행 중이거나 다른 업데이트가 답을 기다리고 있어'],
    ['cancelled', '업데이트를 취소했습니다'],
    ['state-unknown', '번역 코어가 멈췄는지 확인하지 못해']
  ] as const) {
    test(`install refused with ${mode} is explained and the person stays in Settings`, async ({ page }) => {
      await boot(page, `scenario=selected&update=available&install=${mode}`);
      await openAppSettings(page);
      await page.getByRole('button', { name: '지금 확인' }).click();
      await page.getByRole('button', { name: '설치하고 다시 시작' }).click();
      await expect(page.locator('#updates .status')).toContainText(text);
      await expect(page.getByRole('heading', { name: '업데이트', exact: true })).toBeVisible();
    });
  }
});

test.describe('a Custom key saved by an older version (5)', () => {
  test('explains it, leads to the key field, and typing the key again lets the translation go on', async ({ page }) => {
    await boot(page, 'scenario=run&provider=custom&key=unbound');
    await toRun(page);
    await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
    const banner = page.getByRole('alert').filter({ hasText: '서버 주소와 연결되어 있지 않아' });
    await expect(banner).toBeVisible();
    await expect(banner).not.toContainText('raw shell text');
    await banner.getByRole('button', { name: '키 입력하기', exact: true }).click();

    await expect(page.getByRole('status').filter({ hasText: '이 주소에 쓸 키를 다시 입력해 주세요' })).toBeVisible();
    const field = page.locator('#api-key');
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('type', 'password');
    await expect(field).toHaveValue('');
    await axe(page);
    await field.fill('sk-typed-again-0000');
    await page.getByRole('button', { name: /^(저장|저장하고 돌아가기)$/ }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__pomiKeySaves ?? [])).toEqual(['custom']);
    // The key is never echoed back anywhere on the page.
    await expect(page.locator('body')).not.toContainText('sk-typed-again-0000');
    // Saved: the same Start now goes through.
    await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
    await expect(page.getByRole('heading', { name: '번역을 성공적으로 마쳤습니다' })).toBeVisible();
  });
});

test.describe('interrupted work answers (9)', () => {
  test('an undone unpublished resume is explained and the earlier job is listed again', async ({ page }) => {
    await boot(page, 'scenario=interrupted-partial&recovery=undone-resume');
    await page.getByRole('button', { name: '이번 실행 되돌리기' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '중단된 변경 되돌리기' }).click();
    const result = page.getByRole('status').filter({ hasText: '중단된 이어하기를 되돌렸습니다' });
    await expect(result).toContainText('이전 작업이 아래에 다시 표시되니');
    await expect(page.getByRole('region').filter({ hasText: '41 / 69' })).toHaveCount(0);
    await expect(page.locator('main')).toContainText('30 / 69');
    await axe(page);
  });

  test('a Keep that could not quarantine says why, keeps the job listed and overwrites nothing', async ({ page }) => {
    await boot(page, 'scenario=interrupted&recovery=quarantine-failed');
    await page.getByRole('button', { name: '현재 파일 유지' }).click();
    const result = page.getByRole('status').filter({ hasText: '격리 폴더로 옮기지 못해' });
    await expect(result).toContainText('디스크 공간이 부족해');
    await expect(result).toContainText('월드는 바뀌지 않았습니다');
    await result.getByRole('button', { name: '격리 폴더 열기' }).click();
    expect(await page.evaluate(() => (window as any).__pomiRevealedPaths)).toEqual(['/Users/fixture/quarantine/job-interrupted-1']);
    await expect(page.getByRole('alert').filter({ hasText: '중단된 작업 1건' })).toBeVisible();
  });
});

test.describe('the live feed (6)', () => {
  async function running(page: Page, query: string) {
    await boot(page, `scenario=run-progress&${query}`);
    await toRun(page);
    await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
    await expect(page.getByRole('heading', { name: '최근 번역된 문장' })).toBeVisible();
  }

  test('keeps the list to five short lines and shows nothing for a cost the provider did not report', async ({ page }) => {
    await running(page, 'progress=many');
    await expect.poll(() => page.locator('.feed li').count()).toBe(5);
    await expect(page.getByText('Sentence 9', { exact: false })).toBeVisible();
    await expect(page.getByText('Sentence 1 ', { exact: false })).toHaveCount(0);
    const lengths = await page.locator('.feed li .from').evaluateAll((nodes) => nodes.map((node) => (node.getAttribute('title') ?? '').length));
    expect(Math.max(...lengths)).toBeLessThanOrEqual(160);
    const cost = page.locator('.facts div').filter({ hasText: '지금까지 든 비용' }).locator('dd');
    await expect(cost).toHaveText('–');
    await expect(page.locator('main')).not.toContainText('$0');
  });

  test('shows the cost once it is reported', async ({ page }) => {
    await running(page, 'progress=cost');
    const cost = page.locator('.facts div').filter({ hasText: '지금까지 든 비용' }).locator('dd');
    await expect(cost).toContainText('$0.0001');
  });
});

test('a key that cannot be deleted from the system keychain says to try again or remove the entry by hand', async ({ page }) => {
  await boot(page, 'scenario=selected&delete=unconfirmed');
  await openSettings(page);
  await page.locator('#key-management > summary').click();
  await page.getByRole('button', { name: '저장된 키 삭제', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '저장된 키 삭제', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: '키체인의 항목을 삭제하지 못했습니다' });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('PomiTranslate 항목을 직접 삭제');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await requests(page, 'credentials.delete')).toBe(1);
});
