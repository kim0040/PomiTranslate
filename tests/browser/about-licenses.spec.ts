import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// About, Help, the license list, the reset dialog and the first-run tour after the visual redesign.
async function boot(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
}
const emit = (page: Page, name: string, payload: unknown) => page.evaluate(([n, p]) => (window as any).__pomiEmit(n, p), [name, payload] as const);
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);

test.describe('About', () => {
  test('is one calm hero, a link list and collapsible sections', async ({ page }) => {
    await boot(page, 'scenario=selected');
    await page.getByRole('button', { name: '정보', exact: true }).click();
    // One H1, named for the page; the lockup is the SVG, never the old wordmark PNG.
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1, name: 'PomiTranslate 정보', exact: true })).toBeVisible();
    await expect(page.locator('.about img[src*="wordmark"]')).toHaveCount(0);
    await expect(page.locator('.about .hero h1 svg')).toBeVisible();
    await expect(page.locator('.about .hero')).toContainText('버전');

    const sections = page.locator('.about .sections details');
    await expect(sections).toHaveCount(4);
    // The required notice is open; the dense sections are folded behind a one-line summary.
    await expect(sections.nth(0)).toHaveAttribute('open', '');
    await expect(page.getByText('NOT AN OFFICIAL MINECRAFT PRODUCT', { exact: false })).toBeVisible();
    for (const i of [1, 2, 3]) await expect(sections.nth(i)).not.toHaveAttribute('open', '');
    const scope = sections.nth(1);
    await expect(scope.locator('summary .sum')).toBeVisible();
    await expect(scope.locator('.panel')).toBeHidden();
    await scope.locator('summary').click();
    await expect(scope).toHaveAttribute('open', '');
    await expect(scope.locator('.panel')).toBeVisible();
    await expect(scope.locator('.panel').getByText('데이터팩', { exact: false }).first()).toBeVisible();
    await expect(scope.getByRole('link', { name: /support-matrix/ })).toBeVisible();

    // The license list opens from the link row, same as the Help menu.
    await page.getByRole('button', { name: /오픈소스 라이선스/ }).click();
    await expect(page.getByRole('dialog', { name: '오픈소스 라이선스' })).toBeVisible();
  });

  for (const size of [{ width: 840, height: 620 }, { width: 640, height: 400 }, { width: 1600, height: 1000 }]) {
    test(`stays inside the window at ${size.width}x${size.height} and passes axe`, async ({ page }) => {
      await page.setViewportSize(size);
      await boot(page, 'scenario=selected');
      await page.getByRole('button', { name: '정보', exact: true }).click();
      await page.locator('.about details').evaluateAll((all) => all.forEach((d) => ((d as HTMLDetailsElement).open = true)));
      await noOverflow(page);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    });
  }
});

test.describe('Help', () => {
  test('puts the tour action on the title line and lists shortcuts as list rows', async ({ page }) => {
    await boot(page, 'scenario=selected');
    await page.getByRole('button', { name: '도움말', exact: true }).click();
    const title = page.getByRole('heading', { level: 1, name: '도움말', exact: true });
    const action = page.getByRole('button', { name: '시작 안내 다시 보기' });
    const [t, a] = await Promise.all([title.boundingBox(), action.boundingBox()]);
    // Centre lines within a few pixels: the button sits on the title, not on the lead below it.
    expect(Math.abs((t!.y + t!.height / 2) - (a!.y + a!.height / 2))).toBeLessThanOrEqual(6);
    expect(a!.x).toBeGreaterThan(t!.x + t!.width);
    const rows = page.locator('#shortcuts ul.list > li');
    await expect(rows).toHaveCount(6);
    await expect(rows.first()).toContainText('월드 열기');
    await expect(rows.first().locator('kbd').first()).toBeVisible();
    await action.click();
    await expect(page.getByRole('dialog', { name: '시작 안내' })).toBeVisible();
  });

  test('hides the replay action after a failed start', async ({ page }) => {
    await boot(page, 'scenario=startup-stopped');
    await page.getByRole('button', { name: '도움말', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: '도움말', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '시작 안내 다시 보기' })).toHaveCount(0);
  });
});

test.describe('Open-source licenses', () => {
  async function open(page: Page, query = 'scenario=selected') {
    await boot(page, query);
    await emit(page, 'pomi-menu', 'licenses');
    const dialog = page.getByRole('dialog', { name: '오픈소스 라이선스' });
    await expect(dialog.locator('ul.pkgs button').first()).toBeVisible();
    return dialog;
  }

  test('lists packages, filters them and shows the selected license text', async ({ page }) => {
    const dialog = await open(page);
    const rows = dialog.locator('ul.pkgs button');
    expect(await rows.count()).toBeGreaterThan(300);
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    await expect(dialog.locator('pre')).toContainText('NOT AN OFFICIAL MINECRAFT PRODUCT');

    const filter = dialog.getByRole('searchbox', { name: '구성 요소 찾기' });
    await filter.fill('pretendard');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Pretendard Variable');
    await expect(rows.first()).toContainText('1.3.9');
    await expect(rows.first()).toContainText('OFL-1.1');
    // The filtered-in package is shown without another click, with the full OFL text.
    await expect(dialog.getByRole('heading', { name: /Pretendard Variable/ })).toBeVisible();
    await expect(dialog.locator('pre')).toContainText('SIL OPEN FONT LICENSE Version 1.1');
    await expect(dialog.locator('pre')).toContainText('Kil Hyung-jin');
    await expect(dialog.locator('pre')).toContainText('vector outlines derived from Pretendard');

    await filter.fill('zzz-no-such-package');
    await expect(rows).toHaveCount(0);
    await expect(dialog.getByText('조건에 맞는 구성 요소가 없습니다.')).toBeVisible();
    await filter.fill('');
    expect(await rows.count()).toBeGreaterThan(300);
  });

  test('is keyboard operable: Tab reaches the selected row, arrows move it, the text scrolls', async ({ page }) => {
    const dialog = await open(page);
    const rows = dialog.locator('ul.pkgs button');
    // Only the selected row is a tab stop, so a 400-row list costs one Tab.
    await expect(rows.nth(0)).toHaveAttribute('tabindex', '0');
    await expect(rows.nth(1)).toHaveAttribute('tabindex', '-1');
    await rows.nth(0).focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(rows.nth(1)).toBeFocused();
    await expect(rows.nth(0)).not.toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('End');
    await expect(rows.last()).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('Home');
    await expect(rows.first()).toHaveAttribute('aria-current', 'true');
    // The scrolling text region takes focus (WCAG 2.1.1).
    await expect(dialog.locator('pre')).toHaveAttribute('tabindex', '0');
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
  });

  test('keeps the application license one click away', async ({ page }) => {
    const dialog = await open(page);
    await dialog.getByRole('button', { name: 'PomiTranslate', exact: true }).click();
    await expect(dialog.locator('ul.pkgs')).toHaveCount(0);
    await expect(dialog.locator('pre')).toContainText('MIT License');
    await dialog.getByRole('button', { name: '포함된 구성 요소', exact: true }).click();
    await expect(dialog.locator('ul.pkgs')).toBeVisible();
  });

  for (const size of [{ width: 840, height: 620 }, { width: 640, height: 400 }, { width: 1600, height: 1000 }]) {
    test(`fits the window at ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size);
      const dialog = await open(page);
      await noOverflow(page);
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(size.width + 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height + 1);
      // List and text are both reachable even when the dialog is short (the body scrolls).
      await dialog.locator('pre').scrollIntoViewIfNeeded();
      await expect(dialog.locator('pre')).toBeVisible();
    });
  }
});

test.describe('Reset dialog', () => {
  test('keeps focus on Cancel and makes the final action the solid danger button', async ({ page }) => {
    await boot(page, 'scenario=selected');
    await page.getByRole('button', { name: '환경 설정', exact: true }).click();
    await page.getByRole('tab', { name: '앱', exact: true }).click();
    await page.getByRole('button', { name: '초기화…' }).click();
    let dialog = page.getByRole('dialog', { name: '앱을 초기화할까요?' });
    await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeFocused();
    const next = dialog.getByRole('button', { name: '초기화 계속', exact: true });
    await expect(next).toHaveClass(/btn-danger/);
    await expect(next).not.toHaveClass(/btn-danger-solid/);
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await next.click();
    dialog = page.getByRole('dialog', { name: '정말 초기화할까요?' });
    await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeFocused();
    await expect(dialog.getByRole('button', { name: '초기화', exact: true })).toHaveClass(/btn-danger-solid/);
    await noOverflow(page);
  });
});

test.describe('First-run tour', () => {
  for (const [locale, label, welcome, last] of [
    ['ko', '1 / 5', 'PomiTranslate에 오신 것을 환영합니다', '5 / 5'],
    ['en', '1 / 5', 'Welcome to PomiTranslate', '5 / 5'],
    ['ja', '1 / 5', 'PomiTranslateへようこそ', '5 / 5']
  ] as const) {
    test(`shows its position as text in ${locale} and keeps the keyboard flow`, async ({ page }) => {
      await boot(page, `scenario=first-run&locale=${locale}`);
      const notice = page.getByRole('dialog');
      await notice.locator('.btn-primary').first().click();
      // The setup wizard follows the accepted notice; Escape is its "later". The tour never starts by
      // itself after "later": it is opened from Help (here the native menu's "시작 안내").
      await expect(page.locator('[name="setup-provider"]').first()).toBeAttached();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.evaluate(() => (window as any).__pomiEmit('pomi-menu', 'tour'));
      const tour = page.getByRole('dialog');
      await expect(tour).toContainText(welcome);
      const count = tour.locator('.count');
      await expect(count).toHaveText(label);
      // Real text, not a live region: moving through steps does not make a screen reader chatter.
      expect(await count.evaluate((el) => !!el.closest('[aria-live], [role=status], [role=alert]'))).toBe(false);
      await expect(tour.locator('.dots')).toHaveAttribute('aria-hidden', 'true');
      await expect(tour.locator('.btn-primary')).toBeFocused();
      for (let i = 0; i < 4; i++) await page.keyboard.press('Enter');
      await expect(count).toHaveText(last);
      expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  }
});
