const { createRequire } = require('node:module')
const { resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
// Use Vite's existing esbuild dependency; do not install a second compiler.
const esbuild = createRequire(require.resolve('vite'))('esbuild')
const output = resolve('output/profile-automations.mjs')
esbuild.buildSync({ entryPoints: ['scripts/profile-automations.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: output })
const result = spawnSync(process.execPath, [output], { stdio: 'inherit', env: process.env })
process.exit(result.status ?? 1)
