import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

type Request = { type: string; provider?: string; connectionCheck?: boolean; hasDraftKey?: boolean; draftKeyLength?: number; hasApiKey?: boolean; apiKeyLength?: number };

async function firstRun(page: Page, extra = '') {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?scenario=first-run&fresh=1${extra}`);
}
const requests = (page: Page, type: string) =>
  page.evaluate((kind) => (window as unknown as { __pomiRequests: Request[] }).__pomiRequests.filter((request) => request.type === kind), type);
const prefs = (page: Page) => page.evaluate(() => (window as unknown as { __pomiPrefs?: Record<string, unknown> }).__pomiPrefs ?? {});
const wizard = (page: Page) => page.getByRole('dialog');
const axe = async (page: Page) => expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

async function toKeyStep(page: Page) {
  await wizard(page).getByRole('button', { name: '확인하고 시작하기' }).click();
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await expect(wizard(page)).toHaveAccessibleName('API 키');
}

test('the first run opens the wizard with the legal notice, which must be accepted', async ({ page }) => {
  await firstRun(page);
  await expect(wizard(page)).toHaveAccessibleName('환영합니다');
  // The notice text is the same as before the wizard existed.
  await expect(wizard(page)).toContainText('월드 파일을 직접 수정하는 도구입니다. 실행 시 자동 백업을 생성하지만');
  await expect(wizard(page)).toContainText('번역할 텍스트는 선택하신 AI 제공사로 전송되며');
  await expect(wizard(page)).toContainText('Mojang Studios 및 Microsoft와 관련 없는 비공식 오픈소스 프로젝트입니다.');
  await expect(wizard(page)).toContainText('NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.');
  await axe(page);
  // The notice cannot be skipped: no "later", no close button, and Escape does nothing.
  await expect(wizard(page).getByRole('button', { name: '나중에' })).toHaveCount(0);
  await expect(wizard(page).getByRole('button', { name: '닫기' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(wizard(page)).toBeVisible();
  expect(await prefs(page)).toEqual({});
  await wizard(page).getByRole('button', { name: '확인하고 시작하기' }).click();
  // Accepting records the same pref as the old notice did, and nothing else yet.
  expect(await prefs(page)).toEqual({ notice_accepted: true });
  await expect(wizard(page)).toHaveAccessibleName('AI 제공사 선택');
  await page.screenshot({ path: 'output/playwright/setup-wizard-1-provider.png' });
});

test('the full path: draft key checked on paste, model prefilled, saved once, lands on the world step', async ({ page }) => {
  await firstRun(page);
  await wizard(page).getByRole('button', { name: '확인하고 시작하기' }).click();

  // Provider: OpenRouter is recommended and preselected; every card has its key page.
  await expect(wizard(page).getByRole('radio', { name: /OpenRouter/ })).toBeChecked();
  await expect(wizard(page)).toContainText('추천 — 키 하나로 여러 모델, 가격 표시');
  for (const name of ['OpenRouter', 'Google Gemini', 'OpenAI', 'Anthropic', 'Comet API']) {
    await expect(wizard(page).getByRole('radio', { name: new RegExp(name) })).toBeVisible();
  }
  await expect(wizard(page).getByRole('radio', { name: /직접 지정|사용자 지정/ })).toBeHidden();
  await wizard(page).getByRole('button', { name: '키 발급 페이지 열기' }).first().click();
  expect(await page.evaluate(() => (window as unknown as { __pomiOpened: string[] }).__pomiOpened)).toEqual(['https://openrouter.ai/settings/keys']);
  await axe(page);
  await wizard(page).getByRole('button', { name: /^다음/ }).click();

  // Key: pasted text is checked at once, with the typed key, before anything is saved.
  await expect(wizard(page)).toHaveAccessibleName('API 키');
  await expect(page.locator('#setup-api-key')).toBeFocused();
  await expect(wizard(page).getByRole('button', { name: /^다음/ })).toBeDisabled();
  await page.locator('#setup-api-key').fill('sk-or-fixture-good-key');
  await page.locator('#setup-api-key').blur();
  await expect(wizard(page).getByRole('status').filter({ hasText: '연결됨 · 모델 7개' })).toBeVisible();
  const lookups = (await requests(page, 'models.list')).filter((request) => request.hasDraftKey);
  expect(lookups).toEqual([expect.objectContaining({ provider: 'openrouter', connectionCheck: true, draftKeyLength: 22 })]);
  expect(await requests(page, 'settings.set')).toHaveLength(0);
  await expect(wizard(page)).toContainText('현재 저장 방식: 로컬 암호화 저장 (기본)');
  await expect(wizard(page).getByRole('button', { name: /저장 방식 자세히 보기/ })).toBeVisible();
  await axe(page);
  await wizard(page).getByRole('button', { name: /^다음/ }).click();

  // Model: the cheapest fast text model is chosen, with its price; unsuitable models are hidden.
  await expect(wizard(page)).toHaveAccessibleName('모델 선택');
  await expect(page.locator('#setup-model')).toHaveValue('google/gemini-2.5-flash-lite');
  await expect(wizard(page).getByText('추천', { exact: true })).toBeVisible();
  await expect(wizard(page).getByRole('option').first()).toContainText('Gemini 2.5 Flash Lite');
  await expect(wizard(page).getByRole('option').first()).toContainText('US$0.10 / US$0.40');
  await expect(wizard(page).getByRole('option').first()).toContainText('1M');
  await expect(wizard(page)).toContainText('100만 토큰당 단가: 입력 US$0.10 · 출력 US$0.40');
  await expect(wizard(page)).toContainText('번역에 맞지 않는 모델 3개 숨김');
  await expect(wizard(page).getByRole('option', { name: /Whisper/ })).toHaveCount(0);
  await wizard(page).getByRole('option', { name: /Claude Haiku 4.5/ }).click();
  await expect(page.locator('#setup-model')).toHaveValue('anthropic/claude-haiku-4.5');
  await expect(wizard(page)).toContainText('100만 토큰당 단가: 입력 US$1.00 · 출력 US$5.00');
  await axe(page);
  await wizard(page).getByRole('button', { name: /^다음/ }).click();

  // Language and style, then one save.
  await expect(wizard(page)).toHaveAccessibleName('번역 언어와 문체');
  await page.locator('#setup-language').selectOption('English');
  await page.locator('#setup-style').selectOption('polite');
  await expect(wizard(page)).toContainText('anthropic/claude-haiku-4.5');
  await axe(page);
  expect(await requests(page, 'settings.set')).toHaveLength(0);
  await wizard(page).getByRole('button', { name: '설정 저장하고 끝내기' }).click();
  await expect(wizard(page)).toHaveAccessibleName('준비가 끝났습니다');
  const saves = await requests(page, 'settings.set');
  expect(saves).toEqual([expect.objectContaining({ provider: 'openrouter', hasApiKey: true, apiKeyLength: 22 })]);
  const saved = await page.evaluate(() => (window as unknown as { __pomiSettingsSaves: Record<string, unknown>[] }).__pomiSettingsSaves);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5', targetLanguage: 'English', stylePreset: 'polite' });
  expect(JSON.stringify(saved)).not.toContain('sk-or-fixture-good-key');
  await expect(wizard(page)).toContainText('OpenRouter · anthropic/claude-haiku-4.5');
  await axe(page);
  await page.screenshot({ path: 'output/playwright/setup-wizard-done.png' });
  await wizard(page).getByRole('button', { name: '월드 고르기' }).click();
  await expect(wizard(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: '번역할 월드를 선택해 주세요' })).toBeVisible();
  expect(await prefs(page)).toMatchObject({ notice_accepted: true, setup_dismissed: true, tutorial_seen: true });
  // A finished setup means nothing is missing any more.
  await expect(page.locator('.callout').filter({ hasText: 'AI 번역 설정이 아직 남아 있습니다' })).toHaveCount(0);
});

test('finishing can open the tour', async ({ page }) => {
  await firstRun(page);
  await toKeyStep(page);
  await page.locator('#setup-api-key').fill('sk-or-fixture-good-key');
  await page.locator('#setup-api-key').blur();
  await expect(wizard(page)).toContainText('연결됨');
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await wizard(page).getByRole('button', { name: '설정 저장하고 끝내기' }).click();
  await wizard(page).getByRole('button', { name: '사용 방법 둘러보기' }).click();
  await expect(wizard(page)).toHaveAccessibleName('시작 안내');
  await expect(page.getByRole('heading', { level: 3, name: 'PomiTranslate에 오신 것을 환영합니다' })).toBeVisible();
});

test('a wrong key is explained and blocks the next step; other failures can be passed', async ({ page }) => {
  await firstRun(page);
  await toKeyStep(page);
  const input = page.locator('#setup-api-key');
  const status = wizard(page).getByRole('status');
  const next = wizard(page).getByRole('button', { name: /^다음/ });
  const cases: { key: string; message: string; blocks: boolean }[] = [
    { key: 'bad-key-value', message: 'API 키가 올바르지 않거나 권한이 없습니다. 키를 다시 확인해 주세요.', blocks: true },
    { key: 'offline-key-value', message: '네트워크에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.', blocks: false },
    { key: 'timeout-key-value', message: '제공사가 제한 시간 안에 응답하지 않았습니다. 다시 시도해 주세요.', blocks: false },
    { key: 'down-key-value', message: '제공사 서버에서 오류가 발생했습니다. 잠시 뒤에 다시 시도해 주세요.', blocks: false },
    { key: 'nocredit-key-value', message: '크레딧이나 결제 한도가 부족합니다. 제공사 계정을 확인해 주세요.', blocks: false },
    { key: 'rate-key-value', message: '요청이 너무 많습니다. 잠시 뒤에 다시 시도해 주세요.', blocks: false }
  ];
  for (const { key, message, blocks } of cases) {
    await input.fill(key);
    await input.blur();
    await expect(status).toContainText(message);
    if (blocks) await expect(next).toBeDisabled(); else await expect(next).toBeEnabled();
  }
  // Every failure was a draft-key check; none of them saved anything.
  expect((await requests(page, 'models.list')).filter((request) => request.hasDraftKey)).toHaveLength(cases.length);
  expect(await requests(page, 'settings.set')).toHaveLength(0);
  await input.fill('bad-key-again');
  await input.blur();
  await expect(status).toContainText('API 키가 올바르지 않거나');
  await axe(page);
  await page.screenshot({ path: 'output/playwright/setup-wizard-key-error.png' });
  // The key can be fixed, and the same field then connects.
  await input.fill('sk-or-fixture-good-key');
  await input.blur();
  await expect(status).toContainText('연결됨 · 모델 7개');
  await expect(next).toBeEnabled();
  // Pasting also checks at once, without leaving the field.
  await input.fill('');
  await input.focus();
  await page.evaluate(() => {
    const field = document.getElementById('setup-api-key') as HTMLInputElement;
    field.value = 'sk-or-pasted-key-value';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true }));
  });
  await expect(status).toContainText('연결됨 · 모델 7개');
  await expect(input).toBeFocused();
});

test('the key can be shown or hidden, and the storage note links to settings', async ({ page }) => {
  await firstRun(page);
  await toKeyStep(page);
  const input = page.locator('#setup-api-key');
  await input.fill('sk-visible-check');
  await expect(input).toHaveAttribute('type', 'password');
  await wizard(page).getByRole('button', { name: '키 표시' }).click();
  await expect(input).toHaveAttribute('type', 'text');
  await wizard(page).getByRole('button', { name: '키 숨기기' }).click();
  await expect(input).toHaveAttribute('type', 'password');
  await wizard(page).getByRole('button', { name: /저장 방식 자세히 보기/ }).click();
  await expect(wizard(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: '환경 설정' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '번역', selected: true })).toBeVisible();
  // Nothing typed was kept, and the wizard was not marked as put off.
  expect(await requests(page, 'settings.set')).toHaveLength(0);
  expect((await prefs(page)).setup_dismissed).toBeUndefined();
});

test('"later" closes the wizard without saving, and the tour follows on a first run', async ({ page }) => {
  await firstRun(page);
  await toKeyStep(page);
  await page.locator('#setup-api-key').fill('sk-or-fixture-good-key');
  await page.locator('#setup-api-key').blur();
  await expect(wizard(page)).toContainText('연결됨');
  await wizard(page).getByRole('button', { name: '나중에' }).click();
  expect(await requests(page, 'settings.set')).toHaveLength(0);
  expect(await prefs(page)).toMatchObject({ notice_accepted: true, setup_dismissed: true });
  // The tour that the first run would have shown comes next.
  await expect(wizard(page)).toHaveAccessibleName('시작 안내');
  await wizard(page).getByRole('button', { name: '건너뛰기' }).click();
  await expect(wizard(page)).toHaveCount(0);
  // The plain notices still say what is missing, and the wizard can be opened from there.
  await expect(page.locator('.callout').filter({ hasText: 'AI 번역 설정이 아직 남아 있습니다' })).toBeVisible();
  await page.locator('.callout').getByRole('button', { name: '설정 도우미 열기' }).click();
  await expect(wizard(page)).toHaveAccessibleName('환영합니다');
});

test('Escape is "later" once the notice is accepted, and back keeps what was chosen', async ({ page }) => {
  await firstRun(page);
  await wizard(page).getByRole('button', { name: '확인하고 시작하기' }).click();
  await wizard(page).getByRole('radio', { name: /Google Gemini/ }).check();
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await wizard(page).getByRole('button', { name: /뒤로/ }).click();
  await expect(wizard(page).getByRole('radio', { name: /Google Gemini/ })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'AI 제공사 선택' })).toHaveCount(0);
  expect(await prefs(page)).toMatchObject({ notice_accepted: true, setup_dismissed: true });
});

test('a provider change drops the typed key and the check', async ({ page }) => {
  await firstRun(page);
  await toKeyStep(page);
  await page.locator('#setup-api-key').fill('sk-or-fixture-good-key');
  await page.locator('#setup-api-key').blur();
  await expect(wizard(page)).toContainText('연결됨');
  await wizard(page).getByRole('button', { name: /뒤로/ }).click();
  await wizard(page).getByRole('radio', { name: /OpenAI/ }).check();
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await expect(page.locator('#setup-api-key')).toHaveValue('');
  await expect(wizard(page)).not.toContainText('연결됨');
  await expect(wizard(page).getByRole('button', { name: /^다음/ })).toBeDisabled();
});

test('a custom endpoint sits under Advanced and needs a valid address', async ({ page }) => {
  await firstRun(page);
  await wizard(page).getByRole('button', { name: '확인하고 시작하기' }).click();
  await wizard(page).getByRole('button', { name: /고급: 직접 지정/ }).click();
  await wizard(page).getByRole('radio', { name: /사용자 지정 엔드포인트/ }).check();
  const next = wizard(page).getByRole('button', { name: /^다음/ });
  await expect(next).toBeDisabled();
  await page.locator('#setup-base-url').fill('not a url');
  await expect(wizard(page).getByRole('alert')).toContainText('HTTP(S) 주소를 입력해 주세요');
  await expect(next).toBeDisabled();
  await page.locator('#setup-base-url').fill('https://llm.example.test/v1');
  await expect(next).toBeEnabled();
  await axe(page);
  await next.click();
  await page.locator('#setup-api-key').fill('custom-fixture-key');
  await page.locator('#setup-api-key').blur();
  await expect(wizard(page)).toContainText('연결됨');
  const lookups = (await requests(page, 'models.list')).filter((request) => request.hasDraftKey);
  expect(lookups.map((request) => request.provider)).toEqual(['custom']);
});

test('the wizard can be opened again from Help, and shows the notice as already accepted', async ({ page }) => {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto('/?scenario=review');
  await expect(wizard(page)).toHaveCount(0);
  await page.getByRole('button', { name: '도움말', exact: true }).click();
  await page.getByRole('button', { name: '설정 도우미 열기' }).click();
  await expect(wizard(page)).toHaveAccessibleName('환영합니다');
  await expect(wizard(page).getByRole('button', { name: '확인하고 시작하기' })).toHaveCount(0);
  // A configured install keeps its provider, model and stored key.
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await expect(wizard(page).getByRole('radio', { name: /OpenRouter/ })).toBeChecked();
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await expect(wizard(page)).toContainText('이 제공사의 API 키가 이미 저장되어 있습니다');
  await expect(wizard(page).getByRole('button', { name: /^다음/ })).toBeEnabled();
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await expect(page.locator('#setup-model')).toHaveValue('xiaomi/mimo-v2.6-flash');
  await expect(wizard(page).getByRole('option', { name: /Gemini 2.5 Flash Lite/ })).toBeVisible();
  expect((await requests(page, 'models.list')).filter((request) => request.hasDraftKey)).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(wizard(page)).toHaveCount(0);
  // The tour button is still there beside it.
  await expect(page.getByRole('button', { name: '시작 안내 다시 보기' })).toBeVisible();
});

test('a failed save is explained inside the wizard and can be retried', async ({ page }) => {
  await firstRun(page, '&saveFails=1');
  await toKeyStep(page);
  await page.locator('#setup-api-key').fill('sk-or-fixture-good-key');
  await page.locator('#setup-api-key').blur();
  await expect(wizard(page)).toContainText('연결됨');
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await wizard(page).getByRole('button', { name: '설정 저장하고 끝내기' }).click();
  await expect(wizard(page).getByRole('alert')).toContainText('설정을 저장하지 못했습니다');
  await expect(wizard(page)).toHaveAccessibleName('번역 언어와 문체');
  await expect(wizard(page).getByRole('button', { name: '설정 저장하고 끝내기' })).toBeEnabled();
});

for (const [width, height] of [[1180, 800], [840, 620]]) {
  test(`every step fits ${width}x${height} without sideways scrolling`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await firstRun(page);
    const fits = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      expect(await wizard(page).evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      const box = await wizard(page).boundingBox();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    };
    await fits();
    await wizard(page).getByRole('button', { name: '확인하고 시작하기' }).click();
    await fits();
    await wizard(page).getByRole('button', { name: /^다음/ }).click();
    await fits();
    await page.locator('#setup-api-key').fill('sk-or-fixture-good-key');
    await page.locator('#setup-api-key').blur();
    await expect(wizard(page)).toContainText('연결됨');
    await fits();
    await wizard(page).getByRole('button', { name: /^다음/ }).click();
    await fits();
    // The footer buttons stay reachable even when the model list is long.
    await expect(wizard(page).getByRole('button', { name: /^다음/ })).toBeInViewport();
    await wizard(page).getByRole('button', { name: /^다음/ }).click();
    await fits();
    await wizard(page).getByRole('button', { name: '설정 저장하고 끝내기' }).click();
    await expect(wizard(page)).toHaveAccessibleName('준비가 끝났습니다');
    await fits();
    await page.screenshot({ path: `output/playwright/setup-wizard-${width}.png` });
  });
}

for (const [locale, titles] of [['en', ['Welcome', 'Choose an AI provider', 'API key']], ['ja', ['ようこそ', 'AIプロバイダーを選ぶ', 'APIキー']]] as const) {
  test(`the wizard is complete in ${locale}`, async ({ page }) => {
    await firstRun(page, `&locale=${locale}`);
    await expect(wizard(page)).toHaveAccessibleName(titles[0]);
    await expect(wizard(page)).toContainText('NOT AN OFFICIAL MINECRAFT PRODUCT');
    await wizard(page).getByRole('button').last().click();
    await expect(wizard(page)).toHaveAccessibleName(titles[1]);
    await wizard(page).getByRole('button').last().click();
    await expect(wizard(page)).toHaveAccessibleName(titles[2]);
    await axe(page);
  });
}

test('the wizard passes contrast and axe checks in dark mode', async ({ page }) => {
  await firstRun(page, '&theme=dark');
  await axe(page);
  await wizard(page).getByRole('button', { name: '확인하고 시작하기' }).click();
  await axe(page);
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await page.locator('#setup-api-key').fill('bad-key-value');
  await page.locator('#setup-api-key').blur();
  await expect(wizard(page)).toContainText('API 키가 올바르지 않거나');
  await axe(page);
  await page.screenshot({ path: 'output/playwright/setup-wizard-dark.png' });
});

test('the visible connection button retries a transient failure for the same key', async ({ page }) => {
  await firstRun(page);
  await toKeyStep(page);
  const input = page.locator('#setup-api-key');
  await input.fill('offline-key-value');
  await input.blur();
  await expect(wizard(page)).toContainText('네트워크에 연결하지 못했습니다');
  const before = await requests(page, 'models.list');

  await wizard(page).getByRole('button', { name: '연결 확인', exact: true }).click();

  await expect(wizard(page)).toContainText('연결됨 · 모델 7개');
  expect(await requests(page, 'models.list')).toHaveLength(before.length + 1);
});

test('custom endpoint changes reset the connection result and use the new identity', async ({ page }) => {
  await firstRun(page);
  await wizard(page).getByRole('button', { name: '확인하고 시작하기' }).click();
  await wizard(page).getByRole('button', { name: /고급: 직접 지정/ }).click();
  await wizard(page).getByRole('radio', { name: /사용자 지정 엔드포인트/ }).check();
  await page.locator('#setup-base-url').fill('https://one.example.test/v1');
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  const input = page.locator('#setup-api-key');
  await input.fill('custom-fixture-key');
  await input.blur();
  await expect(wizard(page)).toContainText('연결됨');
  const firstLookupCount = (await requests(page, 'models.list')).length;

  await wizard(page).getByRole('button', { name: /뒤로/ }).click();
  await page.locator('#setup-base-url').fill('https://two.example.test/v1');
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await expect(wizard(page)).not.toContainText('연결됨');
  await wizard(page).getByRole('button', { name: '연결 확인', exact: true }).click();

  await expect(wizard(page)).toContainText('연결됨');
  const lookups = await requests(page, 'models.list');
  expect(lookups).toHaveLength(firstLookupCount + 1);
  expect(lookups.at(-1)).toMatchObject({ provider: 'custom', baseUrl: 'https://two.example.test/v1', wireFormat: 'openai' });
});

test('a native close request keeps the wizard draft in place and offers wizard choices', async ({ page }) => {
  await firstRun(page);
  await toKeyStep(page);
  await page.locator('#setup-api-key').fill('synthetic-close-draft');
  await expect.poll(() => page.evaluate(() => (window as any).__pomiUnsavedSettings)).toBe(true);

  const requestClose = () => page.evaluate(() => (window as any).__pomiEmit('pomi-close-requested', 'window'));
  await requestClose();
  let closeDialog = page.getByRole('dialog', { name: '설정 마법사 내용을 어떻게 할까요?' });
  await expect(closeDialog).toBeVisible();
  await expect(closeDialog.locator('.close')).toHaveCount(0);
  await expect(closeDialog.getByRole('button', { name: '저장하고 닫기', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: '환경 설정' })).toHaveCount(0);
  await closeDialog.getByRole('button', { name: '설정 계속하기', exact: true }).click();
  await expect(page.locator('#setup-api-key')).toHaveValue('synthetic-close-draft');

  await requestClose();
  closeDialog = page.getByRole('dialog', { name: '설정 마법사 내용을 어떻게 할까요?' });
  await closeDialog.getByRole('button', { name: '버리고 닫기', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await requests(page, 'settings.set')).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__pomiNativeCalls.some((call: any) => call.command === 'finish_close' && call.args.source === 'window'))).toBe(true);
});

test('the wizard saves a valid setup before completing a native close request', async ({ page }) => {
  await firstRun(page);
  await wizard(page).getByRole('button', { name: '확인하고 시작하기' }).click();
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await page.locator('#setup-api-key').fill('sk-or-fixture-good-key');
  await page.locator('#setup-api-key').blur();
  await expect(wizard(page)).toContainText('연결됨');
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await wizard(page).getByRole('button', { name: /^다음/ }).click();
  await page.evaluate(() => (window as any).__pomiEmit('pomi-close-requested', 'quit'));
  const closeDialog = page.getByRole('dialog', { name: '설정 마법사 내용을 어떻게 할까요?' });
  await expect(closeDialog.getByRole('button', { name: '저장하고 닫기', exact: true })).toBeVisible();
  await closeDialog.getByRole('button', { name: '저장하고 닫기', exact: true }).click();

  await expect.poll(() => page.evaluate(() => (window as any).__pomiNativeCalls.some((call: any) => call.command === 'finish_close' && call.args.source === 'quit'))).toBe(true);
  const saves = await page.evaluate(() => (window as any).__pomiSettingsSaves);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ provider: 'openrouter', model: 'google/gemini-2.5-flash-lite', credentialMode: 'local' });
  expect(saves[0]).not.toHaveProperty('apiKey');
});

test('reopened setup explains the active Session and OS keychain storage modes', async ({ page }) => {
  for (const [mode, label] of [['session', '이번 실행에서만 사용'], ['keychain', 'OS 키체인']] as const) {
    await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
    await page.goto(`/?scenario=review&credentialMode=${mode}`);
    await page.getByRole('button', { name: '도움말', exact: true }).click();
    await page.getByRole('button', { name: '설정 도우미 열기' }).click();
    await wizard(page).getByRole('button', { name: /^다음/ }).click();
    await wizard(page).getByRole('button', { name: /^다음/ }).click();
    await expect(wizard(page)).toHaveAccessibleName('API 키');
    await expect(wizard(page)).toContainText(`현재 저장 방식: ${label}`);
    await wizard(page).getByRole('button', { name: /^뒤로/ }).click();
    await wizard(page).getByRole('button', { name: '나중에' }).click();
  }
});
