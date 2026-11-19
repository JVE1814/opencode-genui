import { defineConfig, devices } from "@playwright/test"

// End-to-end tests run against the playground (a fake OpenCode desktop host, see playground/README.md). PW_PORT picks
// another port, so a run never shares (or loses) a dev server another run started.
const PORT = Number(process.env.PW_PORT ?? 5179)

export default defineConfig({
  testDir: "test/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: `npx vite --config playground/vite.config.ts --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
