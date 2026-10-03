import { defineConfig } from '@playwright/test';

// PW_PORT lets parallel worktrees run browser tests without fighting over one port.
const port = Number(process.env.PW_PORT || 5197);

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  workers: 1,
  outputDir: 'output/playwright/results',
  reporter: 'list',
  use: { channel: 'chrome', baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure',
    // Screens fade in; tests read them settled. tests/browser/motion.spec.ts covers the motion itself.
    contextOptions: { reducedMotion: 'reduce' } },
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
