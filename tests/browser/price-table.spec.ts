import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';

// The cost note names where a table price came from; an unknown price stays unknown (QUALITY: provider price time).

async function toRun(page: Page, query: string) {
  await page.addInitScript({ path: resolve('tests/frontend/tauri-fixture-init.js') });
  await page.goto(`/?${query}`);
  await expect(page.locator('.boot')).toHaveCount(0);
  await page.getByRole('navigation', { name: '작업 단계' }).getByRole('button', { name: /^번역 준비/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: '번역 준비', exact: true })).toBeVisible();
}

test('a table-priced Gemini model says the price is a published list price, dated, with its page', async ({ page }) => {
  await toRun(page, 'scenario=run-progress&provider=gemini&price=table');
  await expect(page.getByRole('definition').filter({ hasText: 'Gemini · gemini-2.5-flash' })).toBeVisible();
  await expect(page.locator('.cost-head')).toContainText('약 US$0.00082 – US$0.0016'); // two significant digits for sub-cent amounts
  const note = page.getByTestId('cost-table-note');
  await expect(note).toContainText('제공사가 공개한 정가이며 2026-10-23에 확인했습니다');
  await expect(note).toContainText('최종 청구 금액은 제공사 대시보드에서 확인해 주세요');
  const link = note.getByRole('link', { name: '가격 페이지 보기' });
  await expect(link).toHaveAttribute('href', 'https://ai.google.dev/gemini-api/docs/pricing');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noreferrer/);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('a catalog price carries no table note', async ({ page }) => {
  await toRun(page, 'scenario=run-progress');
  await expect(page.locator('.cost-head')).toContainText('약 US$');
  await expect(page.getByTestId('cost-table-note')).toHaveCount(0);
});

test('a model with no current list price stays unknown and says so', async ({ page }) => {
  await toRun(page, 'scenario=run-progress&provider=gemini&model=gemini-flash-latest&price=unknown');
  await expect(page.locator('.cost-head')).toHaveText('비용 확인 불가');
  await expect(page.getByText('이 모델의 최신 정가가 저장돼 있지 않습니다.')).toBeVisible();
  await expect(page.getByTestId('cost-table-note')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('a Custom endpoint without a price keeps the provider-does-not-publish text', async ({ page }) => {
  await toRun(page, 'scenario=run-progress&provider=custom&price=unknown');
  await expect(page.locator('.cost-head')).toHaveText('비용 확인 불가');
  await expect(page.getByText('해당 AI 서비스에서 모델 단가 정보를 제공하지 않습니다.')).toBeVisible();
  await expect(page.getByTestId('cost-table-note')).toHaveCount(0);
});
