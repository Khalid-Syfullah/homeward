import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests (npm test): the production build, served by next start, in Chromium.
 *
 *   chromium      every spec, in the headless shell, whose WebGL is software (SwiftShader): the same
 *                 pixels on any machine
 *   chromium-gpu  the pixel-exact specs (scrub, joins) again in full Chromium on the machine's own GPU
 *                 (ANGLE over Metal, Direct3D or OpenGL); without a GPU it falls back to software too
 *   webkit        every spec in Playwright's WebKit (Safari's engine, on the desktop), only when
 *                 HOMEWARD_WEBKIT=1 is set (it needs npx playwright install webkit). It is not iOS Safari.
 *
 * The web server step builds first, so the tests always see the current code. A server already
 * listening on the port is reused instead (npm run build && npx next start --port 3217).
 */
const PORT = Number(process.env.HOMEWARD_TEST_PORT ?? 3217);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "tests",
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run build && npx next start --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "chromium-gpu",
      use: { ...devices["Desktop Chrome"], channel: "chromium" },
      testMatch: /(scrub|joins)\.spec\.ts/,
    },
    ...(process.env.HOMEWARD_WEBKIT === "1" ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }] : []),
  ],
});
