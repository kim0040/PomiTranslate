import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// Help, the getting-started tour, license notices, updates, data location and reset, driven the way
// the shell drives them: menu events, invoke commands and core requests recorded by the fixture.
async function boot(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
}
const emit = (page: Page, name: string, payload: unknown) => page.evaluate(([n, p]) => (window as any).__pomiEmit(n, p), [name, payload] as const);
const prefs = (page: Page) => page.evaluate(() => (window as any).__pomiPrefs ?? {});
// Settings is a set of tabs; the app tab holds updates, the data folder and reset, each in its own card.
async function appTab(page: Page, card?: RegExp) {
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByRole('tab', { name: '앱' }).click();
  if (card) {
    const toggle = page.getByRole('button', { name: card });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  }
}

test('a first launch shows the notice in the setup wizard, then a short tour, and remembers all of it in the settings file', async ({ page }) => {
  await boot(page, 'scenario=first-run');
  const notice = page.getByRole('dialog', { name: '환영합니다' });
  await expect(notice).toContainText('NOT AN OFFICIAL MINECRAFT PRODUCT');
  await notice.getByRole('button', { name: /확인/ }).click();
  await expect.poll(() => prefs(page)).toMatchObject({ notice_accepted: true });
  // Putting the wizard off ("later") leads on to the tour that a first launch shows.
  await page.getByRole('dialog', { name: 'AI 서비스 선택' }).getByRole('button', { name: '나중에' }).click();
  const tour = page.getByRole('dialog', { name: '시작 안내' });
  await expect(tour).toContainText('PomiTranslate에 오신 것을 환영합니다');
  for (let i = 0; i < 4; i++) await tour.getByRole('button', { name: /^다음/ }).click();
  await expect(tour).toContainText('4. 백업과 복원');
  expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
  await tour.getByRole('button', { name: '시작하기', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => prefs(page)).toMatchObject({ notice_accepted: true, tutorial_seen: true, setup_dismissed: true });
});

test('an existing install carries its notice answer and theme over without showing the tour', async ({ page }) => {
  await boot(page, 'scenario=selected');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => prefs(page)).toMatchObject({ notice_accepted: true, tutorial_seen: true, setup_dismissed: true, theme: 'light' });
});

test('the Help menu opens help, shortcuts, the tour, licenses and a problem report', async ({ page }) => {
  await boot(page, 'scenario=review');
  await emit(page, 'pomi-menu', 'help');
  await expect(page.getByRole('heading', { name: '도움말', exact: true, level: 1 })).toBeVisible();
  await page.locator('summary', { hasText: '비용은 얼마나 드나요?' }).click();
  await expect(page.getByText('앱은 무료입니다.', { exact: false })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await emit(page, 'pomi-menu', 'shortcuts');
  await expect(page.getByRole('heading', { name: '단축키' })).toBeInViewport();

  await emit(page, 'pomi-menu', 'tour');
  await expect(page.getByRole('dialog', { name: '시작 안내' })).toBeVisible();
  await page.getByRole('button', { name: '건너뛰기' }).click();

  await emit(page, 'pomi-menu', 'licenses');
  const licenses = page.getByRole('dialog', { name: '오픈소스 라이선스' });
  await expect(licenses.locator('pre')).toContainText('tauri');
  await expect(licenses.locator('pre')).toContainText('NOT AN OFFICIAL MINECRAFT PRODUCT');
  await licenses.getByRole('button', { name: 'PomiTranslate', exact: true }).click();
  await expect(licenses.locator('pre')).toContainText('MIT License');
  await licenses.getByRole('button', { name: '닫기', exact: true }).last().click();

  await emit(page, 'pomi-menu', 'report');
  await expect.poll(() => page.evaluate(() => (window as any).__pomiOpened ?? [])).toContain('https://github.com/kim0040/PomiTranslate/issues/new');
});

test('the FAQ explains editing before and after applying, the glossary and the spending cap', async ({ page }) => {
  await boot(page, 'scenario=review');
  await emit(page, 'pomi-menu', 'help');
  const entries: [string, string][] = [
    ['번역을 적용하기 전에 고칠 수 있나요?', '번역 결과 검토 화면이 열리고'],
    ['적용한 뒤 번역을 고치려면?', 'AI 요청은 보내지 않습니다'],
    ['용어집은 어떻게 쓰나요?', '이 월드 용어집'],
    ['비용 한도는 어떻게 동작하나요?', '월드에는 쓰지 않으며']
  ];
  for (const [question, answer] of entries) {
    await page.locator('summary', { hasText: question }).click();
    await expect(page.getByText(answer, { exact: false })).toBeVisible();
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('web links open in the system browser, not inside the app window', async ({ page }) => {
  await boot(page, 'scenario=review');
  await page.getByRole('button', { name: '정보', exact: true }).click();
  await page.getByRole('link', { name: /GitHub/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiOpened ?? [])).toContain('https://github.com/kim0040/PomiTranslate');
  expect(page.url()).toContain('127.0.0.1');
  await expect(page.getByText('NOT AN OFFICIAL MINECRAFT PRODUCT', { exact: false })).toBeVisible();
});

test('a signed update installs from settings with progress', async ({ page }) => {
  await boot(page, 'scenario=selected&update=available');
  await emit(page, 'pomi-menu', 'updates');
  // The menu lands on the app tab, with the updates card open and in view.
  await expect(page.getByRole('tab', { name: '앱', selected: true })).toBeVisible();
  await expect(page.locator('#updates')).toBeInViewport();
  await expect(page.getByRole('button', { name: /^업데이트/, expanded: true })).toBeVisible();
  await expect(page.getByText('새 버전 0.2.0을 사용할 수 있습니다.')).toBeVisible();
  await page.getByRole('button', { name: '설치하고 다시 시작' }).click();
  await expect(page.getByText('내려받는 중… 50%')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pomiInstalled)).toBe(true);
});

test('an unsigned build never installs and offers the download page; offline reads as offline', async ({ page }) => {
  await boot(page, 'scenario=selected&update=unsigned');
  await appTab(page, /^업데이트/);
  await page.getByRole('button', { name: '지금 확인' }).click();
  await expect(page.getByText('새 버전 0.2.0을 사용할 수 있습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '설치하고 다시 시작' })).toHaveCount(0);
  await expect(page.getByText('업데이트 서명 키가 없어', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '다운로드 페이지 열기' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pomiOpened ?? [])).toContain('https://github.com/kim0040/PomiTranslate/releases/latest');
  await page.getByRole('button', { name: '이 버전 건너뛰기' }).click();
  await expect.poll(() => prefs(page)).toMatchObject({ update_skipped_version: '0.2.0' });

  await boot(page, 'scenario=selected&update=offline');
  await appTab(page, /^업데이트/);
  await page.getByRole('button', { name: '지금 확인' }).click();
  await expect(page.getByText('업데이트 서버에 연결하지 못했습니다.', { exact: false })).toBeVisible();
});

test('an automatic check runs once a day after start and shows a quiet badge', async ({ page }) => {
  await boot(page, 'scenario=selected&update=available');
  await expect(page.getByRole('button', { name: '업데이트 0.2.0' })).toBeVisible({ timeout: 8000 });
  await expect.poll(() => prefs(page)).toMatchObject({ update_last_check: expect.any(Number) });
  await page.getByRole('button', { name: '업데이트 0.2.0' }).click();
  await expect(page.getByRole('tab', { name: '앱', selected: true })).toBeVisible();
  await expect(page.locator('#updates')).toBeInViewport();
});

test('the data folder is shown and can be revealed', async ({ page }) => {
  await boot(page, 'scenario=selected');
  await appTab(page, /^데이터 보관 위치/);
  await expect(page.getByText('/Users/fixture/Library/Application Support/PomiTranslate', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '폴더 열기' }).click();
  expect(await page.evaluate(() => (window as any).__pomiRevealed)).toBe(1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('reset asks twice, keeps backups, can keep keys, and restarts at first launch', async ({ page }) => {
  await boot(page, 'scenario=selected');
  await appTab(page, /^초기화/);
  await page.getByRole('button', { name: '초기화…' }).click();
  let dialog = page.getByRole('dialog', { name: '앱을 초기화할까요?' });
  await expect(dialog).toContainText('월드 백업');
  await dialog.getByRole('button', { name: '취소', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('pomi.fixture.reset'))).toBeNull();

  await page.getByRole('button', { name: '초기화…' }).click();
  dialog = page.getByRole('dialog', { name: '앱을 초기화할까요?' });
  await dialog.getByLabel('저장된 API 키도 모두 삭제').uncheck();
  await dialog.getByRole('button', { name: '계속', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '정말 초기화할까요?' });
  await expect(confirm).toContainText('되돌릴 수 없습니다');
  await expect(confirm).not.toContainText('저장된 API 키도 삭제됩니다');
  await Promise.all([page.waitForEvent('load'), confirm.getByRole('button', { name: '초기화', exact: true }).click()]);
  expect(await page.evaluate(() => sessionStorage.getItem('pomi.fixture.reset'))).toBe('true');
  expect(await page.evaluate(() => sessionStorage.getItem('pomi.fixture.cleared'))).toBeNull();
});

test('reset with keys deletes every provider key', async ({ page }) => {
  await boot(page, 'scenario=selected');
  await appTab(page, /^초기화/);
  await page.getByRole('button', { name: '초기화…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '계속', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '정말 초기화할까요?' });
  await expect(confirm).toContainText('저장된 API 키도 삭제됩니다');
  await Promise.all([page.waitForEvent('load'), confirm.getByRole('button', { name: '초기화', exact: true }).click()]);
  const cleared = JSON.parse(await page.evaluate(() => sessionStorage.getItem('pomi.fixture.cleared') ?? '[]'));
  expect(cleared.sort()).toEqual(['anthropic', 'comet', 'custom', 'gemini', 'openai', 'openrouter']);
});
