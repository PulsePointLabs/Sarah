import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outputRoot = path.join(root, 'desktop-release');
const appOut = path.join(outputRoot, 'win-unpacked');
const resourcesOut = path.join(appOut, 'resources');
const appResourcesOut = path.join(resourcesOut, 'app');
const sarahExe = path.join(appOut, 'Sarah.exe');

function assertInsideRoot(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(root)) throw new Error(`Refusing to write outside repository: ${resolved}`);
  return resolved;
}

function removeDir(target) {
  const resolved = assertInsideRoot(target);
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

function tryRemoveDir(target) {
  try {
    removeDir(target);
    return true;
  } catch (error) {
    if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error;
    return false;
  }
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

function refreshDir(from, to, options = {}) {
  if (!tryRemoveDir(to)) {
    console.warn(`Could not remove ${to}; overlaying files in place.`);
  }
  copyDir(from, to, options);
}

function copySarahResources({ overlay = false } = {}) {
  if (!overlay) removeDir(appResourcesOut);
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
  refreshDir(path.join(root, 'local-vision'), path.join(appResourcesOut, 'local-vision'));
  const packagedNodeModules = path.join(appResourcesOut, 'node_modules');
  if (overlay && fs.existsSync(packagedNodeModules)) {
    console.warn(`Sarah is running; leaving existing packaged node_modules in place.`);
  } else {
    refreshDir(path.join(root, 'node_modules'), packagedNodeModules, {
      filter(source) {
        const normalized = source.replaceAll('\\', '/');
        return !normalized.includes('/.cache/') && !normalized.includes('/electron/dist/');
      },
    });
  }
  fs.copyFileSync(path.join(root, 'package.json'), path.join(appResourcesOut, 'package.json'));
  const packagedNodeRuntime = path.join(resourcesOut, 'node-runtime');
  if (overlay && fs.existsSync(packagedNodeRuntime)) {
    console.warn(`Sarah is running; leaving existing packaged node-runtime in place.`);
  } else {
    refreshDir(path.join(root, 'desktop', 'node-runtime'), packagedNodeRuntime);
  }
}

const removedAppOut = tryRemoveDir(appOut);
fs.mkdirSync(outputRoot, { recursive: true });

if (removedAppOut || !fs.existsSync(path.join(appOut, 'Sarah.exe'))) {
  copyDir(electronDist, appOut);

  const electronExe = path.join(appOut, 'electron.exe');
  if (fs.existsSync(sarahExe)) fs.rmSync(sarahExe, { force: true });
  fs.renameSync(electronExe, sarahExe);

  removeDir(path.join(resourcesOut, 'default_app.asar'));
} else {
  console.warn(`Could not remove ${appOut}; refreshing packaged app resources in place.`);
  removeDir(path.join(resourcesOut, 'default_app.asar'));
}

copySarahResources({ overlay: !removedAppOut });

console.log(`Built Windows unpacked desktop app at ${appOut}`);
console.log(`Runnable: ${sarahExe}`);
