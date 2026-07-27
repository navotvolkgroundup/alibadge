// Minimal on purpose: no webServer (page.route serves the fixtures), no retries
// (a flaky assertion here is a bug in the assertion), one worker so the exposed
// __lookup binding cannot interleave between tests.
export default {
  testDir: './test',
  timeout: 30000,
  workers: 1,
  use: { headless: true },
};
