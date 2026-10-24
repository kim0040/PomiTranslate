import { chromium, type FullConfig } from '@playwright/test';

// The first page load makes Vite pre-bundle dependencies and compile the whole module graph. On a slow
// or busy machine that can pass the 30 s test timeout, so the first test of each worker failed on
// `page.goto` while every later one passed. Load the app once here, with a generous limit.
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage();
    await page.goto(baseURL, { waitUntil: 'load', timeout: 180_000 });
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  } finally {
    await browser.close();
  }
}
