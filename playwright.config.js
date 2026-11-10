import { defineConfig } from '@playwright/test';

// CHROMIUM_PATH is only for environments where `npx playwright install` is not possible.
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'tests/ui',
  timeout: 20_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1100, height: 800 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    launchOptions: executablePath ? { executablePath, args: ['--no-sandbox'] } : {},
  },
  webServer: {
    command: 'node scripts/serve.js 4173',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
  },
});
