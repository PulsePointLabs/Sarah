const { app, BrowserWindow, dialog, shell, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const APP_NAME = 'Sarah';
const STARTUP_TIMEOUT_MS = 45000;
const PREFERRED_BACKEND_PORT = 8787;
const PREFERRED_HR_RELAY_PORT = 8765;

app.setName(APP_NAME);
app.commandLine.appendSwitch('enable-web-bluetooth');

let mainWindow = null;
let backendProcess = null;
let backendUrl = '';
let shutdownStarted = false;
let bluetoothSelection = null;

function appRoot() {
  return app.getAppPath();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function desktopLog(message) {
  try {
    const logDir = ensureDir(path.join(app.getPath('userData'), 'logs'));
    fs.appendFileSync(path.join(logDir, 'desktop.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging should never block app startup or Bluetooth pairing.
  }
}

function existingDir(dir) {
  return fs.existsSync(dir) ? dir : null;
}

function parseDotEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  const parsed = {};
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) continue;
    const key = line.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadDesktopEnv(projectRoot) {
  const candidates = [
    projectRoot && path.join(projectRoot, '.env'),
    path.join(appRoot(), '.env'),
    path.join(process.cwd(), '.env'),
  ].filter(Boolean);
  const env = {};
  for (const candidate of candidates) {
    Object.assign(env, parseDotEnvFile(candidate));
  }
  return env;
}

function findProjectDataRoot() {
  const explicitRoot = process.env.SARAH_PROJECT_ROOT;
  const candidates = [
    explicitRoot,
    appRoot(),
    path.resolve(process.resourcesPath || '', '..', '..', '..'),
    path.resolve(appRoot(), '..', '..', '..', '..'),
    process.cwd(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const dbPath = path.join(resolved, 'data', 'pulsepoint.sqlite');
    if (fs.existsSync(dbPath)) return resolved;
  }

  return null;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error('Could not allocate a local backend port.'));
      });
    });
    server.on('error', reject);
  });
}

function canUsePort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '::', () => {
      server.close(() => resolve(true));
    });
  });
}

async function findPort(preferredPort, blockedPorts = new Set()) {
  if (preferredPort && !blockedPorts.has(preferredPort) && await canUsePort(preferredPort)) {
    return preferredPort;
  }
  for (;;) {
    const port = await findFreePort();
    if (!blockedPorts.has(port)) return port;
  }
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${url} returned ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({ raw: body });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2500, () => {
      req.destroy(new Error(`Timed out waiting for ${url}`));
    });
  });
}

function bluetoothDeviceLabel(device) {
  return String(device?.deviceName || device?.name || '').trim();
}

function isPreferredHeartRateDevice(device) {
  const label = bluetoothDeviceLabel(device);
  return /polar\s+h10/i.test(label) || /\bh10\b/i.test(label) || /heart.?rate/i.test(label);
}

function resetBluetoothSelection() {
  if (bluetoothSelection?.timer) clearTimeout(bluetoothSelection.timer);
  bluetoothSelection = null;
}

function finishBluetoothSelection(deviceId = '') {
  if (!bluetoothSelection || bluetoothSelection.done) return;
  bluetoothSelection.done = true;
  const callback = bluetoothSelection.callback;
  resetBluetoothSelection();
  desktopLog(deviceId ? `Selected Bluetooth device ${deviceId}` : 'Bluetooth scan ended without a selected H10 device');
  callback(deviceId);
}

function configureDesktopPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionCheckHandler((_webContents, permission) => {
    if (['fullscreen', 'media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission)) return true;
    return false;
  });
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['fullscreen', 'media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  ses.setBluetoothPairingHandler((details, callback) => {
    if (details.pairingKind === 'confirm' || details.pairingKind === 'confirmPin') {
      callback({ confirmed: true });
      return;
    }
    callback({ confirmed: false });
  });
}

function configureBluetoothSelection(win) {
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    desktopLog(`Bluetooth scan devices: ${devices.map((device) => bluetoothDeviceLabel(device) || device.deviceId).join(', ') || '(none)'}`);

    if (!bluetoothSelection || bluetoothSelection.done) {
      bluetoothSelection = {
        callback,
        done: false,
        timer: setTimeout(() => finishBluetoothSelection(''), 12000),
      };
    }

    const preferred = devices.find(isPreferredHeartRateDevice);
    if (preferred?.deviceId) {
      finishBluetoothSelection(preferred.deviceId);
    }
  });
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const health = await requestJson(`${baseUrl}/api/health`);
      if (health && health.ok) return health;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(lastError?.message || 'Sarah backend did not become ready in time.');
}

function backendEnv(port, hrRelayPort) {
  const userData = app.getPath('userData');
  const projectRoot = findProjectDataRoot();
  const dotenvEnv = loadDesktopEnv(projectRoot);
  const baseDataDir = projectRoot ? path.join(projectRoot, 'data') : path.join(userData, 'data');
  const dataDir = ensureDir(baseDataDir);
  const uploadDir = ensureDir(existingDir(path.join(dataDir, 'uploads')) || path.join(dataDir, 'uploads'));
  const ttsDir = ensureDir(path.join(dataDir, 'tts-render-work'));
  const hrDir = ensureDir(existingDir(path.join(dataDir, 'heart-rate-recordings')) || path.join(userData, 'HeartRate', 'recordings'));
  const emgBase = projectRoot ? projectRoot : userData;
  const emgDir = ensureDir(existingDir(path.join(emgBase, 'EMG')) || path.join(userData, 'EMG'));
  const emgSessionsDir = ensureDir(path.join(emgDir, 'emg_sessions'));
  const databasePath = projectRoot
    ? path.join(dataDir, 'pulsepoint.sqlite')
    : path.join(dataDir, 'sarah.sqlite');

  return {
    ...process.env,
    ...dotenvEnv,
    SARAH_DESKTOP: '1',
    SARAH_SERVE_STATIC: '1',
    PORT: String(port),
    HR_CAPTURE_RELAY_PORT: String(hrRelayPort),
    HR_CAPTURE_WS_URL: `ws://127.0.0.1:${hrRelayPort}`,
    DATA_DIR: dataDir,
    UPLOAD_DIR: uploadDir,
    TTS_RENDER_DIR: ttsDir,
    DATABASE_PATH: databasePath,
    SARAH_PROJECT_ROOT: projectRoot || '',
    HR_RECORDINGS_DIR: hrDir,
    EMG_TEXT_DIR: process.env.EMG_TEXT_DIR || emgDir,
    EMG_SESSIONS_DIR: process.env.EMG_SESSIONS_DIR || emgSessionsDir,
  };
}

function nodeRuntimePath() {
  if (process.env.SARAH_NODE_RUNTIME) return process.env.SARAH_NODE_RUNTIME;
  if (!app.isPackaged && process.env.npm_node_execpath) return process.env.npm_node_execpath;
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  }
  return process.execPath;
}

async function startBackend() {
  const port = await findPort(PREFERRED_BACKEND_PORT);
  const hrRelayPort = await findPort(PREFERRED_HR_RELAY_PORT, new Set([port]));
  backendUrl = `http://127.0.0.1:${port}`;
  const serverEntry = path.join(appRoot(), 'server', 'index.js');
  const logDir = ensureDir(path.join(app.getPath('userData'), 'logs'));
  const out = fs.openSync(path.join(logDir, 'backend.out.log'), 'a');
  const err = fs.openSync(path.join(logDir, 'backend.err.log'), 'a');

  const nodeRuntime = nodeRuntimePath();
  backendProcess = spawn(nodeRuntime, [serverEntry], {
    cwd: appRoot(),
    env: backendEnv(port, hrRelayPort),
    windowsHide: true,
    stdio: ['ignore', out, err],
  });

  backendProcess.on('exit', (code, signal) => {
    if (!shutdownStarted && mainWindow) {
      mainWindow.webContents.send('backend-exit', { code, signal });
    }
  });

  await waitForHealth(backendUrl);
  return backendUrl;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: APP_NAME,
    backgroundColor: '#10161f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  configureBluetoothSelection(mainWindow);

  return mainWindow;
}

async function stopBackend() {
  shutdownStarted = true;
  if (!backendProcess || backendProcess.killed) return;
  const child = backendProcess;
  backendProcess = null;

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (!child.killed) child.kill('SIGKILL');
      } catch {}
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

app.whenReady().then(async () => {
  configureDesktopPermissions();
  const win = createWindow();
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <body style="margin:0;background:#f8f2fb;color:#291b34;font:16px system-ui;display:grid;place-items:center;height:100vh">
      <main style="display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center">
        <img src="file://${path.join(app.getAppPath(), 'dist', 'icons', 'sarah-192.png').replace(/\\/g, '/')}" alt="Sarah" style="width:86px;height:86px;border-radius:24px;box-shadow:0 18px 42px rgba(124,58,237,.22)" />
        <div style="font-size:30px;font-weight:800;letter-spacing:-.03em">Sarah</div>
        <div style="color:#6d5b78;font-size:14px;font-weight:600">Starting local engine...</div>
      </main>
    </body>
  `)}`);

  try {
    const url = await startBackend();
    await win.loadURL(url);
  } catch (error) {
    const message = error?.message || String(error);
    dialog.showErrorBox('Sarah backend failed to start', message);
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<body style="margin:0;background:#10161f;color:#f8f4ff;font:16px system-ui;padding:32px"><h1>Sarah could not start the local backend</h1><p>${message.replace(/[<>&]/g, '')}</p><p>Check the backend logs in ${app.getPath('userData')}\\logs.</p></body>`)}`);
  }
});

app.on('before-quit', () => {
  shutdownStarted = true;
});

app.on('window-all-closed', async () => {
  await stopBackend();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && backendUrl) {
    const win = createWindow();
    win.loadURL(backendUrl);
  }
});
