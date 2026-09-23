import type { FormV1, Option, Question, Table } from '../form/form-v1'
import { questionsOf } from '../form/form-v1'
import { OUTLINE_ATTRIBUTES, OUTLINE_TAGS } from '../form/outline'

/**
 * HTML シートの生成に要るもの。
 */
export type SheetInput = {
  /** 検証済みの質問票 */
  form: FormV1
  /** 上部バーに出す日付 (YYYY-MM-DD) */
  date: string
}

/**
 * HTML のテキストと属性値の逃がし。
 */
const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, char => {
    switch (char) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })

/**
 * `<script type="application/json">` に埋める JSON。`<` を `<` に逃がして
 * `</script>` で切れないようにします (JSON としてはそのまま読めます)。
 */
const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

const safeJson = (value: unknown): string =>
  JSON.stringify(value)
    .split('<')
    .join('\\u003c')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029')

/**
 * 未操作の問いがどう扱われるかの一文。
 */
const HINT = '未確認の問いは AI の推奨で進みます。'

/**
 * Review Workspace の CSS。左の Canvas は構成案で、未確定事項 (問い) を番号付きの印で示します。
 * 右の Inspector は、左で選んだものに応じて中身が変わります (何も選んでいないときは全体の
 * 進み具合と次に見る項目、印なら決定、表なら表の説明)。下部バーは進捗と送信です。
 *
 * 色は意味ごとに分けます。青は選択と操作、赤は推奨からの変更と失敗、緑は確認済み、
 * 黄は未確認、灰は AI の推奨です。外部リソースは読みません (フォントもシステムフォント)。
 * 900px より狭い画面では、Inspector は下から出る領域になります。
 */
const STYLE = `
:root{
--bg:#F3F4F6;--surface:#FFFFFF;--surface-2:#F7F8FA;--ink:#1B1F24;--muted:#5B6470;--faint:#858E99;--line:#E2E5E9;--line-strong:#C9CED5;
--blue:#2563EB;--blue-soft:#EAF1FE;--on-strong:#FFFFFF;--red:#D12F2F;--red-soft:#FDEDED;--green:#15803D;--green-soft:#E7F5EC;
--amber:#A95F06;--amber-dot:#F2A20C;--amber-soft:#FEF4E2;--ai:#56637A;--ai-soft:#EEF1F5;--shadow:0 12px 32px rgba(15,23,42,.16);
--top-h:52px;--bar-h:60px;--insp-w:380px;
--sans:"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic UI","Yu Gothic",Meiryo,system-ui,sans-serif;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{
--bg:#0E1115;--surface:#161A20;--surface-2:#1C2128;--ink:#E7EAEE;--muted:#A2ABB6;--faint:#7C8692;--line:#2A3039;--line-strong:#3B434E;
--blue:#6B9DFF;--blue-soft:rgba(107,157,255,.15);--on-strong:#0B1220;--red:#FF6B6B;--red-soft:rgba(255,107,107,.13);--green:#46D08A;--green-soft:rgba(70,208,138,.13);
--amber:#F4B740;--amber-dot:#F4B740;--amber-soft:rgba(244,183,64,.13);--ai:#A7B2C2;--ai-soft:rgba(167,178,194,.12);--shadow:0 12px 32px rgba(0,0,0,.5)}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{background:var(--bg)}
body{margin:0;color:var(--ink);font-family:var(--sans);font-size:14.5px;line-height:1.75;-webkit-font-smoothing:antialiased}
button,input,textarea{font:inherit;color:inherit}
.app{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:20;height:var(--top-h);display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 20px;background:var(--surface);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;min-width:0;font-size:12.5px;color:var(--muted)}
.brand span{white-space:nowrap}
.mark{font:600 11px/1 var(--mono);letter-spacing:.16em;color:var(--ink);padding:5px 8px;border:1px solid var(--line-strong);border-radius:6px}
.doc-id{font-family:var(--mono);color:var(--ink);overflow:hidden;text-overflow:ellipsis}
.meta{display:flex;align-items:center;gap:12px;font:12px/1 var(--mono);color:var(--faint);white-space:nowrap}
.phase{font-family:var(--sans);font-size:12px;padding:5px 10px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);color:var(--muted)}
.app.sent .phase{background:var(--green-soft);border-color:transparent;color:var(--green)}
.app.failed .phase{background:var(--red-soft);border-color:transparent;color:var(--red)}
.ws{flex:1;display:grid;grid-template-columns:minmax(0,1fr) var(--insp-w);align-items:start}
.canvas{min-width:0;padding:40px 32px 64px}
.doc{max-width:760px;margin:0 auto}
.eyebrow{display:flex;gap:10px;margin:0 0 6px;font:500 12px/1.4 var(--mono);color:var(--faint)}
.eyebrow span+span{padding-left:10px;border-left:1px solid var(--line-strong)}
h1{font-size:26px;line-height:1.4;margin:0 0 16px}
.concl{margin:0 0 14px;padding:14px 18px;background:var(--surface);border:1px solid var(--line);border-radius:10px;font-size:15px}
.gl{margin:0;padding:12px 18px;background:var(--surface-2);border-radius:10px;font-size:13px}
.gl-title{margin:0 0 4px;font-size:12px;font-weight:600;color:var(--muted)}
.gl dl{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:2px 16px}
.gl dt{font-weight:600}.gl dd{margin:0;color:var(--muted)}
.outline{margin-top:28px;padding:8px 28px 24px;background:var(--surface);border:1px solid var(--line);border-radius:12px}
.outline h2{margin:26px 0 10px;padding-bottom:6px;font-size:18px;line-height:1.5;border-bottom:1px solid var(--line)}
.outline h3{margin:22px 0 8px;font-size:16px;line-height:1.5}
.outline h4{margin:18px 0 6px;font-size:14.5px;line-height:1.5}
.outline p{margin:8px 0}
.outline ul,.outline ol{margin:8px 0;padding-left:1.5em}
.outline li{margin:4px 0}
.outline dl{margin:8px 0}.outline dt{font-weight:600}.outline dd{margin:0 0 6px 1.2em;color:var(--muted)}
.outline code{padding:1px 5px;background:var(--surface-2);border:1px solid var(--line);border-radius:4px;font:.92em var(--mono)}
.outline pre{margin:10px 0;padding:12px 14px;overflow-x:auto;background:var(--surface-2);border:1px solid var(--line);border-radius:8px;font:12.5px/1.6 var(--mono)}
.outline pre code{padding:0;border:0;background:none}
.outline blockquote{margin:10px 0;padding:2px 14px;border-left:3px solid var(--line-strong);color:var(--muted)}
.outline hr{margin:24px 0;border:0;border-top:1px solid var(--line)}
.outline table{width:100%;margin:10px 0;border-collapse:collapse;font-size:13.5px;line-height:1.6}
.outline caption{padding:12px 16px 8px;text-align:left;font-weight:600;font-size:14px}
.outline th,.outline td{padding:8px 12px;text-align:left;vertical-align:middle;border-top:1px solid var(--line)}
.outline th{background:var(--surface-2);color:var(--muted);font-size:11.5px;font-weight:500;letter-spacing:.04em;white-space:nowrap}
.qa{padding:2px 4px;border-radius:6px;cursor:pointer;-webkit-box-decoration-break:clone;box-decoration-break:clone;transition:box-shadow .15s}
.qa:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
.qa.active{box-shadow:0 0 0 2px var(--blue)}
.qa .badge{margin-right:5px;vertical-align:1px}
.qa[data-kind="rec"]{background:var(--ai-soft)}
.qa[data-kind="rec"] .qa-t{color:var(--ai);border-bottom:1.5px dashed var(--ai)}
.qa[data-kind="none"]{background:var(--amber-soft)}
.qa[data-kind="none"] .qa-t{color:var(--amber);border-bottom:1.5px dashed var(--amber)}
.qa[data-state="confirmed"]{background:var(--green-soft)}
.qa[data-state="changed"]{background:var(--red-soft)}
.badge{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--amber-dot);color:#1B1F24;font:700 11.5px/1 var(--mono)}
[data-state="confirmed"] .badge{background:var(--green);color:var(--on-strong)}
[data-state="changed"] .badge{background:var(--red);color:var(--on-strong)}
.badge.t{background:var(--surface-2);color:var(--muted);border:1px solid var(--line);font-family:var(--sans);font-weight:600}
.tbl{margin:12px 0 16px;overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;transition:border-color .15s,box-shadow .15s}
.tbl.active{border-color:var(--blue);box-shadow:0 0 0 3px var(--blue-soft)}
.outline .tbl table{margin:0}
.tbl td:not(:has(input)){white-space:nowrap}
td input{width:100%;min-width:120px;padding:6px 8px;background:var(--surface);border:1px solid var(--line);border-radius:6px}
td input:focus,.note:focus,textarea:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px var(--blue-soft)}
.inspector{position:sticky;top:var(--top-h);height:calc(100vh - var(--top-h) - var(--bar-h));height:calc(100dvh - var(--top-h) - var(--bar-h));overflow:auto;background:var(--surface);border-left:1px solid var(--line)}
.insp-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;min-height:52px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--line)}
.crumb{flex:none;padding:4px 12px;background:var(--surface);border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:12.5px;cursor:pointer}
.crumb[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--surface)}
.crumb-sep{color:var(--faint)}
.crumb-cur{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}
.sheet-close{display:none;margin-left:auto}
.icon-btn{padding:3px 10px;background:var(--surface);border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:12px;cursor:pointer}
.panel{padding:18px 20px 28px}
.p-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.p-eyebrow{margin-right:auto;font-size:12px;color:var(--faint)}
.p-title{margin:0 0 4px;font-size:15.5px;line-height:1.6;font-weight:600}
.p-sec{margin-top:18px}
.p-label{display:block;margin:0 0 6px;font-size:11.5px;font-weight:600;letter-spacing:.06em;color:var(--faint)}
.state{flex:none;display:inline-flex;align-items:center;gap:6px;padding:5px 9px;border-radius:999px;font-size:12px;line-height:1;white-space:nowrap}
.state::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
[data-state="pending"] .state{color:var(--amber);background:var(--amber-soft)}
[data-state="confirmed"] .state{color:var(--green);background:var(--green-soft)}
[data-state="changed"] .state{color:var(--red);background:var(--red-soft)}
.cite{margin:0;padding:10px 12px;background:var(--surface-2);border-radius:8px;font:12.5px/1.6 var(--mono);word-break:break-word}
.choices{display:flex;flex-direction:column;gap:8px}
.choice{position:relative;display:flex;flex-direction:column;gap:4px;padding:12px 12px 10px;background:var(--surface);border:1.5px solid var(--line);border-radius:10px;cursor:pointer;transition:border-color .15s,background .15s}
.choice:hover{border-color:var(--line-strong)}
.choice input{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}
.choice:has(input:focus-visible){outline:2px solid var(--blue);outline-offset:2px}
.choice:has(input:checked){border-color:var(--blue);background:var(--blue-soft)}
[data-state="pending"] .choice[data-rec="1"]{border-style:dashed;border-color:var(--ai)}
.c-top{display:flex;align-items:center;gap:8px}
.radio{flex:none;display:grid;place-items:center;width:16px;height:16px;border:1.5px solid var(--line-strong);border-radius:50%}
.choice:has(input:checked) .radio{border-color:var(--blue)}
.choice:has(input:checked) .radio::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--blue)}
.opt-id{font:600 12.5px/1 var(--mono);color:var(--muted)}
.c-label{flex:1;font-weight:600;line-height:1.5}
.ai-rec{padding:4px 8px;border-radius:999px;background:var(--ai-soft);color:var(--ai);font-size:11.5px;line-height:1;white-space:nowrap}
.pc{display:grid;grid-template-columns:auto 1fr;gap:8px;padding-left:24px;font-size:12.5px;line-height:1.6;color:var(--muted)}
.k{font-size:11px;color:var(--faint);padding-top:1px;white-space:nowrap}
.p-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:8px 0 0;font-size:12.5px;color:var(--muted)}
.p-row span{flex:1;min-width:0}
[data-state="changed"] .p-row span{color:var(--red)}
.link{padding:0;border:0;background:none;color:var(--blue);font-size:12.5px;cursor:pointer}
.link:hover{text-decoration:underline}
.ai-box{padding:12px 14px;background:var(--ai-soft);border-radius:10px}
.ai-box .p-label{color:var(--ai)}
.ai-pick{margin:0;font-weight:600}
.ai-why{display:grid;grid-template-columns:auto 1fr;gap:8px;margin:4px 0 0;font-size:13px;color:var(--muted)}
.ai-note{margin:8px 0 0;font-size:12.5px;color:var(--ai)}
[data-state="confirmed"] .ai-note{color:var(--green)}
[data-state="changed"] .ai-note{color:var(--red)}
.ai-none{margin:0;font-size:13px;color:var(--muted)}
.note,textarea{width:100%;padding:8px 10px;background:var(--surface);border:1px solid var(--line);border-radius:8px;font-size:13.5px}
textarea{min-height:120px;resize:vertical;line-height:1.6}
.help{margin:6px 0 0;font-size:12px;color:var(--faint)}
.p-foot{display:flex;justify-content:flex-end;margin-top:22px}
.meter{display:flex;height:6px;margin:2px 0 12px;overflow:hidden;background:var(--amber-soft);border-radius:999px}
.meter span{display:block;width:0;height:100%;transition:width .2s}
[data-meter="confirmed"]{background:var(--green)}
[data-meter="changed"]{background:var(--red)}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin:0}
.stats div{padding:8px 10px;background:var(--surface-2);border-radius:8px}
.stats dt{font-size:11.5px;color:var(--muted)}
.stats dd{margin:0;font:600 18px/1.3 var(--mono)}
.next-card{width:100%;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:2px 10px;padding:12px;background:var(--surface);border:1px solid var(--line);border-radius:10px;text-align:left;cursor:pointer}
.next-card:hover{border-color:var(--blue)}
.next-card .badge{grid-row:1/3}
.next-title{font-size:13.5px;font-weight:600;line-height:1.5}
.next-reason{grid-column:2;font-size:12px;color:var(--muted)}
.next-open{grid-row:1/3;grid-column:3;font-size:12.5px;color:var(--blue)}
.next-done{margin:0;padding:12px;background:var(--green-soft);border-radius:10px;color:var(--green);font-size:13px}
.t-blank{margin:10px 0 0;font-size:13px}
.bar{position:sticky;bottom:0;z-index:20;height:var(--bar-h);display:flex;align-items:center;gap:16px;padding:0 20px;background:var(--surface);border-top:1px solid var(--line)}
.counts{display:flex;gap:14px;font-size:12.5px;color:var(--muted);white-space:nowrap}
.count{display:inline-flex;align-items:center;gap:6px}
.count i{width:8px;height:8px;border-radius:50%}
[data-count="pending"] i{background:var(--amber-dot)}
[data-count="confirmed"] i{background:var(--green)}
[data-count="changed"] i{background:var(--red)}
.count b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
.bar-msg{flex:1;min-width:0;margin:0;font-size:12.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-msg.err{color:var(--red)}
.bar-msg.ok{color:var(--green)}
.btn{padding:8px 18px;border:1px solid transparent;border-radius:8px;font-size:13.5px;font-weight:600;cursor:pointer}
.btn.primary{background:var(--blue);color:var(--on-strong)}
.btn.primary:hover{filter:brightness(1.06)}
.btn.primary:disabled{background:var(--line-strong);color:var(--surface);cursor:default;filter:none}
.btn.ghost{background:var(--surface);border-color:var(--line)}
.only-narrow{display:none}
.fallback{position:fixed;left:50%;bottom:calc(var(--bar-h) + 12px);z-index:30;width:min(720px,calc(100vw - 32px));transform:translateX(-50%);padding:16px;background:var(--surface);border:1px solid var(--red);border-radius:12px;box-shadow:var(--shadow)}
.fallback-head{display:flex;align-items:flex-start;gap:12px;margin:0 0 8px}
.fallback-title{flex:1;margin:0;color:var(--red);font-size:13px;font-weight:600}
.fallback textarea{min-height:160px;font:12px/1.5 var(--mono)}
@media (max-width:900px){
.ws{grid-template-columns:minmax(0,1fr)}
.canvas{padding:24px 16px 48px}
.outline{padding:4px 16px 16px}
.inspector{position:fixed;left:0;right:0;top:auto;bottom:var(--bar-h);z-index:25;height:auto;max-height:72vh;border-left:0;border-top:1px solid var(--line);border-radius:14px 14px 0 0;box-shadow:var(--shadow);transform:translateY(calc(100% + var(--bar-h)));visibility:hidden;transition:transform .2s ease,visibility .2s}
.ws.sheet-open .inspector{transform:none;visibility:visible}
.sheet-close,.only-narrow{display:inline-flex}
.count .lbl,.rev,.date{display:none}
.bar{gap:10px;padding:0 16px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`.trim()

/**
 * ブラウザで動かす素の JavaScript。TypeScript の関数を toString で埋めません。
 *
 * すること:
 * - 構成案の HTML を DOMParser で解析し、許可した要素と属性だけで組み直す (Claude の HTML は実行しない)
 * - 問いの印を押せる文に、表の印をサーバが描いた表に置き換える
 * - 左で選んだものに応じて右の Inspector を切り替え、何も選んでいないときは進み具合と次に見る項目を出す
 * - 選択肢の再クリックと [選択を外す] で解除、問いごとの状態 (未確認 / 確認済み / 推奨から変更) の表示
 * - 補足と表と全体コメントの下書きを localStorage に保存して復元
 * - [送信] で回答 JSON を `/answer?t=<token>` に POST (token は URL の `?t=` から読む)、失敗時の代替導線
 *
 * 質問票の ID は CSS セレクタに埋めず、`data-q` / `data-t` の値と `form.elements` の名前で引きます。
 */
const SCRIPT = `
(function () {
  'use strict';
  var TAGS = ${JSON.stringify(OUTLINE_TAGS)};
  var ATTRIBUTES = ${JSON.stringify(OUTLINE_ATTRIBUTES)};
  var form = JSON.parse(document.getElementById('di-form').textContent);
  var root = document.getElementById('di-answer');
  var ws = document.getElementById('di-ws');
  var canvasEl = document.getElementById('di-canvas');
  var outlineEl = document.getElementById('di-outline');
  var holderEl = document.getElementById('di-tables');
  var inspectorEl = document.getElementById('di-inspector');
  var overviewEl = root.querySelector('[data-panel="overview"]');
  var overviewButton = root.querySelector('[data-action="overview"]');
  var crumbSepEl = document.getElementById('di-crumb-sep');
  var crumbEl = document.getElementById('di-crumb');
  var nextEl = document.getElementById('di-next');
  var phaseEl = document.getElementById('di-phase');
  var statusEl = document.getElementById('di-status');
  var submitEl = document.getElementById('di-submit');
  var fallbackPanel = document.getElementById('di-fallback-panel');
  var fallbackEl = document.getElementById('di-fallback');
  var fallbackMessageEl = document.getElementById('di-fallback-message');
  var draftKey = 'document-interview:' + form.documentId + ':' + form.revision;
  var token = new URLSearchParams(location.search).get('t') || '';
  var STATE_LABELS = { pending: '未確認', confirmed: '確認済み', changed: '推奨から変更' };

  var questions = [];
  var questionById = Object.create(null);
  form.themes.forEach(function (theme) {
    theme.questions.forEach(function (question) {
      questions.push(question);
      questionById[question.id] = { question: question, number: questions.length };
    });
  });
  var tables = form.tables || [];
  var tableById = Object.create(null);
  tables.forEach(function (table) { tableById[table.id] = table; });
  var current = null;

  function all(selector, scope) { return Array.prototype.slice.call((scope || root).querySelectorAll(selector)); }

  // 構成案を、許可した要素と属性だけで組み直す
  var allowed = Object.create(null);
  TAGS.forEach(function (tag) { allowed[tag.toUpperCase()] = true; });

  function rebuild(from, to) {
    Array.prototype.forEach.call(from.childNodes, function (node) {
      if (node.nodeType === 3) {
        to.appendChild(document.createTextNode(node.nodeValue));
        return;
      }
      if (node.nodeType !== 1 || !allowed[node.tagName]) return;
      var tag = node.tagName.toLowerCase();
      var el = document.createElement(tag);
      (ATTRIBUTES[tag] || []).forEach(function (name) {
        var value = node.getAttribute(name);
        if (value !== null) el.setAttribute(name, value);
      });
      rebuild(node, el);
      to.appendChild(el);
    });
  }

  rebuild(new DOMParser().parseFromString(form.outline, 'text/html').body, outlineEl);

  // 問いの印を、押せる文に置き換える
  all('span[data-q]', outlineEl).forEach(function (slot) {
    var entry = questionById[slot.getAttribute('data-q')];
    if (!slot.parentNode) return;
    if (!entry) {
      slot.parentNode.removeChild(slot);
      return;
    }
    var anchor = document.createElement('span');
    anchor.className = 'qa';
    anchor.setAttribute('role', 'button');
    anchor.setAttribute('tabindex', '0');
    anchor.setAttribute('data-q', entry.question.id);
    anchor.setAttribute('data-role', 'anchor');
    anchor.setAttribute('data-state', 'pending');
    var badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String(entry.number);
    var text = document.createElement('span');
    text.className = 'qa-t';
    text.setAttribute('data-q', entry.question.id);
    text.setAttribute('data-role', 'anchor-text');
    anchor.appendChild(badge);
    anchor.appendChild(text);
    slot.parentNode.replaceChild(anchor, slot);
  });

  // 表の印を、サーバが描いた表 (入力欄つき) に置き換える
  var tableEls = Object.create(null);
  all('[data-role="table"]', holderEl).forEach(function (el) { tableEls[el.getAttribute('data-t')] = el; });
  var placed = Object.create(null);
  all('div[data-table]', outlineEl).forEach(function (slot) {
    var id = slot.getAttribute('data-table');
    if (!slot.parentNode) return;
    if (!tableEls[id] || placed[id]) {
      slot.parentNode.removeChild(slot);
      return;
    }
    placed[id] = true;
    slot.parentNode.replaceChild(tableEls[id], slot);
  });
  tables.forEach(function (table) {
    if (!placed[table.id] && tableEls[table.id]) outlineEl.appendChild(tableEls[table.id]);
  });

  // 構成案の中の並び (問いは最初の印、表は置いた位置)。「次に見る項目」の順番に使う
  var order = [];
  var ordered = Object.create(null);
  all('[data-role="anchor"], [data-role="table"]', outlineEl).forEach(function (el) {
    var kind = el.getAttribute('data-role') === 'anchor' ? 'q' : 't';
    var id = el.getAttribute(kind === 'q' ? 'data-q' : 'data-t');
    if (ordered[kind + ':' + id]) return;
    ordered[kind + ':' + id] = true;
    order.push({ kind: kind, id: id });
  });

  function group(attribute) {
    var map = Object.create(null);
    all('[' + attribute + ']').forEach(function (el) {
      var id = el.getAttribute(attribute);
      (map[id] = map[id] || []).push(el);
    });
    return map;
  }
  var questionParts = group('data-q');
  var tableParts = group('data-t');

  function partsOf(map, id, role) {
    return (map[id] || []).filter(function (el) { return el.getAttribute('data-role') === role; });
  }

  function field(name) { return root.elements.namedItem(name); }

  function radiosOf(questionId) {
    var list = field('q-' + questionId);
    if (!list) return [];
    return list.length === undefined ? [list] : Array.prototype.slice.call(list);
  }

  function recommendedOf(question) {
    return question.options.filter(function (option) { return option.recommended === true; })[0] || null;
  }

  function optionOf(question, id) {
    return question.options.filter(function (option) { return option.id === id; })[0] || null;
  }

  function collect() {
    var answers = {};
    questions.forEach(function (question) {
      var checked = radiosOf(question.id).filter(function (radio) { return radio.checked; })[0];
      var noteEl = field('note-' + question.id);
      answers[question.id] = {
        choice: checked ? checked.value : null,
        note: noteEl ? noteEl.value : ''
      };
    });
    var filled = {};
    tables.forEach(function (table) {
      filled[table.id] = table.rows.map(function (row, rowIndex) {
        return row.map(function (cell, cellIndex) {
          var input = field('cell-' + table.id + '-' + rowIndex + '-' + cellIndex);
          return input ? input.value : cell;
        });
      });
    });
    var globalEl = field('globalNote');
    return {
      schemaVersion: 1,
      documentId: form.documentId,
      revision: form.revision,
      answers: answers,
      tables: filled,
      globalNote: globalEl ? globalEl.value : ''
    };
  }

  function stateOf(question, answer) {
    if (answer.choice === null) return 'pending';
    var recommended = recommendedOf(question);
    return recommended && recommended.id !== answer.choice ? 'changed' : 'confirmed';
  }

  function anchorOf(question, answer) {
    var chosen = answer.choice === null ? null : optionOf(question, answer.choice);
    if (chosen) return { text: chosen.preview || chosen.label, kind: 'chosen' };
    var recommended = recommendedOf(question);
    if (recommended) return { text: recommended.preview || recommended.label, kind: 'rec' };
    return { text: question.options.map(function (option) { return option.label; }).join(' / '), kind: 'none' };
  }

  function defaultTextOf(question, answer, state) {
    var recommended = recommendedOf(question);
    if (state === 'pending') {
      return recommended ? '何も選ばなければ ' + recommended.id + ' で進みます。' : '推奨案はありません。選ばなければ AI が選びます。';
    }
    if (state === 'changed') return answer.choice + ' を選んでいます。推奨は ' + recommended.id + ' です。';
    return answer.choice + ' で確定しています。';
  }

  function aiNoteOf(answer, state) {
    if (state === 'pending') return '変更しなければこの案で進みます。';
    if (state === 'changed') return answer.choice + ' を選んでいるので、この案では進みません。';
    return 'この案で確定しています。';
  }

  function blanksOf(table) {
    var count = 0;
    table.rows.forEach(function (row, rowIndex) {
      row.forEach(function (cell, cellIndex) {
        var input = field('cell-' + table.id + '-' + rowIndex + '-' + cellIndex);
        if (input && input.value.trim() === '') count += 1;
      });
    });
    return count;
  }

  // 次に見る項目: 推奨案の無い未確認の問い、推奨案のある未確認の問い、空欄のある表の順。
  // 同じ順位の中では構成案の上から。exclude の項目は飛ばす
  function pickNext(exclude) {
    var answer = collect();
    var best = null;
    order.forEach(function (item) {
      if (exclude && exclude.kind === item.kind && exclude.id === item.id) return;
      var priority = 0;
      if (item.kind === 'q') {
        var question = questionById[item.id].question;
        if (answer.answers[question.id].choice === null) priority = recommendedOf(question) ? 2 : 1;
      } else if (blanksOf(tableById[item.id]) > 0) {
        priority = 3;
      }
      if (priority > 0 && (best === null || priority < best.priority)) best = { item: item, priority: priority };
    });
    return best;
  }

  function labelOf(item) {
    if (item.kind === 'q') return questionById[item.id].number + '. ' + questionById[item.id].question.title;
    return '表: ' + tableById[item.id].title;
  }

  function renderNext() {
    var next = pickNext(null);
    while (nextEl.firstChild) nextEl.removeChild(nextEl.firstChild);
    if (!next) {
      var done = document.createElement('p');
      done.className = 'next-done';
      done.textContent = '未確認の項目はありません。送信できます。';
      nextEl.appendChild(done);
      return;
    }
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'next-card';
    card.setAttribute('data-state', 'pending');
    var badge = document.createElement('span');
    var title = document.createElement('span');
    var reason = document.createElement('span');
    var open = document.createElement('span');
    title.className = 'next-title';
    reason.className = 'next-reason';
    open.className = 'next-open';
    open.textContent = '開く';
    if (next.item.kind === 'q') {
      var entry = questionById[next.item.id];
      badge.className = 'badge';
      badge.textContent = String(entry.number);
      title.textContent = entry.question.title;
      reason.textContent = next.priority === 1
        ? '推奨案がありません。人の判断が要ります。'
        : '未確認です。選ばなければ AI の推奨 ' + recommendedOf(entry.question).id + ' で進みます。';
    } else {
      var table = tableById[next.item.id];
      badge.className = 'badge t';
      badge.textContent = '表';
      title.textContent = table.title;
      reason.textContent = '空欄が ' + blanksOf(table) + ' か所あります。';
    }
    card.appendChild(badge);
    card.appendChild(title);
    card.appendChild(reason);
    card.appendChild(open);
    card.addEventListener('click', function () {
      select(next.item);
      reveal(next.item);
    });
    nextEl.appendChild(card);
  }

  function refresh() {
    var answer = collect();
    var counts = { pending: 0, confirmed: 0, changed: 0 };
    questions.forEach(function (question) {
      var a = answer.answers[question.id];
      var state = stateOf(question, a);
      var anchor = anchorOf(question, a);
      var number = questionById[question.id].number;
      counts[state] += 1;
      (questionParts[question.id] || []).forEach(function (el) {
        if (el.hasAttribute('data-state')) el.setAttribute('data-state', state);
      });
      partsOf(questionParts, question.id, 'anchor').forEach(function (el) {
        el.setAttribute('data-kind', anchor.kind);
        el.setAttribute('title', question.title);
        el.setAttribute('aria-label', number + '. ' + question.title + ': ' + anchor.text + ' (' + STATE_LABELS[state] + ')');
      });
      partsOf(questionParts, question.id, 'anchor-text').forEach(function (el) { el.textContent = anchor.text; });
      partsOf(questionParts, question.id, 'state').forEach(function (el) { el.textContent = STATE_LABELS[state]; });
      partsOf(questionParts, question.id, 'default').forEach(function (el) { el.textContent = defaultTextOf(question, a, state); });
      partsOf(questionParts, question.id, 'ai-note').forEach(function (el) { el.textContent = aiNoteOf(a, state); });
      partsOf(questionParts, question.id, 'clear').forEach(function (el) { el.hidden = a.choice === null; });
    });
    var blanks = 0;
    tables.forEach(function (table) {
      var count = blanksOf(table);
      blanks += count;
      partsOf(tableParts, table.id, 'blank').forEach(function (el) {
        el.textContent = count === 0 ? '空欄はありません。' : '空欄が ' + count + ' か所あります。';
      });
    });
    all('[data-count]').forEach(function (el) {
      el.querySelector('b').textContent = String(counts[el.getAttribute('data-count')]);
    });
    var stats = { pending: counts.pending, confirmed: counts.confirmed, changed: counts.changed, blank: blanks };
    all('[data-stat]').forEach(function (el) {
      el.querySelector('dd').textContent = String(stats[el.getAttribute('data-stat')]);
    });
    all('[data-meter]').forEach(function (el) {
      var share = questions.length === 0 ? 0 : counts[el.getAttribute('data-meter')] / questions.length;
      el.style.width = Math.round(share * 100) + '%';
    });
    renderNext();
  }

  function select(item) {
    current = item;
    overviewEl.hidden = item !== null;
    questions.forEach(function (question) {
      var on = item !== null && item.kind === 'q' && item.id === question.id;
      partsOf(questionParts, question.id, 'panel').forEach(function (el) { el.hidden = !on; });
      partsOf(questionParts, question.id, 'anchor').forEach(function (el) { el.classList.toggle('active', on); });
    });
    tables.forEach(function (table) {
      var on = item !== null && item.kind === 't' && item.id === table.id;
      partsOf(tableParts, table.id, 'table-panel').forEach(function (el) { el.hidden = !on; });
      partsOf(tableParts, table.id, 'table').forEach(function (el) { el.classList.toggle('active', on); });
    });
    overviewButton.setAttribute('aria-pressed', item === null ? 'true' : 'false');
    crumbSepEl.hidden = item === null;
    crumbEl.textContent = item === null ? '' : labelOf(item);
    inspectorEl.scrollTop = 0;
  }

  function reveal(item) {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var map = item.kind === 'q' ? questionParts : tableParts;
    var target = partsOf(map, item.id, item.kind === 'q' ? 'anchor' : 'table')[0];
    if (target) target.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }

  function openSheet() { ws.classList.add('sheet-open'); }
  function closeSheet() { ws.classList.remove('sheet-open'); }

  function saveDraft() {
    try { localStorage.setItem(draftKey, JSON.stringify(collect())); } catch (e) { /* 保存できなくても続ける */ }
  }

  function syncChecked(questionId) {
    radiosOf(questionId).forEach(function (radio) { radio.dataset.wasChecked = radio.checked ? '1' : '0'; });
  }

  function restoreDraft() {
    var raw = null;
    try { raw = localStorage.getItem(draftKey); } catch (e) { return; }
    if (!raw) return;
    var saved;
    try { saved = JSON.parse(raw); } catch (e) { return; }
    if (!saved || saved.schemaVersion !== 1) return;
    questions.forEach(function (question) {
      var a = saved.answers && saved.answers[question.id];
      if (!a) return;
      radiosOf(question.id).forEach(function (radio) { radio.checked = radio.value === a.choice; });
      syncChecked(question.id);
      var noteEl = field('note-' + question.id);
      if (noteEl && typeof a.note === 'string') noteEl.value = a.note;
    });
    tables.forEach(function (table) {
      var rows = saved.tables && saved.tables[table.id];
      if (!Array.isArray(rows)) return;
      rows.forEach(function (row, rowIndex) {
        if (!Array.isArray(row)) return;
        row.forEach(function (cell, cellIndex) {
          var input = field('cell-' + table.id + '-' + rowIndex + '-' + cellIndex);
          if (input && typeof cell === 'string') input.value = cell;
        });
      });
    });
    var globalEl = field('globalNote');
    if (globalEl && typeof saved.globalNote === 'string') globalEl.value = saved.globalNote;
  }

  // 左: 印を押すと右に決定を出す。表に触れると右に表の説明を出す。余白を押すと全体に戻る
  questions.forEach(function (question) {
    var item = { kind: 'q', id: question.id };
    partsOf(questionParts, question.id, 'anchor').forEach(function (anchor) {
      anchor.addEventListener('click', function () { select(item); openSheet(); });
      anchor.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        select(item);
        openSheet();
      });
    });
    partsOf(questionParts, question.id, 'clear').forEach(function (button) {
      button.addEventListener('click', function () {
        radiosOf(question.id).forEach(function (radio) { radio.checked = false; });
        syncChecked(question.id);
        saveDraft();
        refresh();
      });
    });
  });
  tables.forEach(function (table) {
    partsOf(tableParts, table.id, 'table').forEach(function (el) {
      el.addEventListener('focusin', function () { select({ kind: 't', id: table.id }); });
    });
  });
  canvasEl.addEventListener('click', function (event) {
    if (event.target.closest('[data-role="anchor"], [data-role="table"]')) return;
    select(null);
    closeSheet();
  });

  // 右: 全体に戻る、次の未確認へ、閉じる
  overviewButton.addEventListener('click', function () { select(null); });
  all('[data-action="open-overview"]').forEach(function (button) {
    button.addEventListener('click', function () { select(null); openSheet(); });
  });
  all('[data-action="next"]').forEach(function (button) {
    button.addEventListener('click', function () {
      var next = pickNext(current);
      select(next ? next.item : null);
      if (next) reveal(next.item);
    });
  });
  all('[data-action="close"]').forEach(function (button) { button.addEventListener('click', closeSheet); });
  all('[data-action="close-fallback"]').forEach(function (button) {
    button.addEventListener('click', function () { fallbackPanel.hidden = true; });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeSheet();
  });

  // 選択肢: 選択中のものをもう一度クリックすると解除 (AI の推奨に任せる)
  all('input[type="radio"]').forEach(function (radio) {
    radio.addEventListener('click', function () {
      var questionId = radio.name.slice(2);
      if (radio.dataset.wasChecked === '1') {
        radio.checked = false;
        radio.dataset.wasChecked = '0';
      } else {
        syncChecked(questionId);
      }
      saveDraft();
      refresh();
    });
    radio.addEventListener('change', function () { syncChecked(radio.name.slice(2)); });
  });

  // 1 行の入力欄で Enter を押しても送信しない
  all('input[type="text"]').forEach(function (input) {
    input.addEventListener('keydown', function (event) { if (event.key === 'Enter') event.preventDefault(); });
  });

  root.addEventListener('input', function () { saveDraft(); refresh(); });

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = 'bar-msg' + (kind ? ' ' + kind : '');
  }

  function setPhase(text, kind) {
    phaseEl.textContent = text;
    root.classList.toggle('sent', kind === 'sent');
    root.classList.toggle('failed', kind === 'failed');
  }

  function lock() {
    all('input, textarea').forEach(function (el) { el.disabled = true; });
    all('[data-role="clear"]').forEach(function (el) { el.disabled = true; });
    submitEl.disabled = true;
  }

  function showFallback(answer, message) {
    setStatus(message, 'err');
    setPhase('送信できませんでした', 'failed');
    fallbackMessageEl.textContent = message;
    fallbackEl.value = JSON.stringify(answer, null, 2);
    fallbackEl.disabled = false;
    fallbackEl.readOnly = true;
    fallbackPanel.hidden = false;
  }

  fallbackEl.addEventListener('focus', function () { fallbackEl.select(); });

  var FALLBACK_MESSAGE = '受信サーバが応答しません。下の JSON をそのまま Claude Code のチャットに貼ってください。';

  root.addEventListener('submit', function (event) {
    event.preventDefault();
    var answer = collect();
    answer.submittedAt = new Date().toISOString();
    submitEl.disabled = true;
    setStatus('送信しています…', '');
    setPhase('送信しています', '');
    if (location.protocol === 'file:') {
      showFallback(answer, FALLBACK_MESSAGE);
      return;
    }
    fetch('/answer?t=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(answer)
    }).then(function (response) {
      if (!response.ok) throw new Error('status ' + response.status);
      lock();
      closeSheet();
      fallbackPanel.hidden = true;
      setStatus('送信しました。Claude Code に戻ってください。', 'ok');
      setPhase('送信済み', 'sent');
      try { localStorage.removeItem(draftKey); } catch (e) { /* 消せなくてもよい */ }
    }).catch(function () {
      submitEl.disabled = false;
      showFallback(answer, FALLBACK_MESSAGE);
    });
  });

  restoreDraft();
  refresh();
  select(null);
})();
`.trim()

const recommendedOf = (question: Question): Option | undefined =>
  question.options.find(option => option.recommended === true)

/**
 * 未操作の問いが何で進むかの一文 (右の決定の選択肢の下)。
 */
function defaultTextOf(question: Question): string {
  const recommended = recommendedOf(question)
  return recommended
    ? `何も選ばなければ ${escapeHtml(recommended.id)} で進みます。`
    : '推奨案はありません。選ばなければ AI が選びます。'
}

/**
 * 表の中で、人が埋める欄 (編集できる列) のうち空のものの数。
 */
function blanksOf(table: Table): number {
  const editable = table.editable ?? table.columns.map(() => true)
  return table.rows.reduce(
    (count, row) => count + row.filter((cell, index) => editable[index] === true && cell.trim() === '').length,
    0,
  )
}

function glossaryHtml(form: FormV1): string {
  const entries = form.glossary ?? []
  if (entries.length === 0) return ''
  const items = entries
    .map(entry => `<dt>${escapeHtml(entry.term)}</dt><dd>${escapeHtml(entry.definition)}</dd>`)
    .join('')
  return `<div class="gl"><p class="gl-title">このシートで使う言葉</p><dl>${items}</dl></div>`
}

function choiceHtml(question: Question, option: Option): string {
  const recommended = option.recommended === true
  const preview = option.preview
    ? `<span class="pc"><span class="k">構成案</span><span>${escapeHtml(option.preview)}</span></span>`
    : ''
  return (
    `<label class="choice"${recommended ? ' data-rec="1"' : ''}>` +
    `<input type="radio" name="q-${escapeHtml(question.id)}" value="${escapeHtml(option.id)}">` +
    `<span class="c-top"><span class="radio" aria-hidden="true"></span><span class="opt-id">${escapeHtml(option.id)}</span>` +
    `<span class="c-label">${escapeHtml(option.label)}</span>` +
    `${recommended ? '<span class="ai-rec">AI の推奨</span>' : ''}</span>` +
    `<span class="pc"><span class="k">利点</span><span>${escapeHtml(option.pros)}</span></span>` +
    `<span class="pc"><span class="k">代償</span><span>${escapeHtml(option.cons)}</span></span>` +
    preview +
    `</label>`
  )
}

/**
 * 右に出す決定 (構成案の印を選んだとき)。根拠、選択肢、AI の推奨とその理由、補足の欄です。
 */
function decisionHtml(question: Question, number: number, themeName: string): string {
  const id = escapeHtml(question.id)
  const title = escapeHtml(question.title)
  const recommended = recommendedOf(question)
  const aiBox = recommended
    ? `<div class="ai-box"><p class="p-label">AI の推奨</p>` +
      `<p class="ai-pick">${escapeHtml(recommended.id)}. ${escapeHtml(recommended.label)}</p>` +
      `<p class="ai-why"><span class="k">理由</span><span>${escapeHtml(recommended.pros)}</span></p>` +
      `<p class="ai-note" data-q="${id}" data-role="ai-note">変更しなければこの案で進みます。</p></div>`
    : `<div class="ai-box"><p class="p-label">AI の推奨</p><p class="ai-none">推奨案はありません。選ばなければ AI が選びます。</p></div>`
  const placeholder = question.note?.placeholder ?? '補足があれば 1 行で'
  const choices = question.options.map(option => choiceHtml(question, option)).join('')
  return (
    `<section class="panel" data-q="${id}" data-role="panel" data-state="pending" hidden>` +
    `<div class="p-head"><span class="badge">${number}</span><span class="p-eyebrow">${escapeHtml(themeName)}</span>` +
    `<span class="state" data-q="${id}" data-role="state">未確認</span></div>` +
    `<p class="p-title">${title}</p>` +
    `<div class="p-sec"><p class="p-label">根拠</p><p class="cite">${escapeHtml(question.cite)}</p></div>` +
    `<div class="p-sec"><p class="p-label">選択肢</p><div class="choices" role="radiogroup" aria-label="${title}">${choices}</div>` +
    `<p class="p-row"><span data-q="${id}" data-role="default">${defaultTextOf(question)}</span>` +
    `<button type="button" class="link" data-q="${id}" data-role="clear" hidden>選択を外す</button></p></div>` +
    `<div class="p-sec">${aiBox}</div>` +
    `<div class="p-sec"><label><span class="p-label">補足</span>` +
    `<input type="text" class="note" name="note-${id}" placeholder="${escapeHtml(placeholder)}"></label>` +
    `<p class="help">条件を付けたいとき、どの案でもないときに書きます。補足は選択より優先して読まれます。</p></div>` +
    `<div class="p-foot"><button type="button" class="btn ghost" data-action="next">次の未確認へ</button></div>` +
    `</section>`
  )
}

/**
 * 右に出す表の説明 (構成案の表に触れたとき)。
 */
function tablePanelHtml(table: Table): string {
  const id = escapeHtml(table.id)
  const blanks = blanksOf(table)
  return (
    `<section class="panel" data-t="${id}" data-role="table-panel" hidden>` +
    `<div class="p-head"><span class="badge t">表</span><span class="p-eyebrow">人に埋めてほしい表</span></div>` +
    `<p class="p-title">${escapeHtml(table.title)}</p>` +
    `<p class="t-blank" data-t="${id}" data-role="blank">${blanks === 0 ? '空欄はありません。' : `空欄が ${blanks} か所あります。`}</p>` +
    `<p class="help">左の表の入力欄に直接書きます。空欄のまま送信してもかまいません。</p>` +
    `<div class="p-foot"><button type="button" class="btn ghost" data-action="next">次の未確認へ</button></div>` +
    `</section>`
  )
}

/**
 * 右に出す全体 (何も選んでいないとき)。進み具合、次に見る項目、全体へのコメントの欄です。
 * 次に見る項目はブラウザの JS が選択の状態から決めて描きます。
 */
function overviewHtml(form: FormV1, questions: Question[]): string {
  const globalLabel = form.globalNote?.label ?? '全体へのコメント'
  const tables = form.tables ?? []
  const blankStat = tables.length > 0
    ? `<div data-stat="blank"><dt>表の空欄</dt><dd>${tables.reduce((sum, table) => sum + blanksOf(table), 0)}</dd></div>`
    : ''
  return (
    `<section class="panel" data-panel="overview">` +
    `<p class="p-label">全体の進み具合</p>` +
    `<div class="meter" aria-hidden="true"><span data-meter="confirmed"></span><span data-meter="changed"></span></div>` +
    `<dl class="stats"><div data-stat="confirmed"><dt>確認済み</dt><dd>0</dd></div>` +
    `<div data-stat="changed"><dt>推奨から変更</dt><dd>0</dd></div>` +
    `<div data-stat="pending"><dt>未確認</dt><dd>${questions.length}</dd></div>${blankStat}</dl>` +
    `<div class="p-sec"><p class="p-label">次に見る</p><div class="next" id="di-next"></div></div>` +
    `<div class="p-sec"><label><span class="p-label">${escapeHtml(globalLabel)}</span>` +
    `<textarea name="globalNote" placeholder="問いに収まらないことがあれば、ここに書いてください"></textarea></label>` +
    `<p class="help">問いそのものが的外れなら、ここにそう書いてください。</p></div>` +
    `<p class="help">${HINT}</p>` +
    `</section>`
  )
}

/**
 * 人に埋めてもらう表。サーバで描いておき、ブラウザの JS が構成案の印の位置へ移します。
 */
function tableHtml(table: Table): string {
  const editable = table.editable ?? table.columns.map(() => true)
  const head = table.columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')
  const body = table.rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, cellIndex) =>
          editable[cellIndex]
            ? `<td><input type="text" name="cell-${escapeHtml(table.id)}-${rowIndex}-${cellIndex}" value="${escapeHtml(cell)}"></td>`
            : `<td>${escapeHtml(cell)}</td>`,
        )
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')
  return (
    `<div class="tbl" data-t="${escapeHtml(table.id)}" data-role="table"><table><caption>${escapeHtml(table.title)}</caption>` +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
  )
}

/**
 * 質問票 JSON から自己完結の HTML シート (Review Workspace) を作ります。
 *
 * 構成案 (`form.outline`) は HTML としてそのまま差し込みません。質問票の JSON の中に入れて渡し、
 * ブラウザの JS が許可した要素と属性だけで組み直して描きます。
 * トークンは HTML に埋めません。ブラウザの JS が URL の `?t=` から読んで
 * POST に付けるので、生成した HTML はそのまま受信サーバが配れます。
 *
 * @param input 質問票と日付
 * @returns HTML 全文
 */
export function renderHtml(input: SheetInput): string {
  const { form, date } = input
  const questions = questionsOf(form)
  const tables = form.tables ?? []

  let number = 0
  const decisions = form.themes
    .map(theme =>
      theme.questions
        .map(question => {
          number += 1
          return decisionHtml(question, number, theme.name)
        })
        .join(''),
    )
    .join('')

  const tableCount = tables.length > 0 ? `<span>表 ${tables.length}</span>` : ''

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- document-interview-format: v1 -->
<title>${escapeHtml(form.title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<form id="di-answer" class="app" novalidate>
<header class="topbar">
<div class="brand"><span class="mark">INTERVIEW</span><span class="doc-id">${escapeHtml(form.documentId)}</span><span class="rev">rev ${form.revision}</span></div>
<div class="meta"><span class="date">${escapeHtml(date)}</span><span class="phase" id="di-phase">回答中</span></div>
</header>
<div class="ws" id="di-ws">
<main class="canvas" id="di-canvas">
<article class="doc">
<p class="eyebrow"><span>構成案</span><span>未確定事項 ${questions.length}</span>${tableCount}</p>
<h1>${escapeHtml(form.title)}</h1>
<div class="concl">${escapeHtml(form.conclusion)}</div>
${glossaryHtml(form)}
<div class="outline" id="di-outline"></div>
</article>
<div class="tbl-holder" id="di-tables" hidden>${tables.map(tableHtml).join('')}</div>
</main>
<aside class="inspector" id="di-inspector" aria-label="詳細">
<div class="insp-head"><button type="button" class="crumb" data-action="overview" aria-pressed="true">全体</button><span class="crumb-sep" id="di-crumb-sep" aria-hidden="true" hidden>/</span><span class="crumb-cur" id="di-crumb"></span><button type="button" class="icon-btn sheet-close" data-action="close">閉じる</button></div>
${overviewHtml(form, questions)}
${decisions}
${tables.map(tablePanelHtml).join('')}
</aside>
</div>
<footer class="bar">
<div class="counts" id="di-progress" aria-live="polite"><span class="count" data-count="confirmed"><i></i><span class="lbl">確認済み</span><b>0</b></span><span class="count" data-count="changed"><i></i><span class="lbl">推奨から変更</span><b>0</b></span><span class="count" data-count="pending"><i></i><span class="lbl">未確認</span><b>${questions.length}</b></span></div>
<p class="bar-msg" id="di-status">${HINT}</p>
<button type="button" class="btn ghost only-narrow" data-action="open-overview">全体</button>
<button type="submit" class="btn primary" id="di-submit">送信</button>
</footer>
<div class="fallback" id="di-fallback-panel" hidden>
<div class="fallback-head"><p class="fallback-title" id="di-fallback-message">送信できませんでした</p><button type="button" class="icon-btn" data-action="close-fallback">閉じる</button></div>
<textarea id="di-fallback" readonly></textarea>
</div>
</form>
<script type="application/json" id="di-form">${safeJson(form)}</script>
<script>
${SCRIPT}
</script>
</body>
</html>
`
}
