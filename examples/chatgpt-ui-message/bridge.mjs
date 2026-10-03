// Minimal MCP Apps bridge, restricted to initialization and one text message.
// No conversation ID, network endpoint, authentication or automatic retry.
export function createBridge(view, { timeoutMs = 10000 } = {}) {
  if (view.parent === view) throw new Error('Plugin UI の iframe 内で開いてください');
  let nextId = 0;
  let ready = false;
  let closed = false;
  let sent = false;
  let origin;
  let initialization;
  const pending = new Map();
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const post = message => view.parent.postMessage(message, origin && origin !== 'null' ? origin : '*');

  function dispose() {
    closed = true;
    ready = false;
    view.removeEventListener('message', receive);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('接続を閉じました。送信済みの要求は取り消せません'));
    }
    pending.clear();
  }

  function receive(event) {
    if (event.source !== view.parent || (origin !== undefined && event.origin !== origin)) return;
    const data = event.data;
    if (!object(data) || data.jsonrpc !== '2.0') return;
    if (typeof data.method === 'string') {
      if (typeof data.id !== 'string' && typeof data.id !== 'number') return;
      if (data.method === 'ping' || data.method === 'ui/resource-teardown') {
        post({ jsonrpc: '2.0', id: data.id, result: {} });
        if (data.method === 'ui/resource-teardown') dispose();
      } else {
        post({ jsonrpc: '2.0', id: data.id, error: { code: -32601, message: 'Method not found' } });
      }
      return;
    }
    const item = pending.get(data.id);
    if (!item || (Object.hasOwn(data, 'result') === Object.hasOwn(data, 'error'))) return;
    if (!object(data.result) && !object(data.error)) return;
    origin ??= event.origin;
    pending.delete(data.id);
    clearTimeout(item.timer);
    if (data.error) item.reject(new Error(`ホストが拒否しました: ${data.error.message ?? 'RPC error'}`));
    else item.resolve(data.result);
  }

  function request(method, params) {
    if (closed) return Promise.reject(new Error('接続は閉じています'));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('応答がありません。送信結果は不明です。会話を確認し、自動再送しないでください'));
        dispose();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { post({ jsonrpc: '2.0', id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  view.addEventListener('message', receive);
  return {
    initialize() {
      initialization ??= (async () => {
        const result = await request('ui/initialize', {
          appInfo: { name: 'agent-kit-message-poc', version: '0.1.0' },
          appCapabilities: { availableDisplayModes: ['inline'] },
          protocolVersion: '2026-01-26',
        });
        if (closed) throw new Error('接続は閉じています');
        if (result.protocolVersion !== '2026-01-26') throw new Error('未対応のプロトコルです');
        if (!object(result.hostCapabilities?.message?.text)) throw new Error('ホストがテキスト送信に対応していません');
        post({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
        ready = true;
      })().catch(error => { dispose(); throw error; });
      return initialization;
    },
    async send(text) {
      if (!ready || closed) throw new Error('初期化された接続がありません');
      if (sent) throw new Error('この画面からは一度だけ送信できます');
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw new Error('本文は1〜2000文字で入力してください');
      sent = true; // A timeout is ambiguous: never retry automatically.
      const result = await request('ui/message', { role: 'user', content: [{ type: 'text', text }] });
      if (result.isError) throw new Error('ホストがメッセージを受け付けませんでした');
      return result;
    },
    dispose,
  };
}
