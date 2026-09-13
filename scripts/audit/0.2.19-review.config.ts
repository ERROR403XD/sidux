import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/audit/0.2.19-sealed-review.test.ts'],
    testTimeout: 10000,
  },
})
