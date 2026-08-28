import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outputRoot = path.join(root, 'desktop-release');
const appOut = path.join(outputRoot, 'win-unpacked');
const resourcesOut = path.join(appOut, 'resources');
const appResourcesOut = path.join(resourcesOut, 'app');
const sarahExe = path.join(appOut, 'Sarah.exe');
const sarahIcon = path.join(root, 'public', 'icons', 'sarah.ico');
const rcEdit = path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
const packageLock = path.join(root, 'package-lock.json');
const dependencyStamp = path.join(appResourcesOut, '.package-lock.sha256');
const electronStamp = path.join(appOut, '.electron-version');

function assertInsideRoot(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(root)) throw new Error(`Refusing to write outside repository: ${resolved}`);
  return resolved;
}

function removeDir(target) {
  const resolved = assertInsideRoot(target);
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

function copyDir(from, to, options = {}) {
  fs.cpSync(from, to, { recursive: true, force: true, dereference: false, ...options });
}

function refreshDir(from, to, options = {}) {
  removeDir(to);
  copyDir(from, to, options);
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function dependencyFingerprint() {
  const lock = JSON.parse(fs.readFileSync(packageLock, 'utf8'));
  delete lock.version;
  if (lock.packages?.['']) delete lock.packages[''].version;
  return `deps-v1:${crypto.createHash('sha256').update(JSON.stringify(lock)).digest('hex')}`;
}

function packagedDependencyManifestMatches() {
  const packagedManifest = path.join(appResourcesOut, 'package.json');
  if (!fs.existsSync(packagedManifest)) return false;
  const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packaged = JSON.parse(fs.readFileSync(packagedManifest, 'utf8'));
  return JSON.stringify(source.dependencies || {}) === JSON.stringify(packaged.dependencies || {})
    && JSON.stringify(source.devDependencies || {}) === JSON.stringify(packaged.devDependencies || {});
}

function copyFileIfChanged(from, to) {
  if (fs.existsSync(to) && fs.statSync(from).size === fs.statSync(to).size && sha256(from) === sha256(to)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

function assertSarahStopped() {
  if (!fs.existsSync(sarahExe)) return;
  const escaped = sarahExe.replaceAll("'", "''");
  const command = `$target='${escaped}'; if (Get-CimInstance Win32_Process -Filter \"Name = 'Sarah.exe'\" | Where-Object { $_.ExecutablePath -eq $target }) { exit 2 }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'ignore' });
  if (result.status === 2) throw new Error(`Packaged Sarah is still running: ${sarahExe}`);
  if (result.status !== 0) throw new Error('Could not confirm that packaged Sarah is stopped.');
}

function initializeElectronShell() {
  const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const existingVersion = fs.existsSync(electronStamp) ? fs.readFileSync(electronStamp, 'utf8').trim() : '';
  const shellExists = fs.existsSync(sarahExe) && fs.existsSync(resourcesOut);

  if (!shellExists || (existingVersion && existingVersion !== electronVersion)) {
    removeDir(appOut);
    fs.mkdirSync(outputRoot, { recursive: true });
    copyDir(electronDist, appOut);
    const electronExe = path.join(appOut, 'electron.exe');
    if (fs.existsSync(sarahExe)) fs.rmSync(sarahExe, { force: true });
    fs.renameSync(electronExe, sarahExe);
  }

  fs.mkdirSync(resourcesOut, { recursive: true });
  removeDir(path.join(resourcesOut, 'default_app.asar'));
  fs.writeFileSync(electronStamp, `${electronVersion}\n`);
}

function refreshPackagedDependencies() {
  const packagedNodeModules = path.join(appResourcesOut, 'node_modules');
  const lockHash = dependencyFingerprint();
  const stampedHash = fs.existsSync(dependencyStamp) ? fs.readFileSync(dependencyStamp, 'utf8').trim() : '';

  const legacyStampCanMigrate = !stampedHash.startsWith('deps-v1:') && packagedDependencyManifestMatches();
  if (fs.existsSync(packagedNodeModules) && (stampedHash === lockHash || legacyStampCanMigrate)) {
    fs.writeFileSync(dependencyStamp, `${lockHash}\n`);
    console.log('Preserved unchanged packaged dependencies.');
    return;
  }

  refreshDir(path.join(root, 'node_modules'), packagedNodeModules, {
    filter(source) {
      const normalized = source.replaceAll('\\', '/');
      return !normalized.includes('/.cache/') && !normalized.includes('/electron/dist/');
    },
  });
  fs.writeFileSync(dependencyStamp, `${lockHash}\n`);
  console.log('Refreshed packaged dependencies because package-lock.json changed.');
}

function localVisionFilter(source) {
  const normalized = source.replaceAll('\\', '/');
  const parts = normalized.split('/');
  const name = parts.at(-1) || '';
  return !parts.some((part) => part.startsWith('.venv') || part === '__pycache__') && !name.endsWith('.pyc');
}

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) throw new Error('Electron runtime is missing. Run npm install first.');
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('Built frontend is missing. Run Vite first.');
if (!fs.existsSync(path.join(root, 'desktop', 'node-runtime', 'node.exe'))) throw new Error('Bundled Node runtime is missing.');
if (!fs.existsSync(sarahIcon)) throw new Error(`Sarah Windows icon is missing: ${sarahIcon}`);
if (!fs.existsSync(rcEdit)) throw new Error(`Windows resource editor is missing: ${rcEdit}`);

assertSarahStopped();
initializeElectronShell();
fs.mkdirSync(appResourcesOut, { recursive: true });

refreshDir(path.join(root, 'desktop'), path.join(appResourcesOut, 'desktop'), {
  filter(source) {
    return !source.includes(`${path.sep}node-runtime${path.sep}`);
  },
});
refreshDir(path.join(root, 'dist'), path.join(appResourcesOut, 'dist'));
refreshDir(path.join(root, 'server'), path.join(appResourcesOut, 'server'));
refreshDir(path.join(root, 'src'), path.join(appResourcesOut, 'src'));
refreshDir(path.join(root, 'tools', 'capture', 'heart-rate'), path.join(appResourcesOut, 'tools', 'capture', 'heart-rate'));
refreshDir(path.join(root, 'local-vision'), path.join(appResourcesOut, 'local-vision'), { filter: localVisionFilter });
refreshPackagedDependencies();
fs.copyFileSync(path.join(root, 'package.json'), path.join(appResourcesOut, 'package.json'));
copyFileIfChanged(path.join(root, 'desktop', 'node-runtime', 'node.exe'), path.join(resourcesOut, 'node-runtime', 'node.exe'));

assertSarahStopped();
const version = String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0');
const windowsVersion = `${version}.0`;
const rcResult = spawnSync(rcEdit, [
  sarahExe,
  '--set-icon', sarahIcon,
  '--set-version-string', 'FileDescription', 'Sarah',
  '--set-version-string', 'ProductName', 'Sarah',
  '--set-version-string', 'OriginalFilename', 'Sarah.exe',
  '--set-version-string', 'CompanyName', 'PulsePoint Labs',
  '--set-file-version', windowsVersion,
  '--set-product-version', windowsVersion,
], { stdio: 'inherit' });
if (rcResult.status !== 0) throw new Error(`Could not brand Sarah.exe (rcedit exit ${rcResult.status}).`);

console.log(`Refreshed Windows app at ${appOut}`);
