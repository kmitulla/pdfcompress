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
      args: [
        // Fake-Kamera für die Scanner-Tests (liefert ein Testbild-Video)
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    port: 8823,
    reuseExistingServer: true,
  },
});
