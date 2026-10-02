import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const helperDir = fileURLToPath(new URL('../../tools/capture/emg/', import.meta.url));
export function createEmgHelper(config, dependencies = {}) {
  const execute = dependencies.exec || exec;
  const launch = dependencies.spawn || spawn;
  const basePython = process.env.EMG_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  const venv = path.join(config.emgTextDir, 'python');
  const venvPython = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const stopFile = path.join(config.emgTextDir, 'emg_stop');
  const heartbeatFile = path.join(config.emgTextDir, 'emg_owner');
  let child = null, busy = false;
  let heartbeat = null;
  let retryTimer = null, desired = null, installed = null, probeAt = 0, probePromise = null;
  const profileFile = path.join(config.emgTextDir, 'emg_profile.json');
  const defaults = { names: ['Sensor 1', 'Sensor 2'], notes: ['', ''], channels: 2, configured: false };
  let state = { running: false, channels: 2, port: '', error: null, message: 'Connect your Arduino to the desktop.' };
  const python = async () => { try { await fs.access(venvPython); return venvPython; } catch { return basePython; } };
  const run = async (args, timeout = 15000) => execute(await python(), args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 });
  const friendly = error => /No module named/.test(error.message) ? 'EMG dependencies are missing. Use Install helper below.' : /ENOENT/.test(error.message) ? 'Python was not found on the desktop. Install Python, then refresh.' : error.message.slice(0, 700);
  return {
    status: () => ({ ...state, busy }),
    async profile() {
      try { return { ...defaults, ...JSON.parse(await fs.readFile(profileFile, 'utf8')), configured: true }; }
      catch { return { ...defaults }; }
    },
    async saveProfile(profile) {
      const old = await this.profile();
      const next = { ...old, configured: true, names: [0,1].map(i => String(profile.names?.[i] || old.names[i]).trim().slice(0,60) || `Sensor ${i+1}`),
        notes: [0,1].map(i => String(profile.notes?.[i] ?? old.notes[i]).slice(0,500)),
        channels: [1,2].includes(Number(profile.channels)) ? Number(profile.channels) : old.channels,
        lastPort: String(profile.lastPort ?? old.lastPort ?? '').slice(0,100) };
      await fs.mkdir(config.emgTextDir, { recursive: true });
      const temporary = profileFile + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(next));
      await fs.rename(temporary, profileFile);
      return next;
    },
    async inspect() {
      if (!busy && !probePromise && (installed === null || Date.now()-probeAt > 30000)) {
        probeAt = Date.now();
        probePromise = run(['-c', 'import serial, matplotlib, obsws_python']).then(() => { installed = true; }, () => { installed = false; }).finally(() => { probePromise = null; });
      }
      if (probePromise) await probePromise;
      let setup = null;
      try { setup = JSON.parse(await fs.readFile(path.join(config.emgTextDir, 'emg_setup_status.json'), 'utf8')); } catch { /* Not started yet. */ }
      const fresh = state.running && setup?.measured_at != null && Date.now()-setup.measured_at*1000 < 1500;
      return { ...this.status(), installed, receiving: !!fresh, setup: setup ? {...setup, fresh:!!fresh} : null, profile: await this.profile() };
    },
    async ports() {
      try {
        const { stdout } = await run(['-c', 'import json; from serial.tools import list_ports; print(json.dumps([{"port":p.device,"label":p.description,"serialNumber":p.serial_number,"vid":p.vid,"pid":p.pid} for p in list_ports.comports()]))']);
        return { ...this.status(), ports: JSON.parse(stdout), error: null };
      } catch (e) { return { ports: [], ...this.status(), error: friendly(e) }; }
    },
    async install() {
      if (busy || child) throw new Error('Stop the EMG helper before installing.');
      busy = true;
      try {
        await fs.mkdir(config.emgTextDir, { recursive: true });
        await execute(basePython, ['-m', 'venv', venv], { windowsHide: true, timeout: 60000 });
        await execute(venvPython, ['-m', 'pip', 'install', '-r', path.join(helperDir, 'requirements.txt')], { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
        state.error = null; state.message = 'Helper installed. Refresh ports to connect.';
        installed = true; probeAt = Date.now();
      } catch (e) { state.error = friendly(e); throw new Error(state.error); }
      finally { busy = false; }
      return this.status();
    },
    async start({ port, channels = 2 }) {
      if (busy) throw new Error('EMG helper is busy.');
      if (child) {
        if (state.port === port && state.channels === Number(channels)) return this.status();
        throw new Error('Disconnect before changing port or sensor count.');
      }
      busy = true;
      try {
        const available = await this.ports();
        if (available.error) throw new Error(available.error);
        if (!available.ports.some(item => item.port === port)) throw new Error('Arduino port is unavailable. Plug it in and refresh.');
        if (![1, 2].includes(Number(channels))) throw new Error('Choose one or two sensors.');
        await fs.mkdir(config.emgTextDir, { recursive: true });
        await fs.mkdir(config.emgSessionsDir, { recursive: true });
        await fs.rm(stopFile, { force: true });
        await fs.writeFile(heartbeatFile, 'alive');
        await fs.rm(path.join(config.emgTextDir, 'emg_command.json'), { force: true });
        await fs.rm(path.join(config.emgTextDir, 'emg_setup_status.json'), { force: true });
        await fs.rm(path.join(config.emgTextDir, 'emg_command_status.json'), { force: true });
        const device = available.ports.find(item => item.port === port);
        desired = { port, channels: Number(channels), serialNumber: device.serialNumber, vid: device.vid, pid: device.pid };
        await this.saveProfile({ ...(await this.profile()), channels: Number(channels), lastPort:port });
        clearTimeout(retryTimer);
        const obs = new URL(config.hrObsWsUrl);
        const env = { ...process.env, EMG_SERIAL_PORT: port, EMG_SERIAL_BAUD: '115200', EMG_HEADLESS: '1', MPLBACKEND: 'Agg',
          EMG_ACCEPT_DUAL: '1', EMG_STOP_FILE: stopFile, EMG_HEARTBEAT_FILE: heartbeatFile, EMG_SESSIONS_DIR: config.emgSessionsDir,
          OBS_HOST: obs.hostname, OBS_PORT: obs.port || '4455', OBS_PASSWORD: config.hrObsPassword,
          EMG_SINGLE_CAL_FILE: path.join(config.emgTextDir, 'emg_calibration_single.json'),
          EMG_DUAL_CAL_FILE: path.join(config.emgTextDir, 'emg_calibration_dual_simple.json') };
        for (const [key, file] of Object.entries({ LEVEL: 'emg_level.txt', LEFT: 'emg_left.txt', RIGHT: 'emg_right.txt', DIFF: 'emg_diff.txt' })) env[`EMG_${key}_TEXT_PATH`] = path.join(config.emgTextDir, file);
        child = launch(await python(), ['-u', path.join(helperDir, Number(channels) === 2 ? 'emg_dual_obs.py' : 'emg_single.py')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        state = { running: true, port, channels: Number(channels), error: null, message: 'Opening Arduino; waiting for live samples.' };
        child.stderr.on('data', data => { state.error = /PermissionError|Access is denied|resource busy/i.test(String(data)) ? 'Arduino port is busy. Close Serial Monitor or another EMG helper, then reconnect.' : String(data).slice(-700); });
        heartbeat = setInterval(() => { fs.writeFile(heartbeatFile, 'alive').catch(() => {}); }, 3000);
        heartbeat.unref?.();
        child.on('error', error => { clearInterval(heartbeat); state.error = friendly(error); state.running = false; child = null; if(desired)this.scheduleReconnect(); });
        child.on('exit', code => { clearInterval(heartbeat); child = null; state.running = false; state.message = desired ? 'Connection lost. Waiting for the same Arduino; calibration must be repeated.' : 'EMG helper stopped.'; if (code && !state.error) state.error = `EMG helper exited (${code}).`; if (desired) this.scheduleReconnect(); });
        // Drain stdout without retaining physiological readings or file paths.
        child.stdout.on('data', data => {
          if (String(data).includes('OBS connection failed:')) state.message = 'EMG is running; OBS is unavailable. Live signals work; CSV waits for OBS.';
        });
        return this.status();
      } finally { busy = false; }
    },
    scheduleReconnect() {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(async () => {
        if (!desired || child || busy) return;
        const wanted = desired;
        try {
          const found = (await this.ports()).ports.find(p => wanted.serialNumber ? p.serialNumber === wanted.serialNumber && p.vid === wanted.vid && p.pid === wanted.pid : p.port === wanted.port && p.vid === wanted.vid && p.pid === wanted.pid);
          if (desired !== wanted) return;
          if (found) await this.start({ port: found.port, channels: wanted.channels });
          else this.scheduleReconnect();
        } catch { if (desired) this.scheduleReconnect(); }
      }, 3000);
      retryTimer.unref?.();
    },
    async stop() {
      desired = null; clearTimeout(retryTimer);
      if (child) { await fs.writeFile(stopFile, 'stop'); state.message = 'Stopping and closing the current CSV…'; }
      return this.status();
    },
  };
}
