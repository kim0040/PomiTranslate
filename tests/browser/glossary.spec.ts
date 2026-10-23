import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

type Logged = { type: string; payload?: Record<string, any> };

async function open(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('main')).not.toContainText('불러오는 중');
}
const step = (page: Page, name: string) => page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
const requests = (page: Page, type: string) => page.evaluate((kind) => (window as any).__pomiRequests.filter((item: Logged) => item.type === kind) as Logged[], type);
const glossaryDialog = (page: Page) => page.getByRole('dialog', { name: '이 월드 용어집' });
const sourceField = (root: ReturnType<Page['locator']>) => root.getByRole('textbox', { name: '원문 용어' });
const targetField = (root: ReturnType<Page['locator']>) => root.getByRole('textbox', { name: '고정 번역' });

test('the global glossary is editable, validates entries, imports JSON and saves with Settings', async ({ page }) => {
  await open(page, 'scenario=review');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '월드에 쓰기 전에 번역 검토' })).toBeChecked();
  await expect(page.locator('#max-cost-usd')).toHaveValue('0');
  await page.getByRole('button', { name: /^용어집/ }).click();
  const editor = page.locator('#global-glossary');
  const add = editor.getByRole('button', { name: '용어 추가' });
  await add.click();
  await sourceField(editor).fill('Elder Mira');
  await targetField(editor).fill('장로 미라');
  await expect(page.locator('.save-bar')).toContainText('번역 탭에 저장하지 않은 변경');
  await expect((await new AxeBuilder({ page }).include('#global-glossary').analyze()).violations).toEqual([]);

  await add.click();
  await sourceField(editor).nth(1).fill('elder mira');
  await targetField(editor).nth(1).fill('다른 번역');
  await expect(page.getByRole('alert').filter({ hasText: '원문 용어가 1행과 겹칩니다' })).toBeVisible();
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
  await editor.locator('tbody tr:not(.error-row)').nth(1).getByRole('button', { name: '용어 삭제' }).click();

  await editor.locator('input[type="file"]').setInputFiles({
    name: 'glossary.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify([{ source: 'Nether', target: '', mode: 'keep', note: '장소 이름', caseSensitive: false }]))
  });
  await expect(sourceField(editor)).toHaveCount(1);
  await expect(sourceField(editor)).toHaveValue('Nether');
  await expect(targetField(editor)).toHaveValue('');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await requests(page, 'settings.set')).length).toBe(1);
  const save = (await requests(page, 'settings.set')).at(-1)!;
  expect(save.payload?.glossaryCount).toBe(1);
  expect(JSON.stringify(save.payload)).not.toContain('Nether');
  await expect(page.locator('.save-bar')).toHaveCount(0);
  await page.getByRole('tab', { name: '앱' }).click();
  const notify = page.getByRole('checkbox', { name: '작업이 끝나면 알림 받기' });
  await expect(notify).toBeVisible();
  await expect(notify).toBeChecked();
  await notify.uncheck();
  await expect.poll(async () => (await requests(page, 'prefs.set')).at(-1)?.payload).toMatchObject({ prefs: { notify_on_finish: false } });
});

test('candidate review quick-add opens the world sheet and stores its entry per world', async ({ page }) => {
  await open(page, 'scenario=review');
  await page.getByRole('button', { name: /^번역할 문장 고르기/ }).click();
  await page.locator('tr[data-index="0"]').click();
  await page.getByRole('button', { name: '용어집에 추가' }).click();
  const dialog = glossaryDialog(page);
  await expect(sourceField(dialog)).toHaveValue('Welcome to Roguefire');
  await expect(dialog.getByLabel('적용 범위')).toHaveValue('world');
  await targetField(dialog).fill('로그파이어에 오신 것을 환영합니다');
  await dialog.getByRole('button', { name: '용어집 저장' }).click();
  await expect.poll(async () => (await requests(page, 'glossary.set')).length).toBe(1);
  expect((await requests(page, 'glossary.set'))[0].payload).toMatchObject({ scope: 'world', hasWorld: true, count: 1 });
  await page.getByRole('button', { name: '이 월드 용어집' }).click();
  await expect(glossaryDialog(page)).toBeVisible();
  await glossaryDialog(page).getByRole('button', { name: '취소' }).click();
});

test('both glossary scopes validate before saving and the scope error jumps to its row', async ({ page }) => {
  await open(page, 'scenario=review');
  await step(page, '번역할 문장 고르기');
  await page.getByRole('button', { name: '이 월드 용어집' }).click();
  const dialog = glossaryDialog(page);
  await dialog.getByRole('button', { name: '용어 추가' }).click();
  await sourceField(dialog).fill('Mira');
  await targetField(dialog).fill('');
  await dialog.getByLabel('적용 범위').selectOption('global');
  await dialog.getByRole('button', { name: '용어 추가' }).click();
  await sourceField(dialog).fill('Elder Mira');
  await targetField(dialog).fill('장로 미라');

  await expect(dialog.getByRole('alert').getByRole('button')).toContainText('월드');
  await expect(dialog.getByRole('button', { name: '용어집 저장' })).toBeDisabled();
  expect(await requests(page, 'glossary.set')).toHaveLength(0);
  await dialog.getByRole('alert').getByRole('button').click();
  await expect(dialog.getByLabel('적용 범위')).toHaveValue('world');
  await expect(dialog.locator('[data-glossary-row="0"] input').first()).toBeFocused();
  await expect(dialog).not.toContainText(/target invalid|Invalid glossary|Synthetic/);
});

test('glossary sheet reports a partial two-scope save in localized per-scope results', async ({ page }) => {
  await open(page, 'scenario=review&glossaryFailScope=world');
  await step(page, '번역할 문장 고르기');
  await page.getByRole('button', { name: '이 월드 용어집' }).click();
  const dialog = glossaryDialog(page);
  await dialog.getByRole('button', { name: '용어 추가' }).click();
  await sourceField(dialog).fill('World Mira');
  await targetField(dialog).fill('월드 미라');
  await dialog.getByLabel('적용 범위').selectOption('global');
  await dialog.getByRole('button', { name: '용어 추가' }).click();
  await sourceField(dialog).fill('Elder Mira');
  await targetField(dialog).fill('장로 미라');
  await dialog.getByRole('button', { name: '용어집 저장' }).click();

  await expect(dialog.locator('.save-results')).toContainText('저장됨');
  await expect(dialog.locator('.save-results')).toContainText('저장하지 못함');
  await expect(dialog.getByRole('alert')).toContainText('일부 범위만 저장했습니다');
  await expect(dialog.getByRole('alert')).not.toContainText(/Synthetic|Invalid glossary|target invalid/);
  const saves = await requests(page, 'glossary.set');
  expect(saves.map((request) => request.payload?.scope)).toEqual(['global', 'world']);
});

test('glossary refresh uses the stale-only count and estimate while normal retry includes failures', async ({ page }) => {
  await open(page, 'scenario=run&fail=1&stale=1');
  await step(page, '번역 준비');
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await expect(page.getByRole('heading', { name: '번역 결과 검토', exact: true })).toBeVisible();
  const refresh = page.getByRole('button', { name: '영향받은 문장 다시 번역 (1)' });
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(page.getByRole('dialog', { name: '예상 비용이 설정한 한도를 넘습니다' })).toHaveCount(0);
  const retry = (await requests(page, 'translate.retry_failed')).at(-1)!;
  expect(retry.payload?.refreshGlossary).toBe(true);
  expect(await page.evaluate(() => (window as any).__pomiRetrySent)).toEqual(['shop']);
});

test('translation review filters and badges glossary mismatches and can quick-add the current translation', async ({ page }) => {
  await open(page, 'scenario=run&glossaryMismatch=1');
  await step(page, '번역 준비');
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: '번역 결과 검토', exact: true })).toBeVisible();
  const mismatch = page.getByRole('button', { name: /용어 확인/ });
  await expect(mismatch).toContainText('1');
  await mismatch.click();
  const row = page.locator('tr[data-index]').first();
  await expect(row).toContainText('용어 확인');
  await row.click();
  await expect(page.locator('.detail')).toContainText('용어집 규칙과 다른 번역입니다');
  const currentTranslation = await page.locator('#translation-edit').inputValue();
  await page.getByRole('button', { name: '용어집에 추가' }).click();
  const dialog = glossaryDialog(page);
  await expect(sourceField(dialog)).toHaveValue('Welcome to Roguefire');
  await expect(targetField(dialog)).toHaveValue(currentTranslation);
  await dialog.getByRole('button', { name: '용어집 저장' }).click();
  await expect.poll(async () => (await requests(page, 'glossary.set')).length).toBe(1);
});

test('a saved user-entered model price appears in the run estimate', async ({ page }) => {
  await open(page, 'scenario=run');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect.poll(async () => (await requests(page, 'models.list')).length).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: '단가 직접 입력 (USD / 1M 토큰)' })).toBeVisible();
  await page.getByRole('button', { name: /^단가 직접 입력/ }).click();
  await page.locator('#custom-price-input').fill('2.500');
  await page.locator('#custom-price-output').fill('7.500');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await requests(page, 'settings.set')).length).toBeGreaterThan(0);
  await expect(page.getByText('사용자 입력 단가 기준', { exact: true })).toBeVisible();
  await expect(page.locator('.save-bar')).toHaveCount(0);
  const saved = (await requests(page, 'settings.set')).at(-1)!;
  expect(saved.payload?.customPriceCount).toBe(1);
  expect(JSON.stringify(saved.payload)).not.toContain('7.5');
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await step(page, '번역 준비');
  await expect(page.getByText('사용자 입력 단가 기준', { exact: true })).toBeVisible();
  expect(await requests(page, 'estimate.get')).not.toHaveLength(0);
});

test('a changed world glossary blocks apply until affected rows are refreshed and saved edits stay dirty', async ({ page }) => {
  await open(page, 'scenario=run');
  await step(page, '번역 준비');
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await expect(page.getByRole('heading', { name: '번역 결과 검토', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '이 월드 용어집' }).click();
  const dialog = glossaryDialog(page);
  await dialog.getByRole('button', { name: '용어 추가' }).click();
  await sourceField(dialog).fill('Roguefire');
  await targetField(dialog).fill('로그파이어');
  await expect(dialog.getByRole('button', { name: '용어집 저장' })).toBeEnabled();
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page.getByRole('dialog', { name: '저장하지 않은 설정이 있습니다' })).toBeVisible();
  await page.getByRole('button', { name: '계속 편집' }).click();
  await dialog.getByRole('button', { name: '용어집 저장' }).click();
  await expect(page.getByText('용어집이 바뀌었습니다', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^월드에 적용/ })).toBeDisabled();
  await expect(page.locator('tr[data-index]').filter({ hasText: '용어 재확인' })).toHaveCount(1);
  await page.getByRole('button', { name: '영향받은 문장 다시 번역 (1)' }).click();
  await expect(page.getByText('용어집이 바뀌었습니다', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^월드에 적용/ })).toBeEnabled();
  const retry = (await requests(page, 'translate.retry_failed')).at(-1)!;
  expect(retry.payload?.refreshGlossary).toBe(true);
  expect(await requests(page, 'scan.start')).toHaveLength(0);

  await page.getByRole('button', { name: '이 월드 용어집' }).click();
  await expect(sourceField(dialog)).toHaveValue('Roguefire');
  await targetField(dialog).fill('로그파이어 월드');
  await expect(dialog.getByRole('button', { name: '용어집 저장' })).toBeEnabled();
  await dialog.getByRole('button', { name: '용어집 저장' }).click();
  await expect(page.getByText('용어집이 바뀌었습니다', { exact: true })).toBeVisible();
});

test('CSV import and export keep Unicode terms and the editor fits the minimum window in both themes', async ({ page }) => {
  await open(page, 'scenario=review');
  await page.setViewportSize({ width: 840, height: 620 });
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByRole('button', { name: /^용어집/ }).click();
  const editor = page.locator('#global-glossary');
  await editor.locator('input[type="file"]').setInputFiles({ name: 'terms.csv', mimeType: 'text/csv',
    buffer: Buffer.from('\uFEFFsource,target,mode,note,caseSensitive\r\n古代竜,고대룡,translate,"왕, 북쪽",true\r\nNether,,keep,,false\r\n') });
  await expect(sourceField(editor)).toHaveCount(2);
  await expect(sourceField(editor).first()).toHaveValue('古代竜');
  const download = page.waitForEvent('download');
  await editor.getByRole('button', { name: 'CSV', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('pomitranslate-glossary.csv');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect((await new AxeBuilder({ page }).include('#global-glossary').analyze()).violations).toEqual([]);
  }
  await editor.getByRole('searchbox').fill('Nether');
  await expect(sourceField(editor)).toHaveCount(1);
  await expect(sourceField(editor)).toHaveValue('Nether');
});

test('a global glossary saved from Settings marks the active translation review for refresh', async ({ page }) => {
  await open(page, 'scenario=run');
  await step(page, '번역 준비');
  await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
  await expect(page.getByRole('heading', { name: '번역 결과 검토', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByRole('button', { name: /^용어집/ }).click();
  const editor = page.locator('#global-glossary');
  await editor.getByRole('button', { name: '용어 추가' }).click();
  await sourceField(editor).fill('Roguefire');
  await targetField(editor).fill('로그파이어');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('.save-bar')).toHaveCount(0);
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await expect(page.getByText('용어집이 바뀌었습니다', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^월드에 적용/ })).toBeDisabled();
  expect(await requests(page, 'scan.start')).toHaveLength(0);
});

test('native close and menu navigation keep the unsaved glossary in its own dialog', async ({ page }) => {
  await open(page, 'scenario=review');
  await step(page, '번역할 문장 고르기');
  await page.getByRole('button', { name: '이 월드 용어집' }).click();
  const dialog = glossaryDialog(page);
  await dialog.getByRole('button', { name: '용어 추가' }).click();
  await sourceField(dialog).fill('Mira');
  await targetField(dialog).fill('미라');
  await expect.poll(() => page.evaluate(() => (window as any).__pomiUnsavedSettings)).toBe(true);
  await page.evaluate(() => (window as any).__pomiEmit('pomi-close-requested', 'window'));
  const close = page.getByRole('dialog', { name: '앱을 닫기 전에 변경 사항을 확인하세요' });
  await expect(close).toBeVisible();
  await close.getByRole('button', { name: '계속 편집' }).click();
  await expect(sourceField(dialog)).toHaveValue('Mira');
  await page.evaluate(() => (window as any).__pomiEmit('pomi-menu', 'settings'));
  const leave = page.getByRole('dialog', { name: '저장하지 않은 설정이 있습니다' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: '계속 편집' }).click();
  await expect(sourceField(dialog)).toHaveValue('Mira');
  await page.evaluate(() => (window as any).__pomiEmit('pomi-close-requested', 'quit'));
  await close.getByRole('button', { name: '저장하고 닫기' }).click();
  await expect.poll(async () => (await requests(page, 'glossary.set')).length).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__pomiNativeCalls.find((call: any) => call.command === 'finish_close')?.args.source)).toBe('quit');
});
