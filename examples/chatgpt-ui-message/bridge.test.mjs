import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext, Script } from 'node:vm';
import { createBridge } from './bridge.mjs';
import { widgetHtml, mockHtml, resource, tool, resourceUri } from './build.mjs';

function fixture(options) {
  const listeners = new Set();
  const sent = [];
  const view = {
    parent: { postMessage: (data, origin) => sent.push({ data, origin }) },
    addEventListener: (event, fn) => { if (event === 'message') listeners.add(fn); },
    removeEventListener: (event, fn) => { if (event === 'message') listeners.delete(fn); },
  };
  const emit = (data, source = view.parent, origin = 'https://mock.invalid') => {
    for (const listener of [...listeners]) listener({ data, source, origin });
  };
  const reply = (id, result) => emit({ jsonrpc: '2.0', id, result });
  const bridge = createBridge(view, options);
  const host = { protocolVersion: '2026-01-26', hostCapabilities: { message: { text: {} } } };
  async function initialize(result = host) {
    const promise = bridge.initialize();
    reply(sent.at(-1).data.id, result);
    await promise;
  }
  return { view, bridge, sent, emit, reply, listeners, initialize };
}

test('handshake sends no chat message; explicit send uses content array once', async () => {
  const f = fixture();
  await assert.rejects(f.bridge.send('premature'), /初期化/);
  await f.initialize();
  assert.deepEqual(f.sent.map(x => x.data.method), ['ui/initialize', 'ui/notifications/initialized']);
  const delivery = f.bridge.send('テスト本文');
  const request = f.sent.at(-1).data;
  assert.deepEqual(request.params, { role: 'user', content: [{ type: 'text', text: 'テスト本文' }] });
  assert.equal(request.method, 'ui/message');
  assert.equal(f.sent.at(-1).origin, 'https://mock.invalid');
  await assert.rejects(f.bridge.send('duplicate'), /一度だけ/);
  f.reply(request.id, {});
  await delivery;
  f.bridge.dispose();
  assert.equal(f.listeners.size, 0);
});

test('ignores foreign source, wrong origin, string-vs-number ID and notifications', async () => {
  const f = fixture();
  await f.initialize();
  const delivery = f.bridge.send('text');
  const id = f.sent.at(-1).data.id;
  f.emit({ jsonrpc: '2.0', id, error: { message: 'spoof' } }, {});
  f.emit({ jsonrpc: '2.0', id, error: { message: 'spoof' } }, f.view.parent, 'https://other.invalid');
  f.emit({ jsonrpc: '2.0', id: String(id), error: { message: 'wrong id type' } });
  f.emit({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: {} });
  f.emit({ jsonrpc: '2.0', id, result: {}, error: {} });
  f.reply(id, {});
  await delivery;
  f.bridge.dispose();
});

test('RPC errors and isError are not reported as accepted', async () => {
  for (const rpcError of [true, false]) {
    const f = fixture();
    await f.initialize();
    const delivery = f.bridge.send('text');
    const id = f.sent.at(-1).data.id;
    if (rpcError) f.emit({ jsonrpc: '2.0', id, error: { code: -32000, message: 'denied' } });
    else f.reply(id, { isError: true });
    await assert.rejects(delivery, /拒否|受け付けません/);
    await assert.rejects(f.bridge.send('retry'), /一度だけ/);
    f.bridge.dispose();
  }
});

test('unsupported host or version never enables send', async () => {
  for (const result of [
    { protocolVersion: '2026-01-26', hostCapabilities: {} },
    { protocolVersion: 'future', hostCapabilities: { message: { text: {} } } },
  ]) {
    const f = fixture();
    await assert.rejects(f.initialize(result), /未対応|対応していません/);
    await assert.rejects(f.bridge.send('text'), /初期化/);
    assert.equal(f.listeners.size, 0);
  }
});

test('timeout closes connection without retry, including a late reply', async () => {
  const f = fixture({ timeoutMs: 10 });
  await f.initialize();
  const delivery = f.bridge.send('text');
  const id = f.sent.at(-1).data.id;
  await assert.rejects(delivery, /送信結果は不明/);
  f.reply(id, {});
  await assert.rejects(f.bridge.send('again'), /初期化/);
  assert.equal(f.sent.filter(x => x.data.method === 'ui/message').length, 1);
  assert.equal(f.listeners.size, 0);
});

test('teardown rejects pending send and acknowledges host; unknown requests get errors', async () => {
  const f = fixture();
  await f.initialize();
  f.emit({ jsonrpc: '2.0', id: 'p', method: 'ping' });
  assert.deepEqual(f.sent.at(-1).data, { jsonrpc: '2.0', id: 'p', result: {} });
  f.emit({ jsonrpc: '2.0', id: 9, method: 'unsupported' });
  assert.equal(f.sent.at(-1).data.error.code, -32601);
  const delivery = f.bridge.send('text');
  f.emit({ jsonrpc: '2.0', id: 'stop', method: 'ui/resource-teardown' });
  await assert.rejects(delivery, /接続を閉じました/);
  assert.deepEqual(f.sent.at(-1).data, { jsonrpc: '2.0', id: 'stop', result: {} });
  assert.equal(f.listeners.size, 0);
});

test('empty and oversized text stay local; opaque sandbox origin works', async () => {
  const f = fixture();
  const init = f.bridge.initialize();
  f.emit({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2026-01-26', hostCapabilities: { message: { text: {} } } } }, f.view.parent, 'null');
  await init;
  for (const text of ['', '  ', 'x'.repeat(2001)]) await assert.rejects(f.bridge.send(text), /本文/);
  const delivery = f.bridge.send('ok');
  assert.equal(f.sent.at(-1).origin, '*');
  f.emit({ jsonrpc: '2.0', id: 2, result: {} }, f.view.parent, 'null');
  await delivery;
  f.bridge.dispose();
});

test('cannot initialize as a standalone top-level page', () => {
  const view = {};
  view.parent = view;
  assert.throws(() => createBridge(view), /iframe/);
});

const scriptOf = html => html.match(/<script>([\s\S]*?)<\/script>/)[1];
test('bundled scripts parse and resource/tool agree without external dependencies', () => {
  new Script(scriptOf(widgetHtml()));
  new Script(scriptOf(mockHtml()));
  assert.equal(tool._meta.ui.resourceUri, resourceUri);
  assert.equal(resource().uri, resourceUri);
  assert.equal(resource().mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(resource()._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.doesNotMatch(widgetHtml(), /<script[^>]+src=|fetch\(|WebSocket\(/);
});

test('actual bundled form only sends on explicit submit and renders host acceptance', async () => {
  const f = fixture();
  f.bridge.dispose(); // Only the bundled instance handles events below.
  const handlers = {};
  const button = { disabled: true };
  const status = { textContent: '' };
  const input = { value: 'この mock だけに送信' };
  const form = { addEventListener: (event, fn) => { handlers[event] = fn; } };
  const nodes = { button, '#status': status, '#text': input, form };
  runInNewContext(scriptOf(widgetHtml()), { window: f.view, document: { querySelector: id => nodes[id] }, setTimeout, clearTimeout });
  f.reply(1, { protocolVersion: '2026-01-26', hostCapabilities: { message: { text: {} } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.disabled, false);
  assert.equal(f.sent.filter(x => x.data.method === 'ui/message').length, 0);
  const submission = handlers.submit({ preventDefault() {} });
  assert.equal(button.disabled, true);
  f.reply(2, {});
  await submission;
  assert.match(status.textContent, /ホストが要求を受け付けました/);
  assert.equal(f.sent.filter(x => x.data.method === 'ui/message').length, 1);
});
