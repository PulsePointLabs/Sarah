import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.platform !== 'linux') {
  throw new Error('The CachyOS package must be built on Linux.');
}

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outputRoot = path.join(root, 'desktop-release');
const appOut = path.join(outputRoot, 'linux-unpacked');
const packageRoot = path.join(outputRoot, 'cachyos-package');
const payload = path.join(packageRoot, 'payload');

if (!fs.existsSync(path.join(appOut, 'sarah'))) {
  throw new Error('Linux remote companion is missing. Run desktop:pack:linux:remote first.');
}

fs.rmSync(packageRoot, { recursive: true, force: true });
fs.mkdirSync(packageRoot, { recursive: true });
fs.cpSync(appOut, payload, { recursive: true, force: true });

fs.writeFileSync(path.join(packageRoot, 'sarah-launcher'), `#!/bin/sh
export SARAH_REMOTE_BACKEND_URLS="\${SARAH_REMOTE_BACKEND_URLS:-https://benm-desktop.tail980777.ts.net,http://100.65.16.104:8787,http://192.168.0.33:8787}"
exec /opt/sarah/sarah "$@"
`);
fs.chmodSync(path.join(packageRoot, 'sarah-launcher'), 0o755);

fs.writeFileSync(path.join(packageRoot, 'sarah.desktop'), `[Desktop Entry]
Name=Sarah
Comment=Sarah shared-session companion
Exec=sarah
Icon=sarah
Terminal=false
Type=Application
Categories=Utility;Health;
StartupWMClass=Sarah
`);

fs.writeFileSync(path.join(packageRoot, 'PKGBUILD'), `pkgname=sarah-remote
pkgver=${packageJson.version}
pkgrel=1
pkgdesc="Sarah shared-session companion for CachyOS and Arch Linux"
arch=('x86_64')
url="https://github.com/PulsePointLabs/Sarah"
license=('custom')
depends=('alsa-lib' 'at-spi2-core' 'cairo' 'libcups' 'dbus' 'expat' 'glib2' 'gtk3' 'libdrm' 'libx11' 'libxcb' 'libxcomposite' 'libxdamage' 'libxext' 'libxfixes' 'libxkbcommon' 'libxrandr' 'mesa' 'nspr' 'nss' 'pango')
options=('!strip')
source=()
sha256sums=()

package() {
  install -d "\${pkgdir}/opt/sarah"
  cp -a "\${srcdir}/../payload/." "\${pkgdir}/opt/sarah/"
  install -Dm755 "\${srcdir}/../sarah-launcher" "\${pkgdir}/usr/bin/sarah"
  install -Dm644 "\${srcdir}/../sarah.desktop" "\${pkgdir}/usr/share/applications/sarah.desktop"
  install -Dm644 "\${srcdir}/../payload/resources/app/dist/icons/sarah-512.png" "\${pkgdir}/usr/share/pixmaps/sarah.png"
  chmod 4755 "\${pkgdir}/opt/sarah/chrome-sandbox"
}
`);

const result = spawnSync('makepkg', ['--force', '--cleanbuild', '--noconfirm'], {
  cwd: packageRoot,
  stdio: 'inherit',
});
if (result.status !== 0) {
  throw new Error(`makepkg failed with exit code ${result.status}`);
}

const packageFile = fs.readdirSync(packageRoot)
  .find((filename) => filename.endsWith('.pkg.tar.zst'));
if (!packageFile) throw new Error('makepkg completed without producing a .pkg.tar.zst file.');
const finalPath = path.join(outputRoot, `Sarah-CachyOS-v${packageJson.version}-x86_64.pkg.tar.zst`);
fs.copyFileSync(path.join(packageRoot, packageFile), finalPath);
console.log(`Built CachyOS package at ${finalPath}`);
