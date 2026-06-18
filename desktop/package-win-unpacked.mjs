import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outputRoot = path.join(root, 'desktop-release');
const appOut = path.join(outputRoot, 'win-unpacked');
const resourcesOut = path.join(appOut, 'resources');
const appResourcesOut = path.join(resourcesOut, 'app');

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
  fs.cpSync(from, to, {
    recursive: true,
    force: true,
    dereference: false,
    ...options,
  });
}

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  throw new Error('Electron runtime is missing. Run npm install first.');
}
if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  throw new Error('Built frontend is missing. Run npm run build first.');
}
if (!fs.existsSync(path.join(root, 'desktop', 'node-runtime', 'node.exe'))) {
  throw new Error('Bundled Node runtime is missing. Run npm run desktop:prepare-node first.');
}

removeDir(appOut);
fs.mkdirSync(outputRoot, { recursive: true });
copyDir(electronDist, appOut);

const electronExe = path.join(appOut, 'electron.exe');
const sarahExe = path.join(appOut, 'Sarah.exe');
if (fs.existsSync(sarahExe)) fs.rmSync(sarahExe, { force: true });
fs.renameSync(electronExe, sarahExe);

removeDir(path.join(resourcesOut, 'default_app.asar'));
fs.mkdirSync(appResourcesOut, { recursive: true });

copyDir(path.join(root, 'desktop'), path.join(appResourcesOut, 'desktop'), {
  filter(source) {
    return !source.includes(`${path.sep}node-runtime${path.sep}`);
  },
});
copyDir(path.join(root, 'dist'), path.join(appResourcesOut, 'dist'));
copyDir(path.join(root, 'server'), path.join(appResourcesOut, 'server'));
copyDir(path.join(root, 'src'), path.join(appResourcesOut, 'src'));
copyDir(path.join(root, 'local-vision'), path.join(appResourcesOut, 'local-vision'));
copyDir(path.join(root, 'node_modules'), path.join(appResourcesOut, 'node_modules'), {
  filter(source) {
    const normalized = source.replaceAll('\\', '/');
    return !normalized.includes('/.cache/') && !normalized.includes('/electron/dist/');
  },
});
fs.copyFileSync(path.join(root, 'package.json'), path.join(appResourcesOut, 'package.json'));
copyDir(path.join(root, 'desktop', 'node-runtime'), path.join(resourcesOut, 'node-runtime'));

console.log(`Built Windows unpacked desktop app at ${appOut}`);
console.log(`Runnable: ${sarahExe}`);
