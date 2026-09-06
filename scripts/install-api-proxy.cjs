// Explicit build-time installation; never invoked during application startup.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const manifest = require('../resources/api-proxy/manifest.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function install(destination) {
  if (`${process.platform}-${process.arch}` !== manifest.platform) throw new Error('This candidate supports linux-x64 only.');
  if (!destination) throw new Error('Usage: node scripts/install-api-proxy.cjs <destination-directory>');
  try {
    const installed = await fs.readFile(path.join(destination, 'cli-proxy-api'));
    const installedManifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
    await fs.access(path.join(destination, 'LICENSE'));
    if (sha256(installed) === manifest.binarySha256 && installedManifest.archiveSha256 === manifest.archiveSha256) {
      console.log(`Reusing verified ${manifest.name} ${manifest.version}: ${path.resolve(destination)}`);
      return;
    }
  } catch { /* Missing or outdated artifacts are replaced from the pinned release. */ }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codexapp-cpa-install-'));
  try {
    const response = await fetch(manifest.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Component download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (sha256(archive) !== manifest.archiveSha256) throw new Error('Component archive checksum mismatch.');
    const archivePath = path.join(temporary, 'component.tar.gz');
    await fs.writeFile(archivePath, archive);
    execFileSync('tar', ['-xzf', archivePath, '-C', temporary, '--', 'cli-proxy-api', 'LICENSE']);
    const binary = await fs.readFile(path.join(temporary, 'cli-proxy-api'));
    if (sha256(binary) !== manifest.binarySha256) throw new Error('Component executable checksum mismatch.');
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, 'cli-proxy-api'), binary, { mode: 0o755 });
    await fs.chmod(path.join(destination, 'cli-proxy-api'), 0o755);
    await fs.copyFile(path.join(temporary, 'LICENSE'), path.join(destination, 'LICENSE'));
    await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (sha256(await fs.readFile(path.join(destination, 'cli-proxy-api'))) !== manifest.binarySha256) throw new Error('Installed executable checksum mismatch.');
    console.log(`Verified ${manifest.name} ${manifest.version}: ${path.resolve(destination)}`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
if (require.main === module) install(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { install };
