import fs from 'node:fs';
import path from 'node:path';

if (process.platform !== 'linux') {
  throw new Error('The Linux companion must be packaged on Linux.');
}

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const outputRoot = path.join(root, 'desktop-release');
const appOut = path.join(outputRoot, 'linux-unpacked');
const resourcesOut = path.join(appOut, 'resources');
const appResourcesOut = path.join(resourcesOut, 'app');

if (!fs.existsSync(path.join(electronDist, 'electron'))) {
  throw new Error('Electron Linux runtime is missing. Run npm ci first.');
}

fs.rmSync(appOut, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });
fs.cpSync(electronDist, appOut, { recursive: true, force: true });

const electronBinary = path.join(appOut, 'electron');
const sarahBinary = path.join(appOut, 'sarah');
fs.renameSync(electronBinary, sarahBinary);
fs.chmodSync(sarahBinary, 0o755);
fs.rmSync(path.join(resourcesOut, 'default_app.asar'), { force: true });

fs.mkdirSync(path.join(appResourcesOut, 'desktop'), { recursive: true });
for (const filename of ['main.cjs', 'preload.cjs', 'remote-backend.cjs']) {
  fs.copyFileSync(
    path.join(root, 'desktop', filename),
    path.join(appResourcesOut, 'desktop', filename),
  );
}

fs.mkdirSync(path.join(appResourcesOut, 'dist', 'icons'), { recursive: true });
for (const size of [192, 512]) {
  fs.copyFileSync(
    path.join(root, 'public', 'icons', `sarah-${size}.png`),
    path.join(appResourcesOut, 'dist', 'icons', `sarah-${size}.png`),
  );
}

fs.writeFileSync(path.join(appResourcesOut, 'package.json'), `${JSON.stringify({
  name: packageJson.name,
  productName: 'Sarah',
  version: packageJson.version,
  main: 'desktop/main.cjs',
}, null, 2)}\n`);

console.log(`Built Linux remote companion at ${appOut}`);
console.log(`Runnable: ${sarahBinary}`);
