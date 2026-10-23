import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

async function open(page: Page, query = 'scenario=review') {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('main')).not.toContainText('불러오는 중');
}
async function settings(page: Page, query?: string) {
  await open(page, query);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '환경 설정' })).toBeVisible();
}
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: false });
const selected = (page: Page) => page.getByRole('tab', { selected: true });
const saveBar = (page: Page) => page.locator('.save-bar');
const requests = (page: Page, type: string) =>
  page.evaluate((kind) => (window as unknown as { __pomiRequests: { type: string }[] }).__pomiRequests.filter((request) => request.type === kind), type);
const saves = (page: Page) => page.evaluate(() => (window as unknown as { __pomiSettingsSaves: Record<string, any>[] }).__pomiSettingsSaves);
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

test('settings has four tabs, 번역 first, with matching tab panels', async ({ page }) => {
  await settings(page);
  const list = page.getByRole('tablist', { name: '설정 구역' });
  await expect(list.getByRole('tab')).toHaveText(['번역', '스캔 범위', '고급', '앱']);
  await expect(selected(page)).toHaveText('번역');
  for (const [name, panel] of [['번역', 'translate'], ['스캔 범위', 'scope'], ['고급', 'advanced'], ['앱', 'app']]) {
    await tab(page, name).click();
    await expect(selected(page)).toHaveText(name);
    await expect(tab(page, name)).toHaveAttribute('aria-controls', `settings-panel-${panel}`);
    const visible = page.getByRole('tabpanel');
    await expect(visible).toHaveCount(1);
    await expect(visible).toHaveAttribute('id', `settings-panel-${panel}`);
    await expect(visible).toHaveAccessibleName(name);
  }
});

test('arrow keys, Home and End move between tabs, and only the selected tab is in the tab order', async ({ page }) => {
  await settings(page);
  await tab(page, '번역').focus();
  await expect(tab(page, '번역')).toHaveAttribute('tabindex', '0');
  await expect(tab(page, '고급')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, '스캔 범위')).toBeFocused();
  await expect(selected(page)).toHaveText('스캔 범위');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(selected(page)).toHaveText('앱');
  await page.keyboard.press('ArrowRight');
  await expect(selected(page)).toHaveText('번역');
  await page.keyboard.press('ArrowLeft');
  await expect(selected(page)).toHaveText('앱');
  await page.keyboard.press('Home');
  await expect(selected(page)).toHaveText('번역');
  await page.keyboard.press('End');
  await expect(selected(page)).toHaveText('앱');
  // Tab leaves the tab list for the content of the shown panel.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel').locator(':focus')).toHaveCount(1);
});

test('the last tab is kept for the session, and every screen change returns to it', async ({ page }) => {
  await settings(page);
  await tab(page, '고급').click();
  await page.getByRole('button', { name: '도움말', exact: true }).click();
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(selected(page)).toHaveText('고급');
  await expect(page.getByRole('heading', { level: 2, name: '속도 및 요청 한도 제어' })).toBeVisible();
});

test('"환경 설정 열기" from the run step lands on 번역 and "저장하고 돌아가기" returns', async ({ page }) => {
  await open(page, 'scenario=run&fresh=1');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  // Another tab was used last: the fix-it link still opens the tab that holds the fix.
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await tab(page, '앱').click();
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await page.getByRole('alert').getByRole('button', { name: '환경 설정에서 설정하기' }).click();
  await expect(selected(page)).toHaveText('번역');
  await expect(saveBar(page)).toContainText('"번역 준비" 단계로 돌아가기');
  await page.locator('#api-key').fill('sk-fixture');
  await page.locator('#model').fill('fixture-model');
  await expect(saveBar(page)).toContainText('번역 탭에 저장하지 않은 변경 2개');
  await page.getByRole('button', { name: '저장하고 돌아가기', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: '번역 준비', exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '번역을 시작하려면' })).toHaveCount(0);
  await expect(page.locator('main')).toContainText('OpenAI · fixture-model');
});

test('the Help menu\'s update check opens the app tab', async ({ page }) => {
  await settings(page);
  await tab(page, '번역').click();
  // The shell menu is native; the same app action is reached through the event hook of the fixture.
  await page.evaluate(() => (window as unknown as { __pomiEmit: (name: string, payload: unknown) => void }).__pomiEmit('pomi-menu', 'updates'));
  await expect(selected(page)).toHaveText('앱');
  await expect(page.getByRole('button', { name: /^업데이트/ })).toHaveAttribute('aria-expanded', 'true');
});

test('the save bar only exists while a save-required change is pending, and names the tabs', async ({ page }) => {
  await settings(page);
  await expect(saveBar(page)).toHaveCount(0);
  for (const name of ['번역', '스캔 범위', '고급', '앱']) { await tab(page, name).click(); await expect(saveBar(page)).toHaveCount(0); }

  await tab(page, '번역').click();
  await page.locator('#style-prompt').fill('말투 지시');
  await expect(saveBar(page)).toContainText('번역 탭에 저장하지 않은 변경 1개');
  await expect(tab(page, '번역').locator('.dot')).toHaveText('1');

  await tab(page, '고급').click();
  await page.locator('#batch-size').fill('25');
  await expect(saveBar(page)).toContainText('번역·고급 탭에 저장하지 않은 변경 2개');
  await expect(tab(page, '고급').locator('.dot')).toHaveText('1');

  await tab(page, '스캔 범위').click();
  await page.getByLabel('표지판', { exact: true }).uncheck();
  await expect(saveBar(page)).toContainText('번역·스캔 범위·고급 탭에 저장하지 않은 변경 3개');

  // The app tab shows a light cross-tab status; its instant-apply controls do not own the save bar.
  await tab(page, '앱').click();
  await expect(saveBar(page)).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '다른 탭에서 확인할 항목이 있습니다: 번역·스캔 범위·고급' })).toBeVisible();
  await expect(tab(page, '앱').locator('.dot')).toHaveCount(0);

  await tab(page, '고급').click();
  await page.getByRole('button', { name: '변경 취소', exact: true }).click();
  await expect(saveBar(page)).toHaveCount(0);
  await expect(page.locator('#style-prompt')).toBeAttached();
  await tab(page, '번역').click();
  await expect(page.locator('#style-prompt')).toHaveValue('');
  await tab(page, '고급').click();
  await expect(page.locator('#batch-size')).toHaveValue('40');
});

test('saving from any tab saves everything and clears the bar', async ({ page }) => {
  await settings(page);
  await page.locator('#style-prompt').fill('말투 지시');
  await tab(page, '고급').click();
  await page.locator('#batch-size').fill('25');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(saveBar(page)).toHaveCount(0);
  await expect.poll(async () => (await saves(page)).length).toBe(1);
  expect((await saves(page))[0]).toMatchObject({ stylePrompt: '말투 지시', batchSize: 25 });
});

test('instant-apply items never raise the save bar', async ({ page }) => {
  await settings(page);
  await tab(page, '앱').click();
  await page.getByRole('radio', { name: '다크' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(saveBar(page)).toHaveCount(0);
  await page.getByRole('radio', { name: '라이트' }).check();
  await page.locator('#ui-language').selectOption('en');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(saveBar(page)).toHaveCount(0);
  await page.locator('#ui-language').selectOption('ko');
  await expect(page.getByRole('heading', { level: 1, name: '환경 설정' })).toBeVisible();
  const auto = page.getByRole('checkbox', { name: /하루 한 번 자동으로 확인/ });
  await expect(page.getByRole('button', { name: /^업데이트/ })).toHaveAttribute('aria-expanded', 'true');
  await auto.uncheck();
  await expect(saveBar(page)).toHaveCount(0);
  // Only the display language writes settings (at once, with nothing else of the draft); theme and updates write app prefs.
  expect((await saves(page)).map((save) => save.uiLanguage)).toEqual(['en', 'ko']);
  expect(await page.evaluate(() => (window as unknown as { __pomiPrefs: Record<string, unknown> }).__pomiPrefs)).toMatchObject({ update_auto_check: false });
});

test('leaving with unsaved changes still asks, whichever tab they are on', async ({ page }) => {
  await settings(page);
  await tab(page, '고급').click();
  await page.locator('#concurrency').fill('2');
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '저장하지 않은 설정이 있습니다' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.close')).toHaveCount(0);
  await dialog.getByRole('button', { name: '계속 편집' }).click();
  await expect(page.locator('#concurrency')).toHaveValue('2');
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await dialog.getByRole('button', { name: '저장하지 않고 이동' }).click();
  await expect(page.getByRole('heading', { level: 1, name: '환경 설정' })).toHaveCount(0);
});

test('an error on another tab blocks saving and says which tab to open', async ({ page }) => {
  await settings(page);
  await page.locator('#style-prompt').fill('x');
  await tab(page, '고급').click();
  await page.locator('#concurrency').fill('99');
  await expect(saveBar(page)).toContainText('고급 탭의 오류를 확인해 주세요.');
  await expect(tab(page, '고급')).toHaveClass(/invalid/);
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
  await tab(page, '번역').click();
  await expect(saveBar(page)).toContainText('고급 탭의 오류를 확인해 주세요.');
  await tab(page, '고급').click();
  await page.locator('#concurrency').fill('3');
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
});

test('advanced fields explain themselves, and each section can return to its defaults', async ({ page }) => {
  await settings(page);
  await tab(page, '고급').click();
  await expect(page.getByRole('button', { name: /^속도 및 요청 한도 제어/ })).toHaveAttribute('aria-expanded', 'true');
  for (const id of ['concurrency', 'batch-size', 'temperature', 'timeout', 'retries', 'write-retries', 'rpm', 'tpm']) {
    const description = await page.locator(`#${id}`).getAttribute('aria-describedby');
    expect(description, id).toBeTruthy();
    await expect(page.locator(`#${description}`)).not.toBeEmpty();
  }
  await page.locator('#batch-size').fill('10');
  await page.locator('#temperature').fill('1.2');
  await page.getByRole('checkbox', { name: /파일 오류 시 다른 파일을 계속 처리/ }).uncheck();
  await expect(saveBar(page)).toContainText('고급 탭에 저장하지 않은 변경 3개');
  const defaults = page.getByRole('button', { name: '이 구역을 기본값으로' });
  await defaults.first().click();
  await expect(page.locator('#batch-size')).toHaveValue('40');
  await expect(page.locator('#temperature')).toHaveValue('0.3');
  await expect(page.getByRole('checkbox', { name: /파일 오류 시 다른 파일을 계속 처리/ })).toBeChecked();
  await expect(saveBar(page)).toHaveCount(0);
});

test('file and key rules are chips: add, remove, paste several lines, reset', async ({ page }) => {
  await settings(page);
  await tab(page, '고급').click();
  await page.getByRole('button', { name: /^파일 및 번역 키 규칙/ }).click();
  const prefixes = page.locator('#scope-component_translate_key_prefixes');
  const chips = (id: string) => page.getByRole('list', { name: id }).getByRole('listitem');
  // The defaults are shown as chips, not as a block of text.
  await expect(page.locator('#scope-region_dirs')).toBeVisible();
  await expect(page.locator('textarea#scope-region_dirs')).toHaveCount(0);
  await expect(chips('추가 리전 폴더')).toHaveCount(6);
  await expect(chips('제외할 파일 패턴')).toHaveText(['*.bak_translate']);
  // One typed entry, added with Enter.
  await prefixes.fill('quest.');
  await prefixes.press('Enter');
  await expect(chips('번역 키 접두사')).toHaveText(['quest.']);
  await expect(prefixes).toHaveValue('');
  // A pasted block adds one chip per line, trimmed, without duplicates or blanks.
  await prefixes.focus();
  await page.evaluate(() => {
    const field = document.getElementById('scope-component_translate_key_prefixes')!;
    const data = new DataTransfer();
    data.setData('text', ' npc.\r\n\r\nshop.\nquest.\n');
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(chips('번역 키 접두사')).toHaveText(['quest.', 'npc.', 'shop.']);
  // The add button, and blur, also keep what was typed.
  await prefixes.fill('extra.');
  await page.getByRole('button', { name: '추가' }).last().click();
  await expect(chips('번역 키 접두사')).toHaveCount(4);
  await prefixes.fill('blurred.');
  await page.locator('#scope-skip_patterns').focus();
  await expect(chips('번역 키 접두사')).toHaveCount(5);
  // Removing a chip.
  await page.getByRole('button', { name: 'npc. 삭제' }).click();
  await expect(chips('번역 키 접두사')).toHaveText(['quest.', 'shop.', 'extra.', 'blurred.']);
  await expect(saveBar(page)).toContainText('고급 탭에 저장하지 않은 변경 1개');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await saves(page)).length).toBe(1);
  expect((await saves(page))[0].scanOptions.component_translate_key_prefixes).toEqual(['quest.', 'shop.', 'extra.', 'blurred.']);
  expect((await saves(page))[0].scanOptions.region_dirs).toHaveLength(6);
  // The section's own default button empties them again.
  await page.getByRole('button', { name: '이 구역을 기본값으로' }).last().click();
  await expect(chips('번역 키 접두사')).toHaveCount(0);
  await expect(page.getByText('추가한 항목이 없습니다. 기본 규칙만 적용됩니다.')).toBeVisible();
});

test('every card has its own icon and one disclosure style is used everywhere', async ({ page }) => {
  await settings(page, 'scenario=review&update=available');
  const icons: string[] = [];
  let cards = 0;
  for (const name of ['번역', '스캔 범위', '고급', '앱']) {
    await tab(page, name).click();
    const panel = page.getByRole('tabpanel');
    const tiles = panel.locator('.disclosure.card > .head .icon-tile svg');
    cards += await tiles.count();
    icons.push(...await tiles.evaluateAll((nodes) => nodes.map((node) => node.innerHTML)));
  }
  // Provider, language / scan, pack, manual / speed, rules / appearance, updates, data, reset (the endpoint card shows for Custom only).
  expect(cards).toBeGreaterThanOrEqual(11);
  expect(new Set(icons).size).toBe(icons.length);
  // No second style: the native disclosure widget is not used anywhere in settings.
  expect(await page.locator('.settings details, .settings summary').count()).toBe(0);
  // The shared one: a header button with a state, controlling its panel.
  const toggles = page.locator('.settings .disclosure > .head .toggle');
  expect(await toggles.count()).toBeGreaterThan(cards);
  for (const toggle of await toggles.all()) {
    await expect(toggle).toHaveAttribute('aria-expanded', /true|false/);
    await expect(toggle).toHaveAttribute('aria-controls', /./);
  }
  // The danger zone is last on the app tab.
  await tab(page, '앱').click();
  const titles = await page.getByRole('tabpanel').locator('.disclosure.card > .head').allTextContents();
  expect(titles.at(-1)).toContain('초기화');
});

test('a disclosure opens and closes with the keyboard and keeps its content', async ({ page }) => {
  await settings(page);
  await tab(page, '고급').click();
  const toggle = page.getByRole('button', { name: /^파일 및 번역 키 규칙/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#scope-skip_patterns')).toBeHidden();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#scope-skip_patterns').fill('*.tmp');
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#scope-skip_patterns')).toBeHidden();
  // What was typed was kept (leaving the field adds it), and shows again when the card reopens.
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('list', { name: '제외할 파일 패턴' }).getByRole('listitem')).toHaveText(['*.bak_translate', '*.tmp']);
});

test('the custom provider keeps its endpoint on the advanced tab', async ({ page }) => {
  await settings(page);
  await expect(tab(page, '고급')).toBeVisible();
  await page.locator('#provider').selectOption('custom');
  await expect(page.getByText('사용자 지정 AI 서비스의 주소와 통신 규격은 고급 탭에서 설정합니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '고급 탭 열기' }).click();
  await expect(selected(page)).toHaveText('고급');
  await expect(page.locator('#base-url')).toBeVisible();
  await expect(page.locator('#base-url')).toHaveAttribute('aria-invalid', 'true');
  await expect(saveBar(page)).toContainText('고급 탭의 오류를 확인해 주세요.');
  await page.locator('#base-url').fill('https://llm.example.test/v1');
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
});

test('the translation tab checks a typed key without saving it', async ({ page }) => {
  await settings(page, 'scenario=review&missingKey=1');
  await page.locator('#provider').selectOption('openai');
  const check = page.getByRole('button', { name: '연결 확인', exact: true });
  await expect(check).toBeDisabled();
  await page.locator('#api-key').fill('bad-synthetic-key');
  await check.click();
  await expect(page.getByText('API 키가 올바르지 않거나 권한이 없습니다. 키를 다시 확인해 주세요.')).toBeVisible();
  await page.locator('#api-key').fill('good-synthetic-key');
  await expect(page.getByText('API 키가 올바르지 않거나')).toHaveCount(0);
  await check.click();
  await expect(page.getByText('연결됨 · 모델 7개')).toBeVisible();
  const lookups = (await page.evaluate(() => (window as unknown as { __pomiRequests: any[] }).__pomiRequests)).filter((request) => request.type === 'models.list' && request.connectionCheck === true);
  expect(lookups.map((request) => [request.connectionCheck, request.hasDraftKey])).toEqual([[true, true], [true, true]]);
  expect(await requests(page, 'settings.set')).toHaveLength(0);
  // A saved key is checked without sending anything typed.
  await page.getByRole('button', { name: '변경 취소', exact: true }).click();
});

for (const width of [1180, 840]) {
  test(`every tab fits ${width}px without sideways scrolling, in light and dark`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 840 ? 620 : 800 });
    await settings(page, 'scenario=review&update=available');
    for (const theme of ['light', 'dark']) {
      await page.evaluate((mode) => localStorage.setItem('pomi.theme.v1', mode), theme);
      await tab(page, '앱').click();
      await page.getByRole('radio', { name: theme === 'dark' ? '다크' : '라이트' }).check();
      for (const name of ['번역', '스캔 범위', '고급', '앱']) {
        await tab(page, name).click();
        // Open every card so the whole tab is checked.
        const closed = page.getByRole('tabpanel').locator('.disclosure > .head .toggle[aria-expanded="false"]');
        while (await closed.count()) await closed.first().click();
        expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${name} ${theme}`).toBeLessThanOrEqual(1);
        expect((await new AxeBuilder({ page }).analyze()).violations, `${name} ${theme}`).toEqual([]);
        await page.screenshot({ path: `output/playwright/settings-tab-${name === '번역' ? 'translate' : name === '스캔 범위' ? 'scope' : name === '고급' ? 'advanced' : 'app'}-${theme}-${width}.png`, fullPage: false });
      }
    }
  });
}
