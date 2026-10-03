import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBridge } from './bridge.mjs';

export const resourceUri = 'ui://agent-kit/message-poc.html';
export const tool = {
  name: 'open_message_poc',
  description: 'Open a one-message test form in this conversation. Opening it does not send a message.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri } },
};
export const toolResult = { content: [{ type: 'text', text: 'PoC画面で本文を確認し、必要なら送信ボタンを押してください。' }] };

// Bundled inline: no CDN, npm dependency, API key or external connection.
export function widgetHtml() {
  return `<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>会話への送信 PoC</title>
<style>body{font:16px system-ui;max-width:42rem;margin:1rem;line-height:1.6}textarea{box-sizing:border-box;width:100%;min-height:8rem}button{padding:.6rem 1rem}#status{white-space:pre-wrap}</style>
<h1>この会話へ送信</h1><p>実機未検証の PoC です。送信先は、この画面を開いたホスト会話です。</p>
<form><label for="text">送る本文（2000文字まで）</label><textarea id="text" maxlength="2000" required></textarea>
<button disabled>本文をこの会話へ送る（一度だけ）</button></form><p id="status" role="status">接続を確認しています…</p>
<script>
const createBridge = ${createBridge.toString()};
const status = document.querySelector('#status');
const button = document.querySelector('button');
let bridge;
try {
  bridge = createBridge(window);
  bridge.initialize().then(() => {
    button.disabled = false;
    status.textContent = '接続しました。本文を入力し、送信先の会話を確認してください。';
  }).catch(error => { status.textContent = error.message; });
} catch (error) { status.textContent = error.message; }
document.querySelector('form').addEventListener('submit', async event => {
  event.preventDefault();
  const text = document.querySelector('#text').value;
  if (button.disabled || !text.trim()) return;
  button.disabled = true;
  status.textContent = 'ホストの応答を待っています…';
  try {
    await bridge.send(text);
    status.textContent = 'ホストが要求を受け付けました。会話への表示・応答はホスト側で確認してください。';
  } catch (error) { status.textContent = error.message; }
});
window.addEventListener('pagehide', () => bridge?.dispose());
</script></html>`;
}

export function resource() {
  return { uri: resourceUri, mimeType: 'text/html;profile=mcp-app', text: widgetHtml(),
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } };
}

export function mockHtml() {
  // Escape '<' so embedded HTML cannot close the outer script element.
  const embedded = JSON.stringify(widgetHtml()).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>ローカル mock</title>
<h1>ローカル mock — ChatGPT には送信しません</h1>
<label>応答 <select id="mode"><option value="success">成功</option><option value="deny">拒否</option><option value="timeout">応答しない</option></select></label>
<p>再試行はページを再読み込みしてください。</p><iframe title="Plugin UI mock" sandbox="allow-scripts" style="width:100%;height:440px"></iframe><pre id="log"></pre>
<script>
const frame = document.querySelector('iframe');
let initialized = false;
window.addEventListener('message', event => {
  if (event.source !== frame.contentWindow) return;
  const message = event.data;
  if (message?.jsonrpc !== '2.0') return;
  document.querySelector('#log').textContent += JSON.stringify(message) + '\\n';
  const reply = result => frame.contentWindow.postMessage({jsonrpc:'2.0',id:message.id,result}, '*');
  if (message.method === 'ui/initialize') reply({protocolVersion:'2026-01-26',hostInfo:{name:'local-mock',version:'1'},hostCapabilities:{message:{text:{}}},hostContext:{}});
  if (message.method === 'ui/notifications/initialized') initialized = true;
  if (message.method === 'ui/message' && initialized) {
    const mode = document.querySelector('#mode').value;
    if (mode === 'success') reply({});
    if (mode === 'deny') reply({isError:true});
  }
});
frame.srcdoc = ${embedded};
</script></html>`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = new URL('./dist/', import.meta.url);
  await mkdir(output, { recursive: true });
  for (const [name, content] of Object.entries({
    'widget.html': widgetHtml(), 'mock.html': mockHtml(),
    'resource.json': JSON.stringify({ contents: [resource()] }, null, 2),
    'tool.json': JSON.stringify(tool, null, 2),
  })) await writeFile(new URL(name, output), content);
  console.log('Generated dist/{widget.html,mock.html,resource.json,tool.json}');
}
