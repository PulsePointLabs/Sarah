import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const targetDir = path.join(root, 'desktop', 'node-runtime');
const target = path.join(targetDir, process.platform === 'win32' ? 'node.exe' : 'node');

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(process.execPath, target);
try {
  fs.chmodSync(target, 0o755);
} catch {
  // Windows does not need chmod for node.exe.
}

console.log(`Copied Node runtime to ${target}`);
