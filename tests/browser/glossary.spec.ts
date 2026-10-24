import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// QUALITY-01 screens: the glossary page, importing and exporting it, adding a rule from the review,
// and the quality warnings of a run. The core is the fixture in tests/frontend/tauri-fixture-init.js.
async function boot(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  // The clipboard is only the fallback of an export the shell could not save.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as any).__clip = text; } }, configurable: true });
  });
  await page.goto(`/?${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
}
const asked = (page: Page, type: string): Promise<{ type: string; payload: any }[]> =>
  page.evaluate((t) => ((window as any).__pomiGlossary ?? []).filter((item: { type: string }) => item.type === t), type);
const nav = (page: Page, name: string) => page.getByRole('navigation', { name: '주 메뉴' }).getByRole('button', { name, exact: true });
const openGlossary = async (page: Page) => {
  await nav(page, '용어집').click();
  await expect(page.getByRole('heading', { level: 1, name: '용어집' })).toBeVisible();
};
const saveBar = (page: Page) => page.locator('.action-bar');
const toasts = (page: Page) => page.getByRole('region', { name: '알림' });
const source = (page: Page, n: number) => page.getByRole('textbox', { name: `원문, 항목 ${n}`, exact: true });
const target = (page: Page, n: number) => page.getByRole('textbox', { name: `번역, 항목 ${n}`, exact: true });
async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((item) => `${item.id}: ${item.nodes.map((node) => node.target.join(' ')).join(' | ')}`)).toEqual([]);
}

test.describe('the glossary page', () => {
  test('an empty glossary explains itself, and entries are added with Enter and saved with the base revision', async ({ page }) => {
    await boot(page, 'scenario=selected');
    await openGlossary(page);
    const empty = page.getByText('아직 용어집이 비어 있습니다');
    await expect(empty).toBeVisible();
    // One sentence, with the example the person can recognise.
    await expect(page.getByText(/“Elder Mira”를 번역하지 않고 그대로 둘 수 있습니다/)).toBeVisible();
    await axe(page);

    await page.getByRole('button', { name: '첫 항목 추가' }).click();
    await expect(source(page, 1)).toBeFocused();
    await source(page, 1).fill('Elder Mira');
    await page.getByRole('combobox', { name: '처리 방법, 항목 1' }).selectOption('keep');
    await expect(target(page, 1)).toBeDisabled();
    // Enter adds the next entry below and moves into it.
    await source(page, 1).press('Enter');
    await expect(source(page, 2)).toBeFocused();
    await source(page, 2).fill('Lost Key');
    await target(page, 2).fill('잃어버린 열쇠');
    await page.getByRole('checkbox', { name: '대소문자 구분, 항목 2' }).check();
    await expect(saveBar(page)).toContainText('저장하지 않은 변경');
    await expect(page.getByText('2 / 2,000개')).toBeVisible();
    await axe(page);

    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(toasts(page)).toContainText('용어집을 저장했습니다');
    await expect(saveBar(page)).toHaveCount(0);
    const [set] = await asked(page, 'glossary.set');
    expect(set.payload).toMatchObject({ scope: 'global', baseRevision: 0 });
    expect(set.payload.entries).toEqual([
      { source: 'Elder Mira', target: '', mode: 'keep', caseSensitive: false, note: '' },
      { source: 'Lost Key', target: '잃어버린 열쇠', mode: 'translate', caseSensitive: true, note: '' }
    ]);
    // The next save carries the revision the core answered with.
    await source(page, 1).fill('Elder Mira II');
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect.poll(async () => (await asked(page, 'glossary.set')).length).toBe(2);
    expect((await asked(page, 'glossary.set'))[1].payload.baseRevision).toBe(1);
    expect((await asked(page, 'glossary.set'))[1].payload.entries[0].id).toMatch(/^[0-9a-f]{20}$/);
  });

  test('search, delete with a question, and the two scopes', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded');
    await openGlossary(page);
    await expect(source(page, 1)).toHaveValue('Elder Mira');
    await expect(page.getByText('2 / 2,000개')).toBeVisible();
    await axe(page);

    await page.getByRole('searchbox', { name: '용어집 검색' }).fill('열쇠');
    await expect(page.getByRole('textbox', { name: /^원문, 항목/ })).toHaveCount(1);
    await expect(page.getByText('1개 표시 · 전체 2 / 2,000개')).toBeVisible();
    await page.getByRole('searchbox', { name: '용어집 검색' }).fill('없는 말');
    await expect(page.getByText('검색과 맞는 항목이 없습니다.')).toBeVisible();
    await page.getByRole('searchbox', { name: '용어집 검색' }).fill('');

    // Delete asks first; Escape says no and keeps focus on the delete button.
    await page.getByRole('button', { name: '항목 1 삭제' }).click();
    const ask = page.getByRole('group', { name: '이 항목을 삭제할까요?' });
    await expect(ask).toBeVisible();
    await expect(ask.getByRole('button', { name: '삭제' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);
    await expect(page.getByRole('button', { name: '항목 1 삭제' })).toBeFocused();
    await page.getByRole('button', { name: '항목 1 삭제' }).click();
    await ask.getByRole('button', { name: '삭제' }).click();
    await expect(page.getByRole('textbox', { name: /^원문, 항목/ })).toHaveCount(1);
    await expect(saveBar(page)).toBeVisible();
    // Unsaved edits hold the scope in place.
    await expect(page.getByRole('button', { name: '이 월드', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '가져오기' })).toBeDisabled();
    await page.getByRole('button', { name: '변경 버리기' }).click();
    await expect(page.getByText('2 / 2,000개')).toBeVisible();

    // This world is a separate, empty list; the world's name is shown.
    await page.getByRole('button', { name: '이 월드', exact: true }).click();
    await expect(page.getByText('아직 용어집이 비어 있습니다')).toBeVisible();
    await expect(page.locator('.world')).toContainText('Roguefire');
    const worldGets = await asked(page, 'glossary.get');
    expect(worldGets.at(-1)?.payload.scope).toBe('world');
    expect(worldGets.at(-1)?.payload.worldDir).toContain('Roguefire');
  });

  test('a stale revision keeps the edits visible and offers to reload or to keep them', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=conflict-once');
    await openGlossary(page);
    await page.getByRole('button', { name: '첫 항목 추가' }).click();
    await source(page, 1).fill('Mine');
    await target(page, 1).fill('내 것');
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    const conflict = page.getByRole('alert').filter({ hasText: '용어집이 다른 곳에서 바뀌었습니다' });
    await expect(conflict).toBeVisible();
    // Nothing the person typed is lost.
    await expect(source(page, 1)).toHaveValue('Mine');
    await expect(target(page, 1)).toHaveValue('내 것');
    await axe(page);

    await conflict.getByRole('button', { name: '내 변경 유지' }).click();
    await expect(conflict).toHaveCount(0);
    await expect(source(page, 1)).toHaveValue('Mine');
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(toasts(page)).toContainText('용어집을 저장했습니다');
    const sets = await asked(page, 'glossary.set');
    expect(sets).toHaveLength(2);
    // The second try used the revision of the version someone else saved.
    expect(sets[1].payload.baseRevision).toBe(1);
  });

  test('"load the saved version" replaces the edits with what the core has', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=conflict-once');
    await openGlossary(page);
    await page.getByRole('button', { name: '첫 항목 추가' }).click();
    await source(page, 1).fill('Mine');
    await target(page, 1).fill('내 것');
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    const conflict = page.getByRole('alert').filter({ hasText: '용어집이 다른 곳에서 바뀌었습니다' });
    await conflict.getByRole('button', { name: '저장된 버전 불러오기' }).click();
    await expect(source(page, 1)).toHaveValue('Added Elsewhere');
    await expect(saveBar(page)).toHaveCount(0);
  });

  test('a refused field is pointed at, and a failed write keeps the edits', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=invalid');
    await openGlossary(page);
    await page.getByRole('button', { name: '첫 항목 추가' }).click();
    await source(page, 1).fill('A');
    await target(page, 1).fill('가');
    await source(page, 1).press('Enter');
    await source(page, 2).fill('B');
    await target(page, 2).fill('나');
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    // The core's entries[1].target: row 2, the translation field.
    await expect(target(page, 2)).toHaveAttribute('aria-invalid', 'true');
    await expect(target(page, 2)).toBeFocused();
    await expect(page.getByText('항목 2의 “번역” 칸을 받아들일 수 없습니다')).toBeVisible();
    await expect(target(page, 1)).not.toHaveAttribute('aria-invalid', 'true');
    await axe(page);

    await boot(page, 'scenario=selected&glossary=write-failed');
    await openGlossary(page);
    await page.getByRole('button', { name: '첫 항목 추가' }).click();
    await source(page, 1).fill('Keep me');
    await target(page, 1).fill('남겨 줘');
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '용어집을 저장하지 못했습니다' })).toBeVisible();
    await expect(source(page, 1)).toHaveValue('Keep me');
    await expect(saveBar(page)).toBeVisible();
  });

  test('rules are checked on screen before they are sent, and a busy file is tried again', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=busy-once');
    await openGlossary(page);
    await page.getByRole('button', { name: '첫 항목 추가' }).click();
    await source(page, 1).fill('Mira');
    // A translation without a target stops before the request.
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByText('번역할 말을 입력하거나 “그대로 두기”를 고르세요.')).toBeVisible();
    await expect(target(page, 1)).toBeFocused();
    expect((await asked(page, 'glossary.set')).length).toBe(0);
    await target(page, 1).fill('미라');
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(toasts(page)).toContainText('용어집을 저장했습니다');
    // The first attempt was busy; the page tried again by itself.
    expect((await asked(page, 'glossary.set')).length).toBe(2);
  });

  test('unsaved edits take part in the leave and quit guards', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded');
    await openGlossary(page);
    await source(page, 1).fill('Elder Mira II');
    expect(await page.evaluate(() => (window as any).__pomiDirty)).toBe(true);
    await nav(page, '환경 설정').click();
    const leave = page.getByRole('dialog', { name: '저장하지 않은 용어집 변경이 있습니다' });
    await expect(leave).toBeVisible();
    await leave.getByRole('button', { name: '계속 편집' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '용어집' })).toBeVisible();
    await expect(source(page, 1)).toHaveValue('Elder Mira II');
    // Quitting asks about the glossary, not about settings.
    await page.evaluate(() => (window as any).__pomiEmit('pomi-exit-confirm', { job: false, dirty: true, reason: 'quit', intent: 5 }));
    await expect(page.getByRole('dialog', { name: '저장하지 않은 용어집 변경이 있습니다' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: '취소' }).click();

    await nav(page, '환경 설정').click();
    await leave.getByRole('button', { name: '저장하지 않고 이동' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '환경 설정' })).toBeVisible();
    await nav(page, '용어집').click();
    await expect(source(page, 1)).toHaveValue('Elder Mira');
  });

  test('while a save is on its way nothing can be edited, and the saved list is what was sent', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded&glossaryHold=save');
    await openGlossary(page);
    await source(page, 1).fill('Elder Mira II');
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect.poll(async () => (await asked(page, 'glossary.set')).length).toBe(1);
    const list = page.getByRole('list', { name: '용어집 항목' });
    await expect(list).toHaveAttribute('aria-busy', 'true');
    for (const n of [1, 2]) {
      await expect(source(page, n)).toHaveAttribute('readonly', '');
      await expect(target(page, n)).toHaveAttribute('readonly', '');
      await expect(page.getByRole('textbox', { name: `메모, 항목 ${n}`, exact: true })).toHaveAttribute('readonly', '');
      await expect(page.getByRole('combobox', { name: `처리 방법, 항목 ${n}` })).toBeDisabled();
      await expect(page.getByRole('checkbox', { name: `대소문자 구분, 항목 ${n}` })).toBeDisabled();
      await expect(page.getByRole('button', { name: `항목 ${n} 삭제` })).toBeDisabled();
    }
    await expect(page.locator('#glossary-add')).toBeDisabled();
    for (const name of ['가져오기', '내보내기']) await expect(page.getByRole('button', { name, exact: true }).first()).toBeDisabled();
    await expect(page.getByRole('button', { name: '이 월드', exact: true })).toBeDisabled();
    // Typing and Enter go nowhere.
    await source(page, 1).focus();
    await page.keyboard.type('LOST');
    await page.keyboard.press('Enter');
    await expect(source(page, 1)).toHaveValue('Elder Mira II');
    await expect(page.getByRole('textbox', { name: /^원문, 항목/ })).toHaveCount(2);
    await page.evaluate(() => (window as any).__pomiRelease());
    await expect(toasts(page)).toContainText('용어집을 저장했습니다');
    await expect(saveBar(page)).toHaveCount(0);
    await expect(source(page, 1)).toHaveValue('Elder Mira II');
    await expect(source(page, 1)).not.toHaveAttribute('readonly', '');
    await expect(list).not.toHaveAttribute('aria-busy', 'true');
    await source(page, 1).fill('Again');
    await expect(saveBar(page)).toBeVisible();
  });

  test('the duplicate check follows the core: ß is ss, and two case-sensitive spellings may coexist', async ({ page }) => {
    await boot(page, 'scenario=selected');
    await openGlossary(page);
    await page.getByRole('button', { name: '첫 항목 추가' }).click();
    await source(page, 1).fill('Straße');
    await target(page, 1).fill('거리');
    await source(page, 1).press('Enter');
    await source(page, 2).fill('STRASSE');
    await target(page, 2).fill('도로');
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByText('같은 원문이 이미 있습니다.')).toBeVisible();
    await expect(source(page, 2)).toHaveAttribute('aria-invalid', 'true');
    expect((await asked(page, 'glossary.set')).length).toBe(0);
    // Both case-sensitive: the spellings differ, so both may stay.
    await page.getByRole('checkbox', { name: '대소문자 구분, 항목 1' }).check();
    await page.getByRole('checkbox', { name: '대소문자 구분, 항목 2' }).check();
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(toasts(page)).toContainText('용어집을 저장했습니다');
  });

  test('an older core without a glossary says so', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=unsupported');
    await openGlossary(page);
    await expect(page.getByRole('alert').filter({ hasText: '번역 코어에서는 용어집을 사용할 수 없습니다' })).toBeVisible();
  });

  test('the glossary page fits a narrow window without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 800 });
    await boot(page, 'scenario=selected&glossary=seeded');
    await openGlossary(page);
    await expect(source(page, 1)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.evaluate(() => { const main = document.querySelector('main')!; return main.scrollWidth <= main.clientWidth; })).toBe(true);
    await axe(page);
  });
});

test.describe('a long list', () => {
  const seed2000 = (page: Page) => page.addInitScript(() => {
    if (sessionStorage.getItem('pomi.fixture.glossary')) return;
    const entries = Array.from({ length: 2000 }, (_, i) => ({ id: i.toString(16).padStart(20, '0'), source: `Source term number ${i}`, target: `번역 ${i}`, mode: 'translate', caseSensitive: false, note: i % 5 ? '' : 'a note' }));
    sessionStorage.setItem('pomi.fixture.glossary', JSON.stringify({ global: { revision: 1, entries } }));
  });
  // The page measures "unsaved" and the count from the edited row, not from the whole list; these are
  // the cases where that must still agree with a comparison of the whole list.
  const input = (page: Page, label: string) => page.locator(`[aria-label="${label}"]`);

  test('typing in a row keeps the count and the unsaved state right, even when the typing is undone', async ({ page }) => {
    test.setTimeout(60000);
    await seed2000(page);
    await boot(page, 'scenario=selected');
    await openGlossary(page);
    await expect(page.getByText('2,000 / 2,000개')).toBeVisible();
    await expect(saveBar(page)).toHaveCount(0);
    // 200 rows are drawn first; every one of them keeps its names.
    await expect(page.locator('li.entry')).toHaveCount(200);

    const row1 = input(page, '번역, 항목 1');
    await row1.fill('번역 0!');
    await expect(saveBar(page)).toContainText('저장하지 않은 변경');
    await expect(page.getByText('2,000 / 2,000개')).toBeVisible();
    await row1.fill('번역 0');
    await expect(saveBar(page)).toHaveCount(0);
    // A row emptied completely is not saved, so it leaves the count; filling it again brings the count and the clean state back.
    await input(page, '원문, 항목 1').fill('');
    await row1.fill('');
    await input(page, '메모, 항목 1').fill('');
    await expect(page.getByText('1,999 / 2,000개')).toBeVisible();
    await expect(saveBar(page)).toContainText('저장하지 않은 변경');
    await input(page, '원문, 항목 1').fill('Source term number 0');
    await row1.fill('번역 0');
    await input(page, '메모, 항목 1').fill('a note');
    await expect(page.getByText('2,000 / 2,000개')).toBeVisible();
    await expect(saveBar(page)).toHaveCount(0);
  });

  test('a row far down the list can be reached by "show more" and by a refused save', async ({ page }) => {
    test.setTimeout(90000);
    await seed2000(page);
    await boot(page, 'scenario=selected');
    await openGlossary(page);
    const more = page.locator('button.more');
    // Axe over a few rows near the top and a few from the second page, which is drawn with the long-list rules.
    await more.click();
    await expect(page.locator('li.entry')).toHaveCount(400);
    const rows = await new AxeBuilder({ page }).include('.entries > li:nth-child(-n+3)').include('.entries > li:nth-child(n+398)')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(rows.violations.map((item) => item.id)).toEqual([]);
    for (let i = 1; i < 9; i += 1) await more.click();
    await expect(more).toHaveCount(0);
    await expect(page.locator('li.entry')).toHaveCount(2000);
    // Past the first page the rows far from the screen are not laid out, but they keep their names and take focus.
    const last = input(page, '번역, 항목 2000');
    await last.focus();
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport();
    // Clearing the source of a row that still has a translation is refused on screen, and the row is brought into view.
    await input(page, '번역, 항목 1').focus();
    await input(page, '원문, 항목 1500').fill('');
    await input(page, '원문, 항목 1').scrollIntoViewIfNeeded();
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(input(page, '원문, 항목 1500')).toBeFocused();
    await expect(input(page, '원문, 항목 1500')).toBeInViewport();
    await expect(input(page, '원문, 항목 1500')).toHaveAttribute('aria-invalid', 'true');
    expect(await asked(page, 'glossary.set')).toHaveLength(0);
  });
});

test.describe('importing and exporting', () => {
  const csv = (text: string) => ({ name: 'terms.csv', mimeType: 'text/csv', buffer: Buffer.from(text, 'utf-8') });

  test('a merge shows what changed and the rows that were skipped, in words', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded');
    await openGlossary(page);
    await page.getByRole('button', { name: '가져오기' }).first().click();
    const dialog = page.getByRole('dialog', { name: '용어집 가져오기' });
    await expect(dialog.getByRole('button', { name: '가져오기' })).toBeDisabled();
    await dialog.locator('input[type="file"]').setInputFiles(csv('source,target,mode,note\nGate,문,translate,\nElder Mira,,keep,village elder\n,x,translate,\nBroken,,translate,\n'));
    await expect(dialog).toContainText('고른 파일: terms.csv');
    await axe(page);
    await dialog.getByRole('button', { name: '가져오기' }).click();

    const result = page.getByRole('dialog', { name: '가져오기 결과' });
    await expect(result).toBeVisible();
    await expect(result.locator('.counts div').filter({ hasText: '추가' })).toContainText('1');
    await expect(result.locator('.counts div').filter({ hasText: '그대로' })).toContainText('1');
    await expect(result).toContainText('건너뛴 줄 2개');
    await expect(result).toContainText('원문이 비어 있음');
    await expect(result).toContainText('번역이 비어 있음');
    await axe(page);
    const [sent] = await asked(page, 'glossary.import');
    expect(sent.payload).toMatchObject({ scope: 'global', baseRevision: 0, format: 'csv', mode: 'merge' });
    expect(sent.payload.text).toContain('Gate,문,translate');
    await result.getByRole('button', { name: '닫기', exact: true }).last().click();
    await expect(page.getByText('3 / 2,000개')).toBeVisible();
    await expect(toasts(page)).toContainText('가져왔습니다. 추가 1, 수정 0, 삭제 0.');
  });

  test('replacing the whole list asks first', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded');
    await openGlossary(page);
    await page.getByRole('button', { name: '가져오기' }).first().click();
    const dialog = page.getByRole('dialog', { name: '용어집 가져오기' });
    await dialog.locator('input[type="file"]').setInputFiles({ name: 'terms.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from('Gate\t문\n', 'utf-8') });
    await dialog.getByRole('radio', { name: /통째로 바꾸기/ }).check();
    await dialog.getByRole('button', { name: '가져오기' }).click();
    const ask = page.getByRole('dialog', { name: '목록을 통째로 바꿀까요?' });
    await expect(ask).toContainText('지금 항목 2개가 지워지고');
    expect((await asked(page, 'glossary.import')).length).toBe(0);
    await ask.getByRole('button', { name: '취소' }).click();
    expect((await asked(page, 'glossary.import')).length).toBe(0);
    await dialog.getByRole('button', { name: '가져오기' }).click();
    await page.getByRole('dialog', { name: '목록을 통째로 바꿀까요?' }).getByRole('button', { name: '통째로 바꾸기' }).click();
    const result = page.getByRole('dialog', { name: '가져오기 결과' });
    await expect(result).toBeVisible();
    const [sent] = await asked(page, 'glossary.import');
    expect(sent.payload).toMatchObject({ format: 'tsv', mode: 'replace' });
    await expect(result.locator('.counts div').filter({ hasText: '삭제' })).toContainText('2');
  });

  const exported = (page: Page): Promise<{ kind: string; fileName: string | null; document: string }[]> =>
    page.evaluate(() => (window as any).__pomiExports ?? []);

  test('export opens the save dialog with the exact text, and the toast explains the protective apostrophe', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded&glossaryExport=save');
    await openGlossary(page);
    await page.getByRole('button', { name: '내보내기' }).click();
    await expect(toasts(page)).toContainText('용어집 2개를 내보냈습니다');
    await expect(toasts(page)).toContainText("맨 앞에 ' 가 붙으며");
    const [saved] = await exported(page);
    expect(saved).toMatchObject({ kind: 'glossary_csv', fileName: 'pomi-glossary-global.csv' });
    // The text is handed over as the core wrote it, byte-order mark included.
    expect(saved.document.charCodeAt(0)).toBe(0xfeff);
    expect(saved.document).toContain('source,target,mode,note,caseSensitive');
    expect(saved.document).toContain('Elder Mira,,keep,village elder,false');
    expect(await page.evaluate(() => (window as any).__clip)).toBeUndefined();
    expect((await asked(page, 'glossary.export'))[0].payload).toMatchObject({ scope: 'global', format: 'csv' });
  });

  test('in a browser the export is a download of the same text', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded');
    await openGlossary(page);
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '내보내기' }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('pomi-glossary-global.csv');
    const bytes = await readFile((await download.path())!);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString('utf8')).toContain('Elder Mira,,keep,village elder,false');
    await expect(toasts(page)).toContainText('용어집 2개를 내보냈습니다');
    expect(await exported(page)).toEqual([]);
  });

  test('the file of a world list is named after the world scope', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded&glossaryExport=save');
    await openGlossary(page);
    await page.getByRole('button', { name: '이 월드', exact: true }).click();
    await page.getByRole('button', { name: '첫 항목 추가' }).click();
    await source(page, 1).fill('Gate');
    await target(page, 1).fill('문');
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(toasts(page)).toContainText('용어집을 저장했습니다');
    await page.getByRole('button', { name: '내보내기' }).click();
    await expect.poll(async () => (await exported(page)).length).toBe(1);
    expect((await exported(page))[0].fileName).toBe('pomi-glossary-world.csv');
  });

  test('a dismissed save dialog says nothing', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded&glossaryExport=cancel');
    await openGlossary(page);
    await page.getByRole('button', { name: '내보내기' }).click();
    await expect.poll(async () => (await exported(page)).length).toBe(1);
    await expect(page.getByRole('button', { name: '내보내기' })).toBeEnabled();
    await expect(toasts(page).locator('.toast')).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: '용어집을 내보내지 못했습니다' })).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__clip)).toBeUndefined();
  });

  test('when the file cannot be saved the clipboard copy is offered instead', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded&glossaryExport=fail');
    await openGlossary(page);
    await page.getByRole('button', { name: '내보내기' }).click();
    const failure = page.getByRole('alert').filter({ hasText: '용어집을 내보내지 못했습니다' });
    await expect(failure).toContainText('파일을 저장하지 못했습니다');
    await axe(page);
    await failure.getByRole('button', { name: '클립보드에 복사' }).click();
    await expect(toasts(page)).toContainText('용어집 2개를 클립보드에 복사했습니다');
    await expect(failure).toHaveCount(0);
    const clip = await page.evaluate(() => (window as any).__clip as string);
    expect(clip.charCodeAt(0)).not.toBe(0xfeff);
    expect(clip).toContain('Elder Mira,,keep,village elder,false');
  });

  test('a note with line breaks survives import, an edit, a save and an export exactly', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded&glossaryExport=save');
    await openGlossary(page);
    await page.getByRole('button', { name: '가져오기' }).first().click();
    const dialog = page.getByRole('dialog', { name: '용어집 가져오기' });
    await dialog.locator('input[type="file"]').setInputFiles(csv('source,target,mode,note,caseSensitive\nGate,문,translate,"line one\nline two\tthree",false\n'));
    await dialog.getByRole('button', { name: '가져오기' }).click();
    await page.getByRole('dialog', { name: '가져오기 결과' }).getByRole('button', { name: '닫기', exact: true }).last().click();
    await expect(page.getByText('3 / 2,000개')).toBeVisible();

    const note = page.getByRole('textbox', { name: '메모, 항목 3', exact: true });
    await expect(note).toHaveValue('line one\nline two\tthree');
    // The field is as tall as its two lines, not the height of a single-line field.
    const oneLine = (await page.getByRole('textbox', { name: '메모, 항목 1', exact: true }).boundingBox())!.height;
    expect((await note.boundingBox())!.height).toBeGreaterThan(oneLine + 10);
    // Enter in a note is a line break; it does not add a row.
    await note.click();
    await note.press('Control+End');
    await note.press('Enter');
    await note.pressSequentially('line four');
    await expect(page.getByRole('textbox', { name: /^원문, 항목/ })).toHaveCount(3);
    await expect(note).toHaveValue('line one\nline two\tthree\nline four');
    await saveBar(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(toasts(page)).toContainText('용어집을 저장했습니다');
    const [set] = await asked(page, 'glossary.set');
    expect(set.payload.entries[2]).toMatchObject({ source: 'Gate', note: 'line one\nline two\tthree\nline four' });
    await expect(note).toHaveValue('line one\nline two\tthree\nline four');

    await page.getByRole('button', { name: '내보내기' }).click();
    await expect.poll(async () => (await exported(page)).length).toBe(1);
    expect((await exported(page))[0].document).toContain('Gate,문,translate,"line one\nline two\tthree\nline four",false');
  });

  test('Enter still adds a row from the source and translation fields only', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded');
    await openGlossary(page);
    await target(page, 2).press('Enter');
    await expect(source(page, 3)).toBeFocused();
    await expect(page.getByRole('textbox', { name: /^원문, 항목/ })).toHaveCount(3);
    await page.getByRole('textbox', { name: '메모, 항목 3', exact: true }).press('Enter');
    await expect(page.getByRole('textbox', { name: /^원문, 항목/ })).toHaveCount(3);
  });

  test('importing does not close while the request runs, and the result is shown once it is done', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded&glossaryHold=import');
    await openGlossary(page);
    await page.getByRole('button', { name: '가져오기' }).first().click();
    const dialog = page.getByRole('dialog', { name: '용어집 가져오기' });
    await dialog.locator('input[type="file"]').setInputFiles(csv('source,target,mode,note\nGate,문,translate,\n'));
    await dialog.getByRole('button', { name: '가져오기' }).click();
    await expect.poll(async () => (await asked(page, 'glossary.import')).length).toBe(1);
    // There is no corner X next to the choices; Cancel is disabled, and Escape and a click on the backdrop leave the dialog open.
    await expect(dialog.getByRole('button', { name: '닫기' })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    await page.evaluate(() => (window as any).__pomiRelease());
    const result = page.getByRole('dialog', { name: '가져오기 결과' });
    await expect(result).toBeVisible();
    await expect(toasts(page)).toContainText('가져왔습니다. 추가 1');
    expect((await asked(page, 'glossary.import')).length).toBe(1);
    await result.getByRole('button', { name: '닫기', exact: true }).last().click();
    await expect(page.getByText('3 / 2,000개')).toBeVisible();
  });
});

test.describe('adding from the review', () => {
  async function toReview(page: Page) {
    await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
    await page.getByRole('button', { name: /^번역할 문장 고르기/ }).last().click();
    await expect(page.getByRole('grid')).toBeVisible();
    await page.locator('tr[data-index="0"]').click();
  }

  test('the selected part of the sentence fills the source; the rule is saved to the chosen list', async ({ page }) => {
    await boot(page, 'scenario=selected');
    await toReview(page);
    await page.locator('.detail .source').evaluate((node) => {
      const range = document.createRange();
      const text = node.firstChild as Text;
      range.setStart(text, 11);
      range.setEnd(text, 20);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.getByRole('button', { name: '용어집에 추가' }).click();
    const dialog = page.getByRole('dialog', { name: '용어집에 추가' });
    await expect(dialog.getByRole('textbox', { name: '원문' })).toHaveValue('Roguefire');
    // Cancel is the way out; there is no second corner X.
    await expect(dialog.getByRole('button', { name: '닫기', exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeVisible();
    await axe(page);
    await dialog.getByRole('textbox', { name: '번역' }).fill('로그파이어');
    await dialog.getByRole('button', { name: '이 월드', exact: true }).click();
    await dialog.getByRole('button', { name: '추가', exact: true }).click();
    await expect(toasts(page)).toContainText('용어집에 추가했습니다');
    const [get] = await asked(page, 'glossary.get');
    expect(get.payload.scope).toBe('world');
    const [set] = await asked(page, 'glossary.set');
    expect(set.payload).toMatchObject({ scope: 'world', baseRevision: 0 });
    expect(set.payload.entries).toEqual([{ source: 'Roguefire', target: '로그파이어', mode: 'translate', caseSensitive: false, note: '' }]);
  });

  test('without a selection the whole sentence is the source, keep needs no translation, and a rule that exists is reported', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded');
    await page.getByRole('button', { name: '스캔 시작', exact: true }).click();
    await page.getByRole('button', { name: /^번역할 문장 고르기/ }).last().click();
    await expect(page.getByRole('grid')).toBeVisible();
    await page.locator('tr[data-index="0"]').click();
    await page.getByRole('button', { name: '용어집에 추가' }).click();
    const dialog = page.getByRole('dialog', { name: '용어집에 추가' });
    await expect(dialog.getByRole('textbox', { name: '원문' })).toHaveValue('Welcome to Roguefire');
    // A translation is needed unless the sentence is kept as written.
    await dialog.getByRole('button', { name: '추가', exact: true }).click();
    await expect(dialog.getByText('번역할 말을 입력하거나 “그대로 두기”를 고르세요.')).toBeVisible();
    await dialog.getByRole('textbox', { name: '원문' }).fill('elder mira');
    await dialog.getByRole('button', { name: '그대로 두기' }).click();
    await dialog.getByRole('button', { name: '추가', exact: true }).click();
    await expect(dialog).toContainText('이미 용어집에 있는 원문입니다');
    expect((await asked(page, 'glossary.set')).length).toBe(0);
    await dialog.getByRole('button', { name: '용어집 열기' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '용어집' })).toBeVisible();
  });
});

test.describe('quality warnings of a run', () => {
  test('the run shows the counts quietly and a glossary change in one line', async ({ page }) => {
    await boot(page, 'scenario=run-progress&progress=quality');
    await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
    await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
    const consent = page.getByRole('dialog');
    if (await consent.count()) await consent.getByRole('button', { name: /전송|보내|번역 시작|계속/ }).last().click();
    await expect(page.getByText('품질 경고 3건: 용어집 불일치 2, 서식 코드 잔여 1.')).toBeVisible();
    await expect(page.getByText('용어집이 바뀌어 이어하기 전에 저장된 번역 9개를 버렸습니다.')).toBeVisible();
    await axe(page);
  });

  test('the result lists the counts with an explanation, five samples, and the rule each one missed', async ({ page }) => {
    await boot(page, 'scenario=result-quality&glossary=seeded');
    await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
    await page.getByRole('button', { name: /^(번역 시작|이어서 번역)$/ }).click();
    const consent = page.getByRole('dialog');
    if (await consent.count()) await consent.getByRole('button', { name: /전송|보내|번역 시작|계속/ }).last().click();
    const quality = page.getByRole('region', { name: '품질 확인' });
    await expect(quality).toBeVisible();
    await expect(quality).toContainText('용어집과 다르게 번역된 문장');
    await expect(quality).toContainText('서식 코드 뒤에 원문 글자가 남은 문장');
    await expect(quality).toContainText('한 번에 보낼 수 있는 용어는 80개');
    await expect(quality).toContainText('예시 5개 (전체 9건)');
    await expect(quality.locator('tbody tr:not(.why)')).toHaveCount(5);
    await expect(quality).not.toContainText('a sixth sample');
    // Which rule was missed comes from the glossary as it is now.
    await expect(quality).toContainText('“Elder Mira”는 그대로 두어야 했습니다');
    await expect(quality).toContainText('“Lost Key”는 “잃어버린 열쇠”(으)로 번역해야 했습니다');
    await expect(quality).toContainText('이 경고의 용어집 항목은 지금 목록에 없습니다.');
    // The report-level warning explains the dropped translations in a line.
    await expect(page.getByText('용어집이 바뀌어 저장된 번역 4개를 버리고 다시 번역했습니다.')).toBeVisible();
    await axe(page);
    await quality.getByRole('button', { name: '용어집 열기' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '용어집' })).toBeVisible();
  });
});

test.describe('keyboard and names', () => {
  test('every control of an entry has a name that says which entry it belongs to', async ({ page }) => {
    await boot(page, 'scenario=selected&glossary=seeded');
    await openGlossary(page);
    for (const name of ['원문, 항목 2', '번역, 항목 2', '처리 방법, 항목 2', '대소문자 구분, 항목 2', '메모, 항목 2', '항목 2 삭제']) {
      await expect(page.getByRole(name.startsWith('처리') ? 'combobox' : name.endsWith('삭제') ? 'button' : name.startsWith('대소문자') ? 'checkbox' : 'textbox', { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('list', { name: '용어집 항목' })).toBeVisible();
    // Tab order inside a row follows the columns.
    await source(page, 1).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: '처리 방법, 항목 1' })).toBeFocused();
  });
});
