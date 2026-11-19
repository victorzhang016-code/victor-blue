import test from 'node:test';
import assert from 'node:assert/strict';
import { isMainRenderer, loadTheme, parseEndpoint, Renderer } from '../scripts/launcher.mjs';

test('only the unqualified main window is eligible', () => {
  assert.equal(isMainRenderer({type:'page',url:'app://-/index.html'}),true);
  assert.equal(isMainRenderer({type:'page',url:'app://-/index.html?initialRoute=/avatar-overlay'}),false);
  assert.equal(isMainRenderer({type:'page',url:'https://example.com/index.html'}),false);
  assert.equal(isMainRenderer({type:'worker',url:'app://-/index.html'}),false);
});

test('the browser endpoint is constrained to a local port and recognized path', () => {
  const path='/devtools/browser/01010101-0101-4010-a101-010101010101';
  assert.equal(parseEndpoint('54239\n'+path+'\n'),'ws://127.0.0.1:54239'+path);
  for (const value of ['0\n'+path,'65536\n'+path,'1234\n//example.com','1234\n/devtools/page/target']) {
    assert.throws(()=>parseEndpoint(value));
  }
});

test('duplicate main windows fail closed', async () => {
  const page={type:'page',url:'app://-/index.html'};
  const methods=[];
  const client={call(method) {
    methods.push(method);
    return {targetInfos:[page,page]};
  }};
  assert.equal(await new Renderer(client).apply('body {color:#fff}'),false);
  assert.deepEqual(methods,['Target.getTargets']);
});

test('macOS loads the same theme plus native chrome adaptation', async () => {
  const core=await loadTheme('win32');
  const mac=await loadTheme('darwin');
  assert.ok(mac.startsWith(core));
  assert.ok(mac.includes('data-codex-os="darwin"'));
  assert.ok(core.includes('Think, Passion, Brave and Love.'));
  assert.ok(core.includes('background-color: #060910;'));
});
