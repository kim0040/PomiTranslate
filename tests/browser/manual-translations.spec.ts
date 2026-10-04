import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

async function open(page: Page, parameters = '') {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=review${parameters}`);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByRole('tab', { name: '스캔 범위' }).click();
  await page.getByRole('button', { name: /^저장형 수동 번역/ }).click();
}
const sources = (page: Page) => page.getByRole('textbox', { name: '원문', exact: true });
const targets = (page: Page) => page.getByRole('textbox', { name: '번역문', exact: true });
const count = (page: Page) => page.locator('#manual-translations .pill');
const save = (page: Page) => page.getByRole('button', { name: '저장', exact: true });
const saves = (page: Page) => page.evaluate(() => (window as unknown as { __pomiSettingsSaves: Record<string, any>[] }).__pomiSettingsSaves);
const importer = (page: Page) => page.locator('#manual-translations input[type="file"]');
const json = (value: unknown) => ({ name: 'translations.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });

test('an empty list explains itself, and rows can be added, edited and removed', async ({ page }) => {
  await open(page);
  await expect(page.getByText('저장된 수동 번역이 없습니다. 행을 추가하거나 JSON을 가져오세요.')).toBeVisible();
  await expect(count(page)).toHaveText('0개');
  await page.getByRole('button', { name: '행 추가' }).click();
  // The new row takes the focus, and an empty row is not an error.
  await expect(sources(page)).toBeFocused();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(save(page)).toHaveCount(0);
  await sources(page).fill('Welcome to Roguefire');
  await expect(page.getByRole('alert').filter({ hasText: '번역문을 입력해 주세요.' })).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await targets(page).fill('로그파이어에 오신 것을 환영합니다');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(count(page)).toHaveText('1개');
  await expect(page.locator('.save-bar')).toContainText('스캔 범위 탭에 저장하지 않은 변경 1개');
  await expect(page.getByRole('button', { name: '스캔 범위' }).or(page.getByRole('tab', { name: '스캔 범위' }).locator('.dot'))).toHaveText('1');
  // A second row, then edit the first.
  await page.getByRole('button', { name: '행 추가' }).click();
  await sources(page).first().fill('Find the keeper');
  await targets(page).first().fill('관리인을 찾아라');
  await expect(count(page)).toHaveText('2개');
  await targets(page).nth(1).fill('로그파이어에 오신 것을 환영합니다!');
  await save(page).click();
  await expect.poll(async () => (await saves(page)).length).toBe(1);
  expect((await saves(page))[0].sourceOverrides).toEqual({
    'Find the keeper': '관리인을 찾아라', 'Welcome to Roguefire': '로그파이어에 오신 것을 환영합니다!'
  });
  await expect(page.locator('.save-bar')).toHaveCount(0);
  // Remove one row.
  await page.getByRole('button', { name: '행 삭제: Find the keeper' }).click();
  await expect(count(page)).toHaveText('1개');
  await save(page).click();
  await expect.poll(async () => (await saves(page)).length).toBe(2);
  expect((await saves(page))[1].sourceOverrides).toEqual({ 'Welcome to Roguefire': '로그파이어에 오신 것을 환영합니다!' });
});

test('saved translations from before appear as rows and keep their format', async ({ page }) => {
  await open(page, '&sourceOverrides=1');
  await expect(count(page)).toHaveText('2개');
  await expect(sources(page)).toHaveCount(2);
  await expect(sources(page).first()).toHaveValue('Welcome to Roguefire');
  await expect(targets(page).first()).toHaveValue('환영합니다');
  await expect(page.locator('.save-bar')).toHaveCount(0);
  await targets(page).first().fill('어서 오세요');
  await save(page).click();
  await expect.poll(async () => (await saves(page)).length).toBe(1);
  expect((await saves(page))[0].sourceOverrides).toEqual({ 'Welcome to Roguefire': '어서 오세요', 'You are not ready yet.': '아직 준비가 안 됐군.' });
});

test('mistakes are marked on the row, and nothing invalid can be saved', async ({ page }) => {
  await open(page, '&sourceOverrides=1');
  // Empty source with a translation.
  await page.getByRole('button', { name: '행 추가' }).click();
  await targets(page).first().fill('원문 없는 번역');
  await expect(page.getByRole('alert').filter({ hasText: '원문을 입력해 주세요.' })).toBeVisible();
  await expect(sources(page).first()).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert').filter({ hasText: '오류가 있는 행 1개를 고쳐야 저장할 수 있습니다.' })).toBeVisible();
  await expect(save(page)).toBeDisabled();
  // A duplicate source marks both rows.
  await sources(page).first().fill('Welcome to Roguefire');
  await expect(page.getByRole('alert').filter({ hasText: '같은 원문이 이미 있습니다.' })).toHaveCount(2);
  await expect(page.getByRole('alert').filter({ hasText: '오류가 있는 행 2개를 고쳐야 저장할 수 있습니다.' })).toBeVisible();
  await expect(save(page)).toBeDisabled();
  // Too long.
  await sources(page).first().fill('Another source');
  await targets(page).first().fill('가'.repeat(32001));
  await expect(page.getByRole('alert').filter({ hasText: '한 칸은 32,000자까지입니다.' })).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/manual-translations-errors.png' });
  // Fixing it enables saving again; the card stayed open while it had errors.
  await targets(page).first().fill('다른 번역');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(save(page)).toBeEnabled();
  expect(await (await saves(page)).length).toBe(0);
  // Discarding drops every edit, including the rows with mistakes.
  await page.getByRole('button', { name: '변경 취소', exact: true }).click();
  await expect(count(page)).toHaveText('2개');
  await expect(sources(page)).toHaveCount(2);
});

test('a row with errors also says so in the tab, and blocks leaving with a save', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '행 추가' }).click();
  await sources(page).fill('only a source');
  await page.getByRole('tab', { name: '번역' }).click();
  await expect(page.locator('.save-bar')).toContainText('스캔 범위 탭의 오류를 확인해 주세요.');
  await expect(page.getByRole('tab', { name: '스캔 범위' })).toHaveClass(/invalid/);
});

test('search finds a row by source or translation', async ({ page }) => {
  await open(page, '&sourceOverrides=1');
  const search = page.getByRole('searchbox', { name: '원문·번역문 검색' });
  await search.fill('roguefire');
  await expect(sources(page)).toHaveCount(1);
  await search.fill('준비가 안');
  await expect(sources(page)).toHaveCount(1);
  await expect(sources(page)).toHaveValue('You are not ready yet.');
  await search.fill('nothing like this');
  await expect(page.getByText('검색과 맞는 행이 없습니다.')).toBeVisible();
  await expect(count(page)).toHaveText('2개');
  await search.fill('');
  await expect(sources(page)).toHaveCount(2);
  // Adding a row clears the search so the new row is not hidden by it.
  await search.fill('roguefire');
  await page.getByRole('button', { name: '행 추가' }).click();
  await expect(search).toHaveValue('');
  await expect(sources(page)).toHaveCount(3);
});

test('JSON import merges rows, replaces equal sources, and accepts a settings export', async ({ page }) => {
  await open(page, '&sourceOverrides=1');
  await importer(page).setInputFiles(json({ 'Welcome to Roguefire': '새 번역', 'Brand new line': '새 줄' }));
  await expect(page.getByText('2개를 가져왔습니다 (덮어쓴 번역 1개).')).toBeVisible();
  await expect(count(page)).toHaveText('3개');
  await expect(targets(page).first()).toHaveValue('새 번역');
  await importer(page).setInputFiles(json({ schema: 1, source_overrides: { 'From export': '내보낸 것' }, provider: 'openai' }));
  await expect(page.getByText('1개를 가져왔습니다 (덮어쓴 번역 0개).')).toBeVisible();
  await expect(count(page)).toHaveText('4개');
  // Importing is a draft, like any edit.
  expect(await (await saves(page)).length).toBe(0);
  await save(page).click();
  await expect.poll(async () => (await saves(page)).length).toBe(1);
  expect(Object.keys((await saves(page))[0].sourceOverrides)).toHaveLength(4);
});

test('JSON that is not a list of source → translation is refused and changes nothing', async ({ page }) => {
  await open(page, '&sourceOverrides=1');
  for (const bad of [{ a: '' }, { '': 'x' }, { a: 5 }, [1, 2], 'text', { a: 'x\u0000y' }]) {
    await importer(page).setInputFiles(json(bad));
    await expect(page.getByText('가져올 수 없습니다.', { exact: false }).first()).toBeVisible();
    await expect(count(page)).toHaveText('2개');
  }
  await importer(page).setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
  await expect(page.getByText('가져올 수 없습니다.', { exact: false }).first()).toBeVisible();
  const tooMany = Object.fromEntries(Array.from({ length: 5001 }, (_, index) => [`line ${index}`, `번역 ${index}`]));
  await importer(page).setInputFiles(json(tooMany));
  await expect(count(page)).toHaveText('2개');
  await expect(page.locator('.save-bar')).toHaveCount(0);
});

test('export writes the same object format that settings keep', async ({ page }) => {
  await open(page, '&sourceOverrides=1');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON 내보내기' }).click();
  const file = await download;
  const text = await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8');
  expect(JSON.parse(text)).toEqual({ 'Welcome to Roguefire': '환영합니다', 'You are not ready yet.': '아직 준비가 안 됐군.' });
});

test('a long list stays responsive: 600 rows, fifty on screen, searchable, paged', async ({ page }) => {
  await open(page);
  const many = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`Line number ${index}`, `번역 ${index}`]));
  await importer(page).setInputFiles(json(many));
  await expect(count(page)).toHaveText('600개');
  await expect(sources(page)).toHaveCount(50);
  const pager = page.getByRole('group', { name: '페이지 이동' });
  await expect(pager).toContainText('1–50 / 600');
  await expect(pager.getByRole('button', { name: /이전/ })).toBeDisabled();
  await pager.getByRole('button', { name: /다음/ }).click();
  await expect(pager).toContainText('51–100 / 600');
  await expect(sources(page).first()).toHaveValue('Line number 50');
  // Edits on a later page are kept, and typing stays quick.
  const started = Date.now();
  await targets(page).first().pressSequentially('abcdefghij', { delay: 0 });
  expect(Date.now() - started).toBeLessThan(2500);
  await expect(page.locator('.save-bar')).toContainText('스캔 범위 탭에 저장하지 않은 변경 1개');
  const search = page.getByRole('searchbox', { name: '원문·번역문 검색' });
  await search.fill('number 599');
  await expect(sources(page)).toHaveCount(1);
  await expect(pager).toHaveCount(0);
  await search.fill('number 5');
  await expect(sources(page)).toHaveCount(50);
  await expect(page.getByRole('group', { name: '페이지 이동' })).toContainText('1–50 / 111');
  await search.fill('');
  await pager.getByRole('button', { name: /다음/ }).click();
  await expect(targets(page).first()).toHaveValue('번역 50abcdefghij');
  await save(page).click();
  await expect.poll(async () => (await saves(page)).length).toBe(1);
  expect(Object.keys((await saves(page))[0].sourceOverrides)).toHaveLength(600);
  expect((await saves(page))[0].sourceOverrides['Line number 50']).toBe('번역 50abcdefghij');
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('the table fits the smallest window and the dark theme', async ({ page }) => {
  await page.setViewportSize({ width: 840, height: 620 });
  await open(page, '&sourceOverrides=1&theme=dark');
  await expect(sources(page)).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'output/playwright/manual-translations-840-dark.png' });
  await page.setViewportSize({ width: 360, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
});

test('saved manual translations still reach the review list', async ({ page }) => {
  await open(page, '&sourceOverrides=1');
  await targets(page).first().fill('바뀐 번역');
  await save(page).click();
  await expect.poll(async () => (await saves(page)).length).toBe(1);
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await page.getByRole('button', { name: /^후보 검토/ }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '7');
  // Both saved translations match a candidate, so the manual filter lists two rows (plus the two header rows).
  await page.getByRole('group', { name: '상태 필터' }).getByRole('button', { name: '직접 번역', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '4');
});
