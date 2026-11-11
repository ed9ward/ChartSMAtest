import { defineConfig } from '@playwright/test';

// CHROMIUM_PATH is only for environments where `npx playwright install` is not possible.
const executablePath = process.env.CHROMIUM_PATH || undefined;
const ci = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/ui',
  timeout: 20_000,
  fullyParallel: true,
  forbidOnly: ci,
  retries: 0, // a flaky test must fail loudly, not pass on the second try
  workers: ci ? 2 : undefined, // 4 gave no speed-up on the runner; locally: half of the CPU cores
  reporter: ci ? [['list'], ['github'], ['html', { open: 'never' }]] : [['list']], // 'github' puts failures into the run's annotations
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1100, height: 800 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC', // the page shows local time; fixed so the tests do not depend on the machine
    launchOptions: executablePath ? { executablePath, args: ['--no-sandbox'] } : {},
  },
  webServer: {
    command: 'node scripts/serve.js 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: !ci,
  },
});
