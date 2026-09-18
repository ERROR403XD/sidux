import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'protocol-bridge/test/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'dist-cli/**', 'output/**'],
  },
})
