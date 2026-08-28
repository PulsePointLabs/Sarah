import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const targetDir = path.join(root, 'desktop', 'node-runtime');
const target = path.join(targetDir, process.platform === 'win32' ? 'node.exe' : 'node');

fs.mkdirSync(targetDir, { recursive: true });

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

if (fs.existsSync(target) && fs.statSync(target).size === fs.statSync(process.execPath).size && sha256(target) === sha256(process.execPath)) {
  console.log(`Node runtime is current at ${target}`);
  process.exit(0);
}

fs.copyFileSync(process.execPath, target);
try {
  fs.chmodSync(target, 0o755);
} catch {
  // Windows does not need chmod for node.exe.
}

console.log(`Copied Node runtime to ${target}`);
