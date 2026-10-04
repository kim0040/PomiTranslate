import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { zh } from '../../src/lib/i18n/zh';

const officialNotice = 'NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.';
const configs = [
  { width: 1180, height: 800, theme: 'light' },
  { width: 1180, height: 800, theme: 'dark' },
  { width: 840, height: 620, theme: 'light' },
  { width: 840, height: 620, theme: 'dark' }
] as const;

async function assertChineseSurface(page: Page, name: string) {
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
  const result = await page.evaluate((notice) => {
    const visibleLeafText = [...document.querySelectorAll('body *')]
      .filter((element) => element.children.length === 0)
      .filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      })
      .filter((element) => !element.closest('[lang="en"], code, pre, .mono, .src, .source'))
      .map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const rawKeys = visibleLeafText.filter((value) => {
      if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/i.test(value)) return false;
      const isLinkedHost = [...document.querySelectorAll('a')].some((link) => {
        try { return new URL(link.href).hostname.replace(/^www\./, '') === value; }
        catch { return false; }
      });
      return !isLinkedHost;
    });
    const englishProse = visibleLeafText.filter((value) => {
      if (value === notice || value === 'World Translator for Minecraft') return false;
      return value.length >= 28 && value.split(/\s+/).length >= 5 && /^[A-Za-z][A-Za-z0-9\s,.:'’!?()\-]+$/.test(value);
    });
    const main = document.querySelector('main');
    return {
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : 0,
      rawKeys,
      englishProse
    };
  }, officialNotice);
  expect(result.documentOverflow, `${name}: document horizontal overflow`).toBeLessThanOrEqual(1);
  expect(result.mainOverflow, `${name}: main pane horizontal overflow`).toBeLessThanOrEqual(1);
  expect(result.rawKeys, `${name}: untranslated key fallback`).toEqual([]);
  expect(result.englishProse, `${name}: English UI sentence`).toEqual([]);
}

test('Simplified Chinese first-run, translation workflow, settings, help, and about fit the supported desktop sizes', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });

  for (const config of configs) {
    await page.setViewportSize({ width: config.width, height: config.height });
    await page.emulateMedia({ colorScheme: config.theme, reducedMotion: 'reduce' });
    await page.goto(`/?scenario=first-run&fresh=1&locale=zh&theme=${config.theme}`);
    await expect(page.locator('.boot')).toHaveCount(0);

    const wizard = page.getByRole('dialog');
    await expect(wizard).toBeVisible();
    await expect(wizard).toContainText(officialNotice);
    await assertChineseSurface(page, `wizard welcome ${config.width} ${config.theme}`);
    await page.mouse.move(0, 0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await wizard.getByRole('button').last().click();
    await assertChineseSurface(page, `wizard provider ${config.width} ${config.theme}`);
    await wizard.getByRole('button').last().click();

    const key = page.locator('#setup-api-key');
    await expect(key).toBeVisible();
    await key.fill('sk-or-fixture-good-key');
    await key.blur();
    await expect(wizard.getByRole('button').last()).toBeEnabled();
    await assertChineseSurface(page, `wizard key ${config.width} ${config.theme}`);
    await wizard.getByRole('button').last().click();
    await expect(page.locator('#setup-model')).toBeVisible();
    await expect(page.locator('#setup-model')).not.toHaveValue('');
    await wizard.getByRole('button').last().click();
    await expect(page.locator('#setup-language')).toBeVisible();
    await assertChineseSurface(page, `wizard target language ${config.width} ${config.theme}`);
    await wizard.getByRole('button').last().click();
    await expect(wizard.getByRole('status')).toBeVisible();
    await wizard.getByRole('button').last().click();
    await expect(wizard).toHaveCount(0);

    // Check the world screen and the scan screen before scanning the synthetic fixture world.
    await page.locator('.stepper button').nth(0).click();
    await assertChineseSurface(page, `world ${config.width} ${config.theme}`);
    await page.locator('.stepper button').nth(1).click();
    await assertChineseSurface(page, `scan ${config.width} ${config.theme}`);
    await page.getByRole('button', { name: zh['scan.run'], exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: zh['scan.title'], exact: true })).toBeVisible();
    await expect(page.locator('main').getByRole('button', { name: zh['scan.review'], exact: true })).toBeEnabled();
    await assertChineseSurface(page, `scan results ${config.width} ${config.theme}`);
    await page.locator('main').getByRole('button', { name: zh['scan.review'], exact: true }).click();

    await expect(page.getByRole('heading', { level: 1, name: zh['review.title'], exact: true })).toBeVisible();
    await assertChineseSurface(page, `review ${config.width} ${config.theme}`);
    await page.mouse.move(0, 0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.locator('main').getByRole('button', { name: zh['review.toRun'], exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: zh['run.title'], exact: true })).toBeVisible();
    await assertChineseSurface(page, `run ${config.width} ${config.theme}`);
    await page.locator('#review-before-apply').uncheck();
    await expect.poll(() => page.evaluate(() => (window as any).__pomiSettingsSaves.some((save: any) => save.reviewBeforeApply === false))).toBe(true);
    await page.locator('main').getByRole('button', { name: zh['run.start'], exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: zh['result.title'], exact: true })).toBeVisible();
    await expect(page.locator('main').getByRole('status').first()).toContainText(zh['result.completed']);
    await assertChineseSurface(page, `result ${config.width} ${config.theme}`);

    await page.locator('.sidebar nav').getByRole('button', { name: zh['nav.backups'], exact: true }).click();
    await assertChineseSurface(page, `backups ${config.width} ${config.theme}`);

    await page.locator('.sidebar nav').getByRole('button', { name: zh['nav.settings'], exact: true }).click();
    const tabs = page.getByRole('tablist', { name: zh['settings.tabs'] }).getByRole('tab');
    for (const index of [0, 1, 2, 3]) {
      await tabs.nth(index).click();
      await assertChineseSurface(page, `settings tab ${index} ${config.width} ${config.theme}`);
    }
    if (config.width === 840 && config.theme === 'light') {
      const language = page.locator('#ui-language');
      await language.selectOption('en');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await language.selectOption('zh');
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh');
      await expect(language).toHaveValue('zh');
      await expect.poll(() => page.evaluate(() => {
        const labels = ((window as any).__pomiChrome ?? []).filter((call: any) => call.command === 'set_menu_labels').at(-1)?.args.labels;
        return labels?.settings;
      })).toBe(zh['menu.settings']);
    }

    await page.locator('.sidebar nav').getByRole('button', { name: zh['nav.help'], exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: zh['help.title'], exact: true })).toBeVisible();
    await assertChineseSurface(page, `help ${config.width} ${config.theme}`);
    await page.locator('.sidebar nav').getByRole('button', { name: zh['nav.about'], exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: zh['about.title'], exact: true })).toBeVisible();
    await expect(page.locator('main')).toContainText(officialNotice);
    await assertChineseSurface(page, `about ${config.width} ${config.theme}`);

    const requests = await page.evaluate(() => (window as any).__pomiRequests.map((request: any) => request.type));
    expect(requests).toContain('scan.start');
    expect(requests).toContain('translate.start');
    expect(requests).not.toContain('backup.restore');
  }
});
