import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// The close/quit flow (U1) and the unusable-key-store flow (CR-3), driven through the events and
// commands the Tauri shell uses. The fixture records what the page asked the shell to do.
async function boot(page: Page, query = '') {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=review${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
}
const emit = (page: Page, name: string, payload: unknown) => page.evaluate(([n, p]) => (window as any).__pomiEmit(n, p), [name, payload] as const);
const shell = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__pomiShell ?? []);
// Every answer names the question it answers (the shell refuses one that does not).
const calls = (page: Page): Promise<{ command: string; args: { intent: number } }[]> => page.evaluate(() => (window as any).__pomiCalls ?? []);
const openSettings = (page: Page) => page.getByRole('button', { name: '환경 설정', exact: true }).click();

test.describe('a running job', () => {
  test('keep working closes the question and asks the shell for nothing', async ({ page }) => {
    await boot(page);
    await emit(page, 'pomi-exit-confirm', { job: true, dirty: false, reason: 'quit', intent: 3 });
    const dialog = page.getByRole('dialog', { name: '작업 중에 종료할까요?' });
    await expect(dialog).toContainText('작업을 취소하고');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await dialog.getByRole('button', { name: '계속 작업', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Staying closes the question in the shell too.
    await expect.poll(() => shell(page)).toEqual(['exit_cancel']);
    expect(await calls(page)).toEqual([{ command: 'exit_cancel', args: { intent: 3 } }]);
  });

  test('cancel and quit asks the shell to cancel the job and quit', async ({ page }) => {
    await boot(page);
    await emit(page, 'pomi-exit-confirm', { job: true, dirty: false, reason: 'quit', intent: 3 });
    await page.getByRole('button', { name: '작업을 취소하고 종료', exact: true }).click();
    await expect.poll(() => shell(page)).toEqual(['exit_confirm']);
    expect(await calls(page)).toEqual([{ command: 'exit_confirm', args: { intent: 3 } }]);
  });

  test('a job that does not stop offers quit now, or waiting longer', async ({ page }) => {
    await boot(page, '&exit=stuck');
    await emit(page, 'pomi-exit-confirm', { job: true, dirty: false, reason: 'quit', intent: 3 });
    await page.getByRole('button', { name: '작업을 취소하고 종료', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '작업을 멈추는 중…' })).toBeVisible();
    // While waiting there is nothing to dismiss: the dialog is not closable.
    await expect(page.getByRole('dialog').getByRole('button')).toHaveCount(0);
    // The shell's wait runs out.
    await emit(page, 'pomi-exit-stuck', null);
    const stuck = page.getByRole('dialog', { name: '작업이 멈추지 않았습니다' });
    await expect(stuck).toBeVisible();
    // Keep waiting asks the shell to wait again and returns to the waiting state.
    await stuck.getByRole('button', { name: '계속 기다리기', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '작업을 멈추는 중…' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '작업이 멈추지 않았습니다' })).toHaveCount(0);
    await expect.poll(() => shell(page)).toEqual(['exit_confirm', 'exit_keep_waiting']);
    // The wait runs out again; this time the person quits now.
    await emit(page, 'pomi-exit-stuck', null);
    await page.getByRole('dialog', { name: '작업이 멈추지 않았습니다' }).getByRole('button', { name: '지금 종료', exact: true }).click();
    await expect.poll(() => shell(page)).toEqual(['exit_confirm', 'exit_keep_waiting', 'exit_force']);
  });

  test('a wait that runs out twice offers the same two choices again', async ({ page }) => {
    await boot(page, '&exit=stuck-again');
    await emit(page, 'pomi-exit-confirm', { job: true, dirty: false, reason: 'quit', intent: 3 });
    await page.getByRole('button', { name: '작업을 취소하고 종료', exact: true }).click();
    const stuck = page.getByRole('dialog', { name: '작업이 멈추지 않았습니다' });
    await expect(stuck).toBeVisible();
    await stuck.getByRole('button', { name: '계속 기다리기', exact: true }).click();
    await expect.poll(() => shell(page)).toEqual(['exit_confirm', 'exit_keep_waiting']);
    await expect(stuck).toBeVisible();
    await expect(stuck.getByRole('button', { name: '지금 종료', exact: true })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});

test.describe('unsaved settings', () => {
  async function dirty(page: Page) {
    await boot(page);
    await openSettings(page);
    await page.locator('#target-language').fill('English');
    // The shell is told, so it can hold the window close.
    await expect.poll(() => page.evaluate(() => (window as any).__pomiDirty)).toBe(true);
  }

  test('cancel keeps the app open with the draft intact', async ({ page }) => {
    await dirty(page);
    await emit(page, 'pomi-exit-confirm', { job: false, dirty: true, reason: 'quit', intent: 3 });
    const dialog = page.getByRole('dialog', { name: '저장하지 않은 설정이 있습니다' });
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('#target-language')).toHaveValue('English');
    await expect.poll(() => shell(page)).toEqual(['exit_cancel']);
  });

  test('quit without saving does not save', async ({ page }) => {
    await dirty(page);
    await emit(page, 'pomi-exit-confirm', { job: false, dirty: true, reason: 'quit', intent: 3 });
    await page.getByRole('button', { name: '저장하지 않고 종료', exact: true }).click();
    await expect.poll(() => shell(page)).toEqual(['exit_confirm']);
    const saves = await page.evaluate(() => (window as any).__pomiRequests.filter((request: { type: string }) => request.type === 'settings.set').length);
    expect(saves).toBe(0);
  });

  test('save and quit saves first, then quits', async ({ page }) => {
    await dirty(page);
    await emit(page, 'pomi-exit-confirm', { job: false, dirty: true, reason: 'quit', intent: 3 });
    await page.getByRole('button', { name: '저장하고 종료', exact: true }).click();
    await expect.poll(() => shell(page)).toEqual(['exit_confirm']);
    const saves = await page.evaluate(() => (window as any).__pomiRequests.filter((request: { type: string }) => request.type === 'settings.set').length);
    expect(saves).toBe(1);
  });

  test('settings that cannot be saved keep the app open', async ({ page }) => {
    await dirty(page);
    // An out-of-range batch size blocks saving.
    await page.locator('#batch-size').evaluate((input) => { (input.closest('details') as HTMLDetailsElement).open = true; });
    await page.locator('#batch-size').fill('999');
    await emit(page, 'pomi-exit-confirm', { job: false, dirty: true, reason: 'quit', intent: 3 });
    await page.getByRole('button', { name: '저장하고 종료', exact: true }).click();
    await expect(page.getByText('설정을 저장하지 못해 종료하지 않았습니다')).toBeVisible();
    expect(await shell(page)).toEqual([]);
  });
});

test.describe('a key store that cannot be opened', () => {
  test('says so instead of "no key saved", and the reset repairs it', async ({ page }) => {
    await boot(page, '&vault=corrupt');
    await openSettings(page);
    const notice = page.getByRole('alert').filter({ hasText: '저장된 API 키를 열 수 없습니다' });
    await expect(notice).toContainText('키 저장소 파일이 손상되었습니다');
    await expect(notice).toContainText('키가 없다는 뜻이 아닙니다');
    // "Unavailable" is never presented as "empty".
    await expect(page.getByText('저장된 API 키가 없습니다', { exact: true })).toHaveCount(0);
    await notice.getByRole('button', { name: '키 저장소 초기화…' }).click();
    const dialog = page.getByRole('dialog', { name: '키 저장소를 초기화할까요?' });
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    expect(await shell(page)).toEqual([]);
    await notice.getByRole('button', { name: '키 저장소 초기화…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '초기화', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '저장된 API 키를 열 수 없습니다' })).toHaveCount(0);
    expect(await shell(page)).toEqual(['credential_reset_storage']);
  });
});
