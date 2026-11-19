import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { appIsRunning, loadTheme, locateApp, openCdp, Renderer, startOfficialApp } from '../scripts/launcher.mjs';

if (process.platform !== 'win32') throw new Error('This live smoke test requires Windows Store Codex.');
const app = await locateApp();
const alreadyRunning = await appIsRunning(app);
const root = await mkdtemp(join(tmpdir(),'victor-blue-smoke-'));
const data = join(root,'sessions');
await mkdir(data);
for (const key of ['CODEX_ACCESS_TOKEN','OPENAI_API_KEY','CODEX_THREAD_ID','CODEX_SESSION_ID']) delete process.env[key];
const instance = await startOfficialApp(app,join(root,'profile'),data);
let cdp;
try {
  assert.ok(instance.address,'Fresh isolated profile did not open the loopback endpoint.');
  cdp = await openCdp(instance.address);
  const renderer = new Renderer(cdp);
  const css = await loadTheme('win32');
  const deadline = Date.now()+18000;
  let ready = false;
  while (instance.running() && Date.now()<deadline) {
    if (await renderer.apply(css)) { ready = true; break; }
    await delay(350);
  }
  assert.ok(ready,'The CSS never appeared in the official renderer.');
  const { result } = await renderer.call('Runtime.evaluate',{
    expression: "JSON.stringify([getComputedStyle(document.body).backgroundImage,getComputedStyle(document.body,'::selection').backgroundColor])",
    returnByValue: true,
  });
  const [background,selection] = JSON.parse(result.value);
  assert.match(background,/radial-gradient/);
  assert.equal(selection,'rgb(6, 9, 16)');
  await renderer.call('CSS.setStyleSheetText',{styleSheetId:renderer.sheet,text:''});
  assert.equal(await renderer.currentRevision(),'');
  console.log('Official Windows Codex: isolated startup, exact theme, text selection and rollback verified.');
  if (alreadyRunning) assert.ok(await appIsRunning(app),'The regular app should still be running.');
} finally {
  if (cdp) {
    try { await cdp.call('Browser.close'); } catch { /* Some builds acknowledge after closing the socket. */ }
    cdp.close();
  }
  // Only this test's intentionally empty, disposable profile may be terminated.
  if (instance.running()) {
    await delay(1000);
    if (instance.running()) instance.child.kill();
  }
}
