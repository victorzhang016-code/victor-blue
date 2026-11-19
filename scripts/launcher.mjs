import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const themeDirectory = join(here, '..', 'theme');
const mainPage = 'app://-/index.html';

export function isMainRenderer(target) {
  return target.type === 'page' && target.url === mainPage;
}

export async function locateApp() {
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation",
    ], { timeout: 10000, windowsHide: true });
    const install = stdout.trim();
    if (!install) throw new Error('Install the official Codex app from Microsoft Store first.');
    const exe = join(install, 'app', 'ChatGPT.exe');
    if (!existsSync(exe)) throw new Error('This Codex Store package has an unfamiliar executable layout.');
    return { exe };
  }
  if (process.platform === 'darwin') {
    for (const directory of ['/Applications', join(homedir(), 'Applications')]) {
      for (const name of ['ChatGPT.app', 'Codex.app']) {
        const bundle = join(directory, name);
        const plist = join(bundle, 'Contents', 'Info.plist');
        if (!existsSync(plist)) continue;
        const get = async field => (await run('/usr/bin/plutil',
          ['-extract', field, 'raw', '-o', '-', plist], { timeout: 4000 })).stdout.trim();
        if (await get('CFBundleIdentifier') !== 'com.openai.codex') continue;
        const nameOnDisk = await get('CFBundleExecutable');
        if (!['ChatGPT', 'Codex'].includes(nameOnDisk)) continue;
        const exe = join(bundle, 'Contents', 'MacOS', nameOnDisk);
        if (existsSync(exe)) return { exe };
      }
    }
    throw new Error('Put the official Codex desktop app in Applications before opening Victor Blue.');
  }
  throw new Error('Victor Blue currently supports Windows x64 and macOS.');
}

export async function appIsRunning(app) {
  if (process.platform === 'win32') {
    const script = [
      "$pkg = (Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1).InstallLocation;",
      "$apps = @(Get-CimInstance Win32_Process -Filter \"Name='ChatGPT.exe'\" -ErrorAction Stop | Where-Object {",
      "$_.ExecutablePath -and $_.ExecutablePath.StartsWith($pkg,[StringComparison]::OrdinalIgnoreCase) -and",
      "(!$_.CommandLine -or !$_.CommandLine.Contains('--type=')) });",
      "$apps.Count",
    ].join(' ');
    const { stdout } = await run('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script],
      { timeout: 10000, windowsHide: true });
    if (!/^\d+$/.test(stdout.trim())) throw new Error('Could not determine whether Codex is already running.');
    return Number(stdout.trim()) > 0;
  }
  const { stdout } = await run('/bin/ps', ['-axww','-o','comm=']);
  return stdout.split('\n').some(line => line.trim() === app.exe);
}

export function parseEndpoint(value) {
  const [rawPort, browser] = value.trim().split(/\r?\n/);
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort || '') || port < 1 || port > 65535 ||
      !/^\/devtools\/browser\/[0-9a-f-]{36}$/i.test(browser || '')) {
    throw new Error('The app did not publish a recognized local debugger endpoint.');
  }
  return 'ws://127.0.0.1:' + port + browser;
}

export async function openCdp(url) {
  const socket = new WebSocket(url);
  try {
    await new Promise((ready, fail) => {
      const reject = () => { clearTimeout(timer); fail(new Error('Local connection failed.')); };
      const timer = setTimeout(reject, 2500);
      socket.addEventListener('open', () => { clearTimeout(timer); ready(); }, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const handler = pending.get(message.id);
    if (handler) handler(message);
  });
  socket.addEventListener('close', () => {
    for (const complete of pending.values()) complete({error:{message:'The local connection closed.'}});
  });
  return {
    close: () => socket.close(),
    call(method, params = {}, sessionId) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('The local connection closed.'));
      const current = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(current);
          reject(new Error(method + ' timed out.'));
        }, 4500);
        pending.set(current, message => {
          clearTimeout(timer);
          pending.delete(current);
          if (message.error) reject(new Error(method + ': ' + message.error.message));
          else resolve(message.result ?? {});
        });
        socket.send(JSON.stringify({id: current, method, params, sessionId}));
      });
    },
  };
}

export async function loadTheme(platform = process.platform) {
  const base = await readFile(join(themeDirectory, 'victor-blue.css'), 'utf8');
  return platform === 'darwin'
    ? base + '\n' + await readFile(join(themeDirectory, 'macos.css'), 'utf8')
    : base;
}

const revisionProperty = '--victor-blue-release-revision';
export class Renderer {
  constructor(client) { this.client = client; }
  async apply(css) {
    const { targetInfos } = await this.client.call('Target.getTargets');
    const matches = targetInfos.filter(isMainRenderer);
    if (matches.length !== 1) return false;
    const { targetId } = matches[0];
    if (this.target !== targetId) {
      const result = await this.client.call('Target.attachToTarget', {targetId, flatten:true});
      this.session = result.sessionId;
      await this.call('DOM.enable');
      await this.call('CSS.enable');
      this.target = targetId;
      this.sheet = undefined;
    }
    const revision = 'rev-' + createHash('sha256').update(css).digest('hex').slice(0,16);
    if (await this.currentRevision() === revision) return true;
    const { frameTree } = await this.call('Page.getFrameTree');
    if (frameTree.frame.url !== mainPage) return false;
    const text = css + '\n:root { ' + revisionProperty + ': ' + revision + '; }\n';
    if (this.sheet) {
      try { await this.call('CSS.setStyleSheetText', {styleSheetId:this.sheet, text}); }
      catch { this.sheet = undefined; }
    }
    if (!this.sheet) {
      const result = await this.call('CSS.createStyleSheet', {frameId:frameTree.frame.id});
      this.sheet = result.styleSheetId;
      await this.call('CSS.setStyleSheetText', {styleSheetId:this.sheet, text});
    }
    return await this.currentRevision() === revision;
  }
  call(method, params) { return this.client.call(method, params, this.session); }
  async currentRevision() {
    const { result } = await this.call('Runtime.evaluate', {
      expression: "getComputedStyle(document.documentElement).getPropertyValue('--victor-blue-release-revision').trim()",
      returnByValue: true,
    });
    return result?.value;
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function acquireLock(root) {
  const directory = join(root, 'launcher-lock');
  const owner = join(directory, 'pid');
  const claim = async () => {
    await mkdir(directory);
    await writeFile(owner, String(process.pid), {flag:'wx'});
  };
  try { await claim(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const repair = join(root, 'launcher-lock-repair');
    try { await mkdir(repair); }
    catch (conflict) {
      if (conflict.code === 'EEXIST') throw new Error('Another Victor Blue launcher is starting.');
      throw conflict;
    }
    try {
      let pid;
      try { pid = Number(await readFile(owner,'utf8')); }
      catch (failure) {
        if (failure.code === 'ENOENT') throw new Error('Another Victor Blue launcher is starting.');
        throw failure;
      }
      if (isAlive(pid)) throw new Error('Victor Blue is already running. Switch to its Codex window.');
      await unlink(owner);
      await rmdir(directory);
      await claim();
    } finally {
      await rmdir(repair);
    }
  }
  return async () => {
    await unlink(owner);
    await rmdir(directory);
  };
}

export async function startOfficialApp(app, profile, dataHome) {
  await mkdir(profile, {recursive:true});
  const endpointFile = join(profile, 'DevToolsActivePort');
  let previous;
  try { previous = (await stat(endpointFile)).mtimeMs; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const child = spawn(app.exe, [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
  ], {
    cwd: dirname(app.exe),
    env: {...process.env, CODEX_HOME:dataHome, CODEX_ELECTRON_USER_DATA_PATH:profile},
    windowsHide: true,
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const running = () => child.exitCode === null && child.signalCode === null;
  const deadline = Date.now() + 20000;
  while (running() && Date.now() < deadline) {
    try {
      const current = await stat(endpointFile);
      if (current.mtimeMs !== previous) {
        const address = parseEndpoint(await readFile(endpointFile, 'utf8'));
        return { child, running, address };
      }
    } catch (error) {
      // Chromium can expose the file before the final browser path has been written.
      if (error.code && error.code !== 'ENOENT') throw error;
    }
    await delay(300);
  }
  return { child, running };
}

async function launch() {
  const app = await locateApp();
  const dataHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  if (!existsSync(dataHome)) {
    throw new Error('Open the regular Codex app once to initialize its local data, then fully quit it.');
  }
  const parent = process.platform === 'win32'
    ? process.env.LOCALAPPDATA
    : join(homedir(), 'Library', 'Application Support');
  if (!parent) throw new Error('Local application data folder is unavailable.');
  const root = join(parent, 'VictorBlue');
  await mkdir(root, {recursive:true});
  const unlock = await acquireLock(root);
  let client;
  try {
    if (await appIsRunning(app)) {
      throw new Error('Fully quit the existing Codex app before opening Victor Blue. On Windows, use Quit from the tray if closing the window leaves it running.');
    }
    const css = await loadTheme();
    const instance = await startOfficialApp(app, join(root, 'profile'), dataHome);
    if (!instance.address) throw new Error('Codex did not open a supported local theme connection. Quit it before trying again.');
    const deadline = Date.now() + 25000;
    let attached = false;
    let renderer;
    while (instance.running()) {
      try {
        if (!client) { client = await openCdp(instance.address); renderer = new Renderer(client); }
        const applied = await renderer.apply(css);
        if (applied && !attached) console.log('Victor Blue is on. Quit Codex completely to end this session.');
        attached ||= applied;
      } catch (error) {
        client?.close();
        client = undefined;
        if (instance.running() && !attached && Date.now() >= deadline) throw error;
      }
      if (!attached && Date.now() >= deadline) {
        throw new Error('No unique Codex main window could be themed. The app remains available normally.');
      }
      await delay(1300);
    }
  } finally {
    client?.close();
    await unlock();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await launch(); }
  catch (error) {
    console.error('Victor Blue: ' + error.message);
    process.exitCode = 1;
  }
}
