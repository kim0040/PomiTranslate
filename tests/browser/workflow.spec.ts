import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

// Settings is a set of tabs; these open one, and a disclosure card by its title.
async function settingsTab(page: Page, name: '번역' | '스캔 범위' | '고급' | '앱') {
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByRole('tab', { name }).click();
}
async function card(page: Page, title: RegExp) {
  const toggle = page.getByRole('button', { name: title });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}
const settingsSaves = (page: Page) => page.evaluate(() => (window as unknown as { __pomiSettingsSaves: Record<string, any>[] }).__pomiSettingsSaves);

async function review(page: Page, count = 0) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=review&count=${count}`);
  await page.getByRole('button', { name: /^번역할 문장 고르기/ }).click();
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page.locator('tr[data-index="0"]')).toBeVisible();
}

test('settings save shows pending state and blocks duplicate writes and draft edits', async ({ page }) => {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto('/?scenario=review&slowSettings=1');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.locator('#model').fill('pending-save-fixture');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.getByRole('button', { name: '저장 중…', exact: true })).toBeDisabled();
  await expect(page.locator('#model')).toBeDisabled();
  await expect(page.getByRole('button', { name: '키 변경', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '번역 작업', exact: true })).toBeDisabled();
  // Once saved there is nothing left to save: the bar is gone.
  await expect(page.locator('.save-bar')).toHaveCount(0);
  await expect(page.locator('#model')).toHaveValue('pending-save-fixture');
  await expect(page.locator('#model')).toBeEnabled();
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.locator('#model')).toHaveValue('pending-save-fixture');
});

for (const width of [1440, 840, 320]) {
test(`custom endpoint validation at ${width}px explains rejected addresses before save`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  await review(page);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.locator('#provider').selectOption('custom');
  // The endpoint of a custom provider is on the advanced tab.
  await page.getByRole('tab', { name: '고급' }).click();
  const endpoint = page.locator('#base-url');
  const save = page.getByRole('button', { name: '저장', exact: true });
  for (const address of ['https://user:pass@example.test/v1', 'https://example.test/v1?key=fake',
    'https://example.test/v1#part', 'https://example.test/v 1', 'https://example.test:99999/v1']) {
    await endpoint.fill(address);
    await expect(endpoint).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#base-url-error')).toBeVisible();
    await expect(save).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: `output/playwright/custom-endpoint-${width}.png`, fullPage: true });
  await endpoint.fill('http://127.0.0.1:52973/v1');
  await expect(endpoint).toHaveAttribute('aria-invalid', 'false');
  await expect(page.locator('#base-url-error')).toHaveCount(0);
  await expect(save).toBeEnabled();
});
}

test('resource pack locale settings validate inline and invalidate the reviewed scope', async ({ page }) => {
  await review(page);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByRole('tab', { name: '스캔 범위' }).click();
  await card(page, /^ZIP 리소스팩/);
  const enabled = page.locator('#resource-pack-settings input[type="checkbox"]').first();
  await enabled.check();
  await page.locator('#pack-target').fill('../bad.json');
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
  await page.locator('#pack-sources').fill('en_gb.json');
  await page.locator('#pack-target').fill('ja_jp.json');
  await page.getByLabel('생성할 언어 파일이 이미 있으면 해당 파일을 건너뛰기', { exact: true }).check();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '스캔 시작', exact: true })).toBeVisible();
});

test('saved manual translations keep the scan and appear in manual filtering and detail', async ({ page }) => {
  await review(page);
  await settingsTab(page, '스캔 범위');
  await card(page, /^저장형 수동 번역/);
  await page.getByRole('button', { name: '행 추가' }).click();
  await page.getByRole('textbox', { name: '원문', exact: true }).fill('Welcome to Roguefire');
  await page.getByRole('textbox', { name: '번역문', exact: true }).fill('환영합니다');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect.poll(async () => (await settingsSaves(page)).at(-1)?.sourceOverrides).toEqual({ 'Welcome to Roguefire': '환영합니다' });
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '7');
  await page.getByRole('group', { name: '상태 필터' }).getByRole('button', { name: '직접 번역', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '3');
  await page.getByText('Welcome to Roguefire', { exact: true }).first().click();
  await expect(page.locator('#manual-translation')).toHaveValue('환영합니다');
  await page.locator('#manual-translation').fill('후보별 우선 번역');
  await expect(page.locator('#manual-translation')).toHaveValue('후보별 우선 번역');
});

test('story preset preserves file rules and invalid saved translation input blocks saving', async ({ page }) => {
  await review(page);
  await settingsTab(page, '스캔 범위');
  await page.getByRole('button', { name: '스토리 중심', exact: true }).click();
  await expect(page.getByLabel('아이템 이름', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('아이템 설명 (Lore)', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '추천 범위', exact: true }).click();
  await expect(page.getByLabel('아이템 이름', { exact: true })).toBeChecked();
  // The file rules are on the advanced tab and are not touched by the presets.
  await page.getByRole('tab', { name: '고급' }).click();
  await card(page, /^파일 및 번역 키 규칙/);
  await expect(page.getByRole('list', { name: '추가 리전 폴더' }).getByRole('listitem')).toHaveCount(6);
  await page.getByRole('tab', { name: '스캔 범위' }).click();
  await card(page, /^저장형 수동 번역/);
  // An incomplete row cannot be saved; a complete one can.
  await page.getByRole('button', { name: '행 추가' }).click();
  await page.getByRole('textbox', { name: '원문', exact: true }).fill('{broken');
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '번역문', exact: true }).fill('깨진 원문');
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: '원문', exact: true }).fill('');
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: '원문', exact: true }).fill('Fixture source');
  await page.getByRole('textbox', { name: '번역문', exact: true }).fill('새 직접 번역');
  await expect(page.getByRole('button', { name: '저장', exact: true })).toBeEnabled();
});

test('filter counts follow exclusions and search', async ({ page }) => {
  await review(page);
  const first = page.locator('tr[data-index="0"]');
  await first.focus();
  await first.press('Space');
  await page.getByRole('group', { name: '상태 필터' }).getByRole('button', { name: '제외됨', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '3');
  await expect(page.locator('tr[data-index]')).toHaveCount(2);
  await page.getByRole('searchbox').fill('Welcome');
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '2');
  await expect(page.locator('tr[data-index]')).toHaveCount(1);
});

test('100k candidates stay virtual and keyboard reaches offscreen pages', async ({ page }) => {
  await review(page, 100000);
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '100001');
  expect(await page.locator('tr[data-index]').count()).toBeLessThan(50);
  await page.locator('tr[data-index="0"]').focus();
  const pageSize = await page.locator('.viewport').evaluate((element) => Math.max(1, Math.floor(element.clientHeight / 60) - 1));
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('tr[data-index="1"]')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('tr[data-index="0"]')).toBeFocused();
  await page.keyboard.press('PageDown');
  await expect(page.locator(`tr[data-index="${pageSize}"]`)).toBeFocused();
  await page.keyboard.press('PageUp');
  await expect(page.locator('tr[data-index="0"]')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('tr[data-index="99999"]')).toBeFocused();
  expect(await page.locator('tr[data-index]').count()).toBeLessThan(50);
  await page.keyboard.press('Home');
  await expect(page.locator('tr[data-index="0"]')).toBeFocused();
});

test('Enter opens candidate editing and Space toggles inclusion', async ({ page }) => {
  await review(page);
  const row = page.locator('tr[data-index="0"]');
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#manual-translation')).toBeFocused();

  await row.focus();
  await page.keyboard.press('Space');
  await expect(row.locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(row.locator('.c-state')).toContainText('제외됨');
  await page.keyboard.press('Space');
  await expect(row.locator('input[type="checkbox"]')).toBeChecked();
  await expect(row.locator('.c-state')).toContainText('번역 대상');
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 840, height: 480 }, { width: 320, height: 568 }, { width: 2560, height: 1080 }]) {
  test(`review reflows at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await review(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await page.getByRole('searchbox').fill('keeper');
    await expect(page.locator('tr[data-index]')).toHaveCount(1);
    const sourceWidth = await page.locator('td.c-source').first().evaluate((element) => element.getBoundingClientRect().width);
    expect(sourceWidth).toBeGreaterThan(120);
    await expect(page.getByRole('button', { name: '번역 준비 단계로 이동' })).toBeVisible();
    await page.screenshot({ path: `output/playwright/review-${viewport.width}x${viewport.height}.png`, fullPage: true });
  });
}

test('manual draft survives desktop to narrow dialog resize', async ({ page }) => {
  await review(page);
  await page.locator('tr[data-index="0"]').click();
  const editor = page.locator('#manual-translation');
  await editor.fill('로그파이어에 오신 것을 환영합니다');
  await editor.focus();
  // Narrow enough that the list area has no room for the side panel.
  await page.setViewportSize({ width: 700, height: 480 });
  await expect(editor).toBeFocused();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(editor).toHaveValue('로그파이어에 오신 것을 환영합니다');
  const bounds = await page.getByRole('dialog').boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(700);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(480);
  const close = page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).last();
  await close.scrollIntoViewIfNeeded();
  await expect(close).toBeInViewport();
  await editor.focus();
  expect(await editor.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(200);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('로그파이어에 오신 것을 환영합니다');
  await page.getByRole('group', { name: '상태 필터' }).getByRole('button', { name: '직접 번역', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '3');
  await expect(page.locator('tr[data-index]')).toHaveCount(2);
});

test('credential modes and explicit import never reveal a stored key', async ({ page }) => {
  await review(page);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await card(page, /^키 관리 및 보안/);
  await expect(page.locator('#credential-mode')).toHaveValue('local');
  await expect(page.locator('#api-key')).toHaveCount(0);
  await page.locator('#credential-mode').selectOption('session');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('#credential-mode')).toHaveValue('session');
  await page.getByRole('button', { name: '기존 키체인 키 가져오기' }).click();
  await expect(page.locator('#credential-mode')).toHaveValue('local');
  await expect(page.locator('#api-key')).toHaveCount(0);
});

test('model preserves scan; target language invalidates it', async ({ page }) => {
  await review(page);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByLabel('사용 모델', { exact: true }).fill('another-model');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  // Saved settings leave without a question.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '7');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.locator('#target-language').selectOption('日本語');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^번역할 문장 찾기.*진행 중/ })).toBeVisible();
});


test('kind filters are available immediately after loading a preview', async ({ page }) => {
  await review(page);
  const kinds = page.getByRole('group', { name: '텍스트 유형' });
  await kinds.getByRole('button', { name: /^표지판/ }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '2');
  await expect(page.locator('tr[data-index]')).toHaveCount(1);
});

test('changing a text category invalidates the reviewed scan', async ({ page }) => {
  await review(page);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByRole('tab', { name: '스캔 범위' }).click();
  await page.getByLabel('표지판', { exact: true }).uncheck();
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '스캔 시작', exact: true })).toBeVisible();
});

test('settings export omits credentials and reset remains an unsaved draft', async ({ page }) => {
  await review(page);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByLabel('사용 모델', { exact: true }).fill('synthetic-draft-model');
  await page.getByRole('button', { name: '키 변경', exact: true }).click();
  await page.locator('#api-key').fill('synthetic-secret-never-export');
  await page.getByRole('tab', { name: '고급' }).click();
  await card(page, /^설정 가져오기·내보내기/);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '설정 내보내기', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('pomi-settings.json');
  const contents = await readFile((await download.path())!, 'utf8');
  expect(contents).not.toMatch(/synthetic-secret|apiKey|api_key|masterKey|credentialMode/);
  expect(JSON.parse(contents).settings.model).toBe('synthetic-draft-model');
  await page.getByRole('button', { name: '초기값으로 편집', exact: true }).click();
  await expect(page.locator('#api-key')).toHaveCount(0);
  await expect(page.getByLabel('사용 모델', { exact: true })).not.toHaveValue('synthetic-draft-model');
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  // Leaving asks first; dropping the draft must leave the saved settings untouched.
  await page.getByRole('dialog').getByRole('button', { name: '저장하지 않고 이동', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '7');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.getByLabel('사용 모델', { exact: true })).toHaveValue('xiaomi/mimo-v2.6-flash');
});

test('style helper confirms provider transmission and edits only the unsaved prompt draft', async ({ page }) => {
  await review(page);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByText('번역 지시문 다듬기', { exact: true }).click();
  await page.getByLabel('원하는 분위기와 문체 메모').fill('중세 판타지, 짧은 문장');
  await page.getByRole('button', { name: 'AI로 지시문 다듬기', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('API 사용료가 발생할 수');
  await page.getByRole('dialog').getByRole('button', { name: 'AI로 지시문 다듬기', exact: true }).click();
  await expect(page.locator('#style-prompt')).toHaveValue('중세 판타지 분위기에 맞추어 짧고 자연스럽게 번역하세요.');
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  // Leaving asks first; dropping the draft must leave the saved settings untouched.
  await page.getByRole('dialog').getByRole('button', { name: '저장하지 않고 이동', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '7');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.locator('#style-prompt')).toHaveValue('');
});

test('legacy settings import omits keys, preserves the world and stays a draft', async ({ page }) => {
  await review(page);
  await settingsTab(page, '고급');
  await page.locator('#settings-management input[type="file"]').setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    world_dir: '/private/tmp/should-not-be-selected', api: { provider: 'openrouter', model: 'imported-model', api_key: 'synthetic-import-secret' },
    prompt: { target_language: '한국어', style_preset: 'story' }, batch_size: 64
  })) });
  await expect(page.getByLabel('사용 모델', { exact: true })).toHaveValue('imported-model');
  await expect(page.locator('#api-key')).toHaveCount(0);
  await expect(page.getByText('설정을 편집 화면에 불러왔습니다. 확인한 뒤 저장해 주세요. API 키는 가져오지 않았습니다.', { exact: true })).toBeVisible();
  await page.locator('#settings-management input[type="file"]').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(page.getByText(/설정을 가져올 수 없습니다/)).toBeVisible();
  await expect(page.getByLabel('사용 모델', { exact: true })).toHaveValue('imported-model');
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  // Leaving asks first; dropping the draft must leave the saved settings untouched.
  await page.getByRole('dialog').getByRole('button', { name: '저장하지 않고 이동', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '7');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.getByLabel('사용 모델', { exact: true })).toHaveValue('xiaomi/mimo-v2.6-flash');
});


test('literal Python settings import uses a preview and remains unsaved on failure', async ({ page }) => {
  await review(page);
  await settingsTab(page, '고급');
  const source = 'API_KEY = "synthetic-secret"\nBASE_URL = "https://legacy.example/v1"\nMODEL = "literal-model"\nSYSTEM_PROMPT = "Preserve formatting"';
  await page.locator('#settings-management input[type="file"]').setInputFiles({ name: 'translate.py', mimeType: 'text/x-python', buffer: Buffer.from(source) });
  await expect(page.getByLabel('사용 모델', { exact: true })).toHaveValue('literal-model');
  await page.screenshot({ path: 'output/playwright/settings-python-import.png', fullPage: true });
  await expect(page.locator('#api-key')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('synthetic-secret');
  await page.locator('#settings-management input[type="file"]').setInputFiles({ name: 'invalid.py', mimeType: 'text/x-python', buffer: Buffer.from('invalid Python import') });
  await expect(page.getByText(/설정을 가져올 수 없습니다/)).toBeVisible();
  await expect(page.getByLabel('사용 모델', { exact: true })).toHaveValue('literal-model');
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  // Leaving asks first; dropping the draft must leave the saved settings untouched.
  await page.getByRole('dialog').getByRole('button', { name: '저장하지 않고 이동', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '7');
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await expect(page.getByLabel('사용 모델', { exact: true })).toHaveValue('xiaomi/mimo-v2.6-flash');
});

test('Comet selection pins the public route and preserves reviewed scan', async ({ page }) => {
  await review(page);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  await page.getByLabel('AI 서비스 선택', { exact: true }).selectOption('comet');
  await page.getByLabel('사용 모델', { exact: true }).fill('comet-fixture');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('button', { name: '번역 작업', exact: true }).click();
  await expect(page.getByRole('grid')).toHaveAttribute('aria-rowcount', '7');
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await expect(page.locator('main')).toContainText('Comet API');
});


for (const width of [1440, 840, 320]) {
  test(`resource pack controls are usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 620 });
    await review(page);
    await page.getByRole('button', { name: '환경 설정', exact: true }).click();
    await page.getByRole('tab', { name: '스캔 범위' }).click();
    await card(page, /^ZIP 리소스팩/);
    await page.locator('#resource-pack-settings input[type="checkbox"]').first().check();
    const target = page.locator('#pack-target');
    await target.fill('ja_jp.json');
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeVisible();
    expect(await target.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(180);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `output/playwright/settings-pack-${width}.png`, fullPage: true });
  });
}

for (const width of [1440, 840, 320]) {
  test(`explicit external ZIP selection remains accessible and invalidates review at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 620 });
    await review(page);
    await page.getByRole('button', { name: '환경 설정', exact: true }).click();
    await page.getByRole('tab', { name: '스캔 범위' }).click();
    await card(page, /^ZIP 리소스팩/);
    await page.locator('#resource-pack-settings input[type="checkbox"]').first().check();
    const path = '/private/tmp/pomi-eval/' + 'very-long-resource-pack-folder/'.repeat(6) + '선택한 리소스팩.zip';
    await page.evaluate((chosen) => {
      (window as typeof window & { __pomiDialogFiles?: string[] }).__pomiDialogFiles = [chosen];
    }, path);
    await page.getByRole('button', { name: 'ZIP 파일 선택', exact: true }).click();
    const packs = page.locator('section.external-packs');
    await expect(packs).toContainText(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `output/playwright/settings-external-pack-selected-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByRole('button', { name: '번역 작업', exact: true }).click();
    await expect(page.getByRole('button', { name: '스캔 시작', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '환경 설정', exact: true }).click();
    await page.getByRole('tab', { name: '스캔 범위' }).click();
    await expect(page.locator('section.external-packs')).toContainText(path);
    await page.getByRole('button', { name: `외부 팩 선택 해제: ${path}`, exact: true }).click();
    await expect(page.locator('section.external-packs')).toContainText('선택한 외부 ZIP이 없습니다.');
    await page.screenshot({ path: `output/playwright/settings-external-pack-${width}.png`, fullPage: true });
  });
}


test('OpenRouter usage reads stored credentials without saving drafts or translating', async ({ page }) => {
  await review(page);
  await page.getByRole('button', { name: '환경 설정', exact: true }).click();
  const button = page.getByRole('button', { name: 'OpenRouter 사용량 확인', exact: true });
  await expect(button).toBeEnabled();
  await page.locator('#model').fill('unsaved-model');
  await button.click();
  await expect(page.getByText(/누적 사용 크레딧: 0.123456/)).toBeVisible();
  await expect(page.locator('#model')).toHaveValue('unsaved-model');
  await page.getByRole('button', { name: '키 변경', exact: true }).click();
  await page.locator('#api-key').fill('fake-unsaved-key');
  await expect(button).toBeDisabled();
  await page.locator('#api-key').fill('');
  await page.locator('#provider').selectOption('custom');
  await expect(button).toHaveCount(0);
});
