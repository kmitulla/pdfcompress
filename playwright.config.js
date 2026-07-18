// @ts-check
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 240000,
  expect: { timeout: 20000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8823',
    launchOptions: {
      // Vorinstalliertes Chromium der Umgebung verwenden
      executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    },
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    port: 8823,
    reuseExistingServer: true,
  },
});
