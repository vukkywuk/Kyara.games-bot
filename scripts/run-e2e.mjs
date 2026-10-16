// Runs the browser tests (Chromium via Playwright). Cross-platform way to set the opt-in flag.
import { spawnSync } from 'node:child_process';

const r = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/browser.e2e.test.ts', 'tests/extension.e2e.test.ts', 'tests/web.e2e.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, KYARA_BROWSER_TESTS: '1' },
});
process.exit(r.status ?? 1);
