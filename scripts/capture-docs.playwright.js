// Run with playwright-cli run-code --filename scripts/capture-docs.playwright.js.
// Start Vite on 127.0.0.1:5199 and create docs/images/locales/{ko,en,ja,zh} first.
// The preview entry is synthetic: never read credentials or press Start translation.
async (page) => {
  const settle = async () => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
    });
  };
  const locales = {
    ko: { review: '후보 검토', settings: '환경 설정', workflow: '번역 작업', run: '번역 진행', custom: '직접 설정', save: '저장', manual: '잃어버린 열쇠 상점' },
    en: { review: 'Review', settings: 'Settings', workflow: 'Translate', run: 'Translate', custom: 'Custom', save: 'Save', manual: 'The Lost Key Shop' },
    ja: { review: '候補の確認', settings: '設定', workflow: '翻訳作業', run: '翻訳実行', custom: '指定する', save: '保存', manual: '失われた鍵の店' },
    zh: { review: '候选文本检查', settings: '设置', workflow: '翻译', run: '翻译', custom: '自定义', save: '保存', manual: '失落的钥匙商店' },
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
      await page.locator('header nav').getByRole('button', { name: new RegExp(`^${labels.review}`) }).click();
      await page.locator('tr[data-index="1"]').click();
      await page.locator('#manual-translation').waitFor({ state: 'visible' });
      if (await page.locator('#manual-translation').inputValue() !== labels.manual) throw new Error(`Wrong manual translation: ${locale}`);
      await settle();
      await page.screenshot({ path: `docs/images/locales/${locale}/review.png` });

      await page.locator('.sidebar').getByRole('button', { name: labels.settings, exact: true }).click();
      await page.getByRole('radio', { name: labels.custom, exact: true }).check();
      await page.locator('#openrouter-reasoning').selectOption('max');
      await page.locator('main').evaluate((element) => { element.scrollTop = 0; });
      await settle();
      await page.screenshot({ path: `docs/images/locales/${locale}/settings.png` });
      await page.getByRole('button', { name: labels.save, exact: true }).click();
      await page.locator('.sidebar').getByRole('button', { name: labels.workflow, exact: true }).click();
      await page.locator('header nav').getByRole('button', { name: new RegExp(`^${labels.run}`) }).click();
      await page.locator('#summary-title').waitFor({ state: 'visible' });
      await page.locator('.toast').waitFor({ state: 'hidden' });
      await page.locator('main').evaluate((element) => { element.scrollTop = 0; });
      await settle();
      await page.screenshot({ path: `docs/images/locales/${locale}/run.png` });
      const requests = await page.evaluate(() => window.__pomiRequests);
      if (requests.some((request) => ['translate.start', 'scan.start', 'backup.restore'].includes(request.type))) throw new Error('Unexpected world job during documentation capture');
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error(`Horizontal overflow: ${locale}`);
    }
    if (externalRequests.length) throw new Error(`Unexpected external requests: ${externalRequests.join(', ')}`);
    return { locales: Object.keys(locales), screenshots: 9, externalRequests: 0, paidRequests: 0, viewport: '1440x980' };
  } finally {
    page.off('request', onRequest);
  }
}
