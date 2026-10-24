// Run with playwright-cli run-code --filename scripts/capture-docs.playwright.js.
// Start Vite on 127.0.0.1:5199 and create docs/images/locales/{ko,en,ja,zh} first.
// The preview entry is synthetic: never read credentials or press Start translation.
async (page) => {
  const settle = async () => {
    // Park the pointer on an empty part of the toolbar so no hover colour lands in the shot.
    await page.mouse.move(1000, 26);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
    });
  };
  // Names come from the UI catalog (src/lib/i18n/{ko,en,ja,zh}.ts): nav.workspace, nav.settings, step.review, step.run,
  // settings.tab.translate, settings.advanced.title, settings.reasoning.custom, common.save. `manual` is the synthetic
  // translation of the second fixture row (tests/frontend/tauri-fixture-init.js).
  const locales = {
    ko: { workflow: '번역 작업', settings: '환경 설정', review: '번역할 문장 고르기', run: '번역 준비', tab: '번역', advanced: '고급 번역 옵션', custom: '직접 설정', save: '저장', manual: '잃어버린 열쇠 상점' },
    en: { workflow: 'Translate', settings: 'Settings', review: 'Choose Text', run: 'Prepare Translation', tab: 'Translation', advanced: 'Advanced translation options', custom: 'Custom', save: 'Save', manual: 'The Lost Key Shop' },
    ja: { workflow: '翻訳作業', settings: '設定', review: '翻訳する文を選ぶ', run: '翻訳の準備', tab: '翻訳', advanced: '翻訳の詳細オプション', custom: '指定する', save: '保存', manual: '失われた鍵の店' },
    zh: { workflow: '翻译', settings: '设置', review: '选择要翻译的文本', run: '翻译准备', tab: '翻译', advanced: '高级翻译选项', custom: '自定义', save: '保存', manual: '失落的钥匙商店' },
  };
  const externalRequests = [];
  const onRequest = (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url());
  };
  page.on('request', onRequest);
  try {
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    for (const [locale, labels] of Object.entries(locales)) {
      await page.goto(`http://127.0.0.1:5199/tests/frontend/preview.html?scenario=review&model=deepseek/deepseek-v4.1-flash&locale=${locale}&theme=light`);
      await page.locator('.boot').waitFor({ state: 'hidden' });
      if (await page.locator('html').getAttribute('lang') !== locale) throw new Error(`Wrong document language: ${locale}`);
      const steps = page.getByRole('navigation').filter({ has: page.getByRole('button', { name: new RegExp(`^${labels.review}`) }) });
      await steps.getByRole('button', { name: new RegExp(`^${labels.review}`) }).click();
      await page.locator('[data-index="1"]').click();
      await page.locator('#manual-translation').waitFor({ state: 'visible' });
      if (await page.locator('#manual-translation').inputValue() !== labels.manual) throw new Error(`Wrong manual translation: ${locale}`);
      await settle();
      await page.screenshot({ path: `docs/images/locales/${locale}/review.png` });

      await page.locator('.sidebar').getByRole('button', { name: labels.settings, exact: true }).click();
      await page.getByRole('tab', { name: labels.tab, exact: true }).click();
      const advanced = page.getByRole('button', { name: new RegExp(`^${labels.advanced}`) });
      if (await advanced.getAttribute('aria-expanded') !== 'true') await advanced.click();
      await page.getByRole('radio', { name: labels.custom, exact: true }).check();
      await page.locator('#openrouter-reasoning').selectOption('max');
      await page.locator('#translate-advanced').evaluate((element) => {
        const main = element.closest('main');
        main.scrollTop += element.getBoundingClientRect().top - main.getBoundingClientRect().top - 24;
      });
      await settle();
      await page.screenshot({ path: `docs/images/locales/${locale}/settings.png` });
      await page.getByRole('button', { name: labels.save, exact: true }).click();
      await page.locator('.sidebar').getByRole('button', { name: labels.workflow, exact: true }).click();
      await steps.getByRole('button', { name: new RegExp(`^${labels.run}`) }).click();
      // The recommended $5 cap: it is the button of the unset-cap notice, and setting it makes the whole page fit above the action bar.
      await page.getByRole('button', { name: /5\.00/ }).click();
      await page.locator('.toast').waitFor({ state: 'hidden' });
      await page.locator('main').evaluate((element) => { element.scrollTop = 0; });
      await settle();
      await page.screenshot({ path: `docs/images/locales/${locale}/run.png` });
      const requests = await page.evaluate(() => window.__pomiRequests);
      if (requests.some((request) => ['translate.start', 'scan.start', 'backup.restore'].includes(request.type))) throw new Error('Unexpected world job during documentation capture');
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`Horizontal overflow: ${locale}`);
    }
    if (externalRequests.length) throw new Error(`Unexpected external requests: ${externalRequests.join(', ')}`);
    return { locales: Object.keys(locales), screenshots: 12, externalRequests: 0, paidRequests: 0, viewport: '1440x980' };
  } finally {
    page.off('request', onRequest);
  }
}
