import { defineConfig } from 'vitest/config'

/**
 * Independent test configuration for the protocol bridge.
 *
 * Run with, from the repository root:
 *   pnpm run test:bridge
 * or directly:
 *   npx vitest run --config protocol-bridge/vitest.config.ts
 *
 * The suite needs no network, no database, no Codex installation, and no
 * main-project modules; it exercises the bridge through its public API only.
 */
export default defineConfig({
  root: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    name: 'protocol-bridge',
  },
})
