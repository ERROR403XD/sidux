import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('snapshots and checks every account profile, and uses the current credentials for a later rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codexapp-cutover-auth-'))
  try {
    const home = join(root, 'production-home')
    for (const name of ['a', 'b', '.pending/login']) {
      await mkdir(join(home, 'accounts', name), { recursive: true })
      await writeFile(join(home, 'accounts', name, 'auth.json'), `synthetic-${name}`)
    }
    await writeFile(join(home, 'auth.json'), 'synthetic-active-a')
    await writeFile(join(home, 'accounts.json'), JSON.stringify({ activeStorageId: 'a', accounts: [{ storageId: 'a' }, { storageId: 'b' }] }))
    const source = await readFile(new URL('../../scripts/codexapp-release-switch.sh', import.meta.url), 'utf8')
    // Load only function definitions. Never dispatch activate or touch systemd.
    expect(source).toMatch(/\nmain "\$@"\s*$/)
    const definitions = source.replace(/\nmain "\$@"\s*$/, '\n')
    const harness = join(root, 'test.sh')
    await writeFile(harness, definitions + `
snapshot_auth_state "$CASE_ROOT/initial"
auth_state_matches_snapshot "$CASE_ROOT/initial"
printf changed > "$PRODUCTION_HOME/accounts/b/auth.json"
if auth_state_matches_snapshot "$CASE_ROOT/initial"; then exit 11; fi
restore_auth_snapshot "$CASE_ROOT/initial"
auth_state_matches_snapshot "$CASE_ROOT/initial"
printf changed > "$PRODUCTION_HOME/accounts/.pending/login/auth.json"
if auth_state_matches_snapshot "$CASE_ROOT/initial"; then exit 12; fi
restore_auth_snapshot "$CASE_ROOT/initial"
auth_state_matches_snapshot "$CASE_ROOT/initial"
# A later rollback starts with today's state, not activation-time credentials.
printf synthetic-current-refresh > "$PRODUCTION_HOME/accounts/a/auth.json"
printf synthetic-current-refresh > "$PRODUCTION_HOME/auth.json"
snapshot_auth_state "$CASE_ROOT/later"
printf changed > "$PRODUCTION_HOME/auth.json"
restore_auth_snapshot "$CASE_ROOT/later"
auth_state_matches_snapshot "$CASE_ROOT/later"
`)
    execFileSync('bash', [harness], {
      env: { ...process.env, CODEXAPP_PRODUCTION_HOME: home, CASE_ROOT: root, CODEXAPP_SWITCH_STATE_ROOT: join(root, 'switch-state') },
      timeout: 10000,
      stdio: 'pipe',
    })
    expect(await readFile(join(home, 'auth.json'), 'utf8')).toBe('synthetic-current-refresh')
    expect(await readFile(join(home, 'accounts/a/auth.json'), 'utf8')).toBe('synthetic-current-refresh')
    expect(await readFile(join(home, 'accounts/b/auth.json'), 'utf8')).toBe('synthetic-b')
    expect(await readFile(join(home, 'accounts/.pending/login/auth.json'), 'utf8')).toBe('synthetic-.pending/login')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
