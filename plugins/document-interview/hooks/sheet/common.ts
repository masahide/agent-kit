/**
 * 質問票のシート (render-html.ts) と指摘の画面 (render-review.ts) が共有する部品。
 */

/**
 * HTML のテキストと属性値の逃がし。
 */
export const escapeHtml = (text: string): string =>
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

export const safeJson = (value: unknown): string =>
  JSON.stringify(value)
    .split('<')
    .join('\\u003c')
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029')

/**
 * Review Workspace の CSS。質問票のシートと指摘の画面で共有し、指摘の画面は `render-review.ts` で足します。
 * 左の Canvas は構成案 (指摘の画面では書き上げた文書) で、未確定事項 (問い) を番号付きの印で示します。
 * 右の Inspector は、左で選んだものに応じて中身が変わります (何も選んでいないときは全体の
 * 進み具合と次に見る項目、印なら決定、表なら表の説明)。下部バーは進捗と送信です。
 *
 * 色は意味ごとに分けます。青は選択と操作、赤は推奨からの変更と失敗、緑は確認済み、
 * 黄は未確認、灰は AI の推奨です。外部リソースは読みません (フォントもシステムフォント)。
 * 900px より狭い画面では、Inspector は下から出る領域になります。
 */
export const STYLE = `
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
