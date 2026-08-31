import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
};
const commitMessage = value('--commit-message');
const shouldPublish = flag('--publish');
const shouldPush = shouldPublish || flag('--push');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const logDir = path.join(root, 'logs', 'releases');
const logPath = path.join(logDir, `release-${stamp}.log`);
const exePath = path.join(root, 'desktop-release', 'win-unpacked', 'Sarah.exe');
const apkPath = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const androidAssets = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'public');
const windowsDist = path.join(root, 'desktop-release', 'win-unpacked', 'resources', 'app', 'dist');
const timings = new Map();

fs.mkdirSync(logDir, { recursive: true });
const logFd = fs.openSync(logPath, 'a');
const startedAt = Date.now();

function log(message) {
  fs.writeSync(logFd, `${new Date().toISOString()} ${message}\n`);
}

function commandName(command) {
  if (process.platform !== 'win32') return command;
  if (command === 'npm') return 'npm.cmd';
  if (command === 'npx') return 'npx.cmd';
  return command;
}

function needsWindowsShell(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(commandName(command));
}

function spawnSpec(command, commandArgs) {
  const resolved = commandName(command);
  if (!needsWindowsShell(command)) return { command: resolved, args: commandArgs };
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/q', '/d', '/c', resolved, ...commandArgs],
  };
}

function javaEnvironment(base = process.env) {
  const env = { ...base };
  const jbr = 'C:\\Program Files\\Android\\Android Studio\\jbr';
  if (!env.JAVA_HOME && fs.existsSync(jbr)) env.JAVA_HOME = jbr;
  if (env.JAVA_HOME) env.PATH = `${path.join(env.JAVA_HOME, 'bin')};${env.PATH || ''}`;
  return env;
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    log(`$ ${command} ${commandArgs.join(' ')}`);
    const spec = spawnSpec(command, commandArgs);
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd || root,
      env: options.env || process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => fs.writeSync(logFd, chunk));
    child.stderr.on('data', (chunk) => fs.writeSync(logFd, chunk));
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

function capture(command, commandArgs, options = {}) {
  const spec = spawnSpec(command, commandArgs);
  const result = spawnSync(spec.command, spec.args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
  });
  log(`$ ${command} ${commandArgs.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`);
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  return String(result.stdout || '').trim();
}

async function stage(name, action) {
  const start = Date.now();
  process.stdout.write(`${name}... `);
  try {
    const result = await action();
    const elapsed = (Date.now() - start) / 1000;
    timings.set(name, elapsed);
    console.log(`${elapsed.toFixed(1)}s`);
    return result;
  } catch (error) {
    console.log('FAILED');
    log(`${name} FAILED: ${error.stack || error.message}`);
    throw error;
  }
}

function gitStatus() {
  return capture('git', ['status', '--porcelain']);
}

function closePackagedSarah() {
  if (!fs.existsSync(exePath)) return;
  const escaped = exePath.replaceAll("'", "''");
  const ps = [
    `$target='${escaped}'`,
    `$all=@(Get-CimInstance Win32_Process -Filter \"Name = 'Sarah.exe'\" | Where-Object { $_.ExecutablePath -eq $target })`,
    `if (-not $all) { exit 0 }`,
    `Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`,
    `Start-Process -FilePath $target -ArgumentList '--sarah-release-quit' -WindowStyle Hidden`,
    `Start-Sleep -Milliseconds 500`,
    `$main=$all | Where-Object { $_.CommandLine -notmatch ' --type=' } | Select-Object -First 1`,
    `$deadline=(Get-Date).AddSeconds(15)`,
    `do { Start-Sleep -Milliseconds 250; $left=@(Get-CimInstance Win32_Process -Filter \"Name = 'Sarah.exe'\" | Where-Object { $_.ExecutablePath -eq $target }) } while ($left -and (Get-Date) -lt $deadline)`,
    `if ($left -and $main) { & taskkill.exe /PID $main.ProcessId /T /F | Out-Null; Start-Sleep -Milliseconds 500 }`,
    `$left=@(Get-CimInstance Win32_Process -Filter \"Name = 'Sarah.exe'\" | Where-Object { $_.ExecutablePath -eq $target })`,
    `if ($left) { Write-Error 'Packaged Sarah could not be stopped.'; exit 3 }`,
  ].join('; ');
  capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
}

function androidSdkRoot() {
  const localProperties = path.join(root, 'android', 'local.properties');
  if (fs.existsSync(localProperties)) {
    const match = fs.readFileSync(localProperties, 'utf8').match(/^sdk\.dir=(.+)$/m);
    if (match) return match[1].trim().replaceAll('\\:', ':').replaceAll('\\\\', '\\');
  }
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
}

function androidTools() {
  const sdk = androidSdkRoot();
  const buildToolsRoot = path.join(sdk, 'build-tools');
  const versions = fs.readdirSync(buildToolsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  if (!versions.length) throw new Error('Android build-tools were not found.');
  return {
    apksigner: path.join(buildToolsRoot, versions[0], 'apksigner.bat'),
    apkanalyzer: path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'apkanalyzer.bat'),
  };
}

function signerDigest(apksigner, apk) {
  if (!fs.existsSync(apk)) return '';
  const output = capture(apksigner, ['verify', '--print-certs', apk], { env: javaEnvironment() });
  return output.match(/(?:Signer #1|V\d+ Signer): certificate SHA-256 digest:\s*([a-f0-9]+)/i)?.[1]?.toLowerCase() || '';
}

function fileDigest(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function assertDistCopied(target) {
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  for (const source of walk(path.join(root, 'dist'))) {
    const relative = path.relative(path.join(root, 'dist'), source);
    const copied = path.join(target, relative);
    if (!fs.existsSync(copied) || fileDigest(source) !== fileDigest(copied)) throw new Error(`Vite dist mismatch: ${copied}`);
  }
}

function assertRootRelativeWebShell() {
  const html = fs.readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
  const relativeShellReference = /(?:src|href)=["']\.\/(?:assets|manifest\.json|icons|browserconfig\.xml)/i.exec(html);
  if (relativeShellReference) {
    throw new Error(`Vite emitted a deep-route-unsafe shell reference: ${relativeShellReference[0]}`);
  }
  if (!/(?:src|href)=["']\/(?:assets|manifest\.json|icons|browserconfig\.xml)/i.test(html)) {
    throw new Error('Vite shell does not contain root-relative application assets.');
  }
}

async function waitForHealth(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const data = await response.json();
      if (response.ok && data?.ok && data?.app === 'Sarah Local API') return data;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Sarah API did not become healthy: ${lastError?.message || url}`);
}

function launchSarah() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exePath, [], { cwd: path.dirname(exePath), env, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

async function main() {
  const gitRoot = path.resolve(capture('git', ['rev-parse', '--show-toplevel']));
  if (gitRoot.toLowerCase() !== root.toLowerCase()) throw new Error(`Wrong repository; expected ${root}.`);
  const origin = capture('git', ['remote', 'get-url', 'origin']);
  if (!/github\.com[/:]PulsePointLabs\/Sarah\.git$/i.test(origin)) throw new Error(`Wrong origin: ${origin}`);
  if (capture('git', ['branch', '--show-current']) !== 'main') throw new Error('Release must run from main.');

  await stage('Process preflight', async () => closePackagedSarah());
  const initialStatus = gitStatus();
  if (initialStatus && !commitMessage) throw new Error('Working tree has source changes; pass --commit-message "...".');

  await stage('Focused lint/tests', async () => {
    await run('npm', ['run', 'lint', '--silent']);
    await run('npm', ['run', 'test:engine', '--silent']);
  });

  if (initialStatus) {
    await stage('Source commit', async () => {
      await run('git', ['add', '--all']);
      await run('git', ['commit', '-m', commitMessage]);
    });
  }
  const sourceCommit = capture('git', ['rev-parse', '--short', 'HEAD']);

  await stage('Provenance', async () => run('node', ['scripts/write-build-info.mjs']));
  await stage('Vite', async () => run('npx', ['vite', 'build']));
  await stage('Web shell validation', async () => assertRootRelativeWebShell());

  const { apksigner, apkanalyzer } = androidTools();
  const previousSigner = signerDigest(apksigner, apkPath);
  await stage('Android copy/build', async () => {
    await run('npx', ['cap', 'copy', 'android']);
    const env = javaEnvironment();
    await run('gradlew.bat', ['assembleDebug', '--console=plain'], { cwd: path.join(root, 'android'), env });
  });
  await stage('Windows package', async () => run('npm', ['run', 'desktop:pack', '--silent']));

  await stage('Artifact validation', async () => {
    if (!fs.existsSync(apkPath) || !fs.existsSync(exePath)) throw new Error('Expected APK or EXE is missing.');
    const appIdOutput = capture(apkanalyzer, ['manifest', 'application-id', apkPath], { env: javaEnvironment() });
    const versionOutput = capture(apkanalyzer, ['manifest', 'version-name', apkPath], { env: javaEnvironment() });
    const appId = appIdOutput.split(/\r?\n/).map((line) => line.trim()).find((line) => line === 'com.pulsepointlabs.sarah') || '';
    const apkVersion = versionOutput.split(/\r?\n/).map((line) => line.trim()).find((line) => line === version) || '';
    if (appId !== 'com.pulsepointlabs.sarah') throw new Error(`Unexpected APK package: ${appId}`);
    if (apkVersion !== version) throw new Error(`Unexpected APK version: ${apkVersion}`);
    const currentSigner = signerDigest(apksigner, apkPath);
    if (!currentSigner) throw new Error('APK signer certificate was not reported.');
    if (previousSigner && previousSigner !== currentSigner) throw new Error('APK signing identity changed.');

    const psPath = exePath.replaceAll("'", "''");
    const exeInfo = JSON.parse(capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item '${psPath}').VersionInfo | Select-Object FileDescription,ProductName,FileVersion,ProductVersion | ConvertTo-Json -Compress`]));
    const packagedManifest = JSON.parse(fs.readFileSync(path.join(root, 'desktop-release', 'win-unpacked', 'resources', 'app', 'package.json'), 'utf8'));
    if (path.basename(exePath) !== 'Sarah.exe' || packagedManifest?.build?.productName !== 'Sarah') throw new Error('Windows package identity is incorrect.');
    if (String(packagedManifest.version) !== version) throw new Error(`Windows package version is incorrect: ${packagedManifest.version}`);
    const brandedSarah = exeInfo.FileDescription === 'Sarah' && exeInfo.ProductName === 'Sarah';
    const pristineElectronShell = exeInfo.FileDescription === 'Electron' && exeInfo.ProductName === 'Electron';
    if (!brandedSarah && !pristineElectronShell) throw new Error('Windows executable metadata is unrecognized.');
    if (brandedSarah && !String(exeInfo.FileVersion).startsWith(`${version}.0`)) throw new Error(`EXE version is incorrect: ${exeInfo.FileVersion}`);
    assertDistCopied(windowsDist);
    assertDistCopied(androidAssets);

    const builtText = fs.readdirSync(windowsDist, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.js$/.test(entry.name))
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
      .join('\n');
    if (!builtText.includes(sourceCommit) || !builtText.includes(version)) throw new Error('Packaged frontend provenance does not identify the source commit/version.');
  });

  if (gitStatus()) {
    await stage('Provenance commit', async () => {
      await run('git', ['add', 'src/generated/buildInfo.js']);
      await run('git', ['commit', '-m', `Record packaged v${version} build provenance`]);
    });
  }

  if (shouldPush) await stage('Push', async () => run('git', ['push', 'origin', 'main']));
  if (shouldPublish) {
    await stage('GitHub release', async () => {
      const artifactDir = path.join(root, 'release-artifacts');
      const releaseApk = path.join(artifactDir, `Sarah-v${version}.apk`);
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.copyFileSync(apkPath, releaseApk);
      await run('gh', ['release', 'create', `v${version}`, releaseApk, '--repo', 'PulsePointLabs/Sarah', '--title', `Sarah v${version}`, '--generate-notes']);
    });
  }

  await stage('Sarah restart/runtime', async () => {
    launchSarah();
    await waitForHealth('http://127.0.0.1:8787/api/health');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const escaped = exePath.replaceAll("'", "''");
    const count = Number(capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$target='${escaped}'; @((Get-CimInstance Win32_Process -Filter \"Name = 'Sarah.exe'\" | Where-Object { $_.ExecutablePath -eq $target -and $_.CommandLine -notmatch ' --type=' })).Count`]));
    if (count < 1) throw new Error('Sarah did not stay running.');
  });

  if (gitStatus()) throw new Error(`Working tree is not clean after release:\n${gitStatus()}`);
  const total = (Date.now() - startedAt) / 1000;
  console.log(`\nRelease workflow complete for v${version} (${sourceCommit})`);
  console.log(`Vite ${timings.get('Vite')?.toFixed(1)}s | Android ${timings.get('Android copy/build')?.toFixed(1)}s | Windows ${timings.get('Windows package')?.toFixed(1)}s | Total ${total.toFixed(1)}s`);
  console.log(`APK SHA256 ${fileDigest(apkPath)}`);
  console.log(`Log ${logPath}`);
}

main().catch((error) => {
  console.error(`\nRelease failed: ${error.message}`);
  console.error(`Full log: ${logPath}`);
  process.exitCode = 1;
}).finally(() => fs.closeSync(logFd));
