import type { LiveV1 } from '../live/live-v1'
import { STRINGS } from '../views/strings'
import { escapeHtml, safeJson, STYLE } from './common'

/**
 * ライブ表示の生成に要るもの。
 */
export type LiveSheetInput = {
  /** 検証済みのライブ表示 */
  live: LiveV1
  /** 上部バーに出す日付 (YYYY-MM-DD) */
  date: string
}

/**
 * ライブ表示で足す CSS。下部バーは無く、狭い画面では右の欄を文書の下に置きます。
 */
const LIVE_STYLE = `
.app.live{--bar-h:0px}
.lead{margin:0 0 4px;font-size:13px;color:var(--muted)}
.doc-body{min-height:40vh}
.doc-body .md-table{white-space:pre;overflow:auto}
.doc-body .caret{display:inline-block;width:7px;height:1.1em;margin-left:2px;vertical-align:-2px;background:var(--blue);animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.app.idle .caret{display:none}
.empty{color:var(--faint);font-size:13.5px}
.follow{position:fixed;left:calc((100vw - var(--insp-w)) / 2);bottom:24px;transform:translateX(-50%);z-index:30;box-shadow:var(--shadow)}
.live-state{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600}
.live-state::before{content:"";width:8px;height:8px;border-radius:999px;background:var(--green)}
.app.idle .live-state::before{background:var(--faint)}
.app.stopped .live-state::before{background:var(--red)}
.quote-box{display:flex;align-items:flex-start;gap:10px;padding:8px 12px;background:var(--blue-soft);border-radius:8px;font-size:13px}
.quote-box span{flex:1;min-width:0;word-break:break-word}
.send-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.send-row .btn{flex:1;padding:8px 10px;font-size:13px}
.btn.stop{background:var(--red);color:var(--on-strong)}
.btn.stop:disabled,.btn.ghost:disabled{opacity:.5;cursor:default}
.c-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.c-item{padding:8px 10px;background:var(--surface-2);border-radius:8px;font-size:13px;line-height:1.6;word-break:break-word}
.c-quote{color:var(--muted);margin-right:6px}
.c-state{display:inline-block;margin-right:6px;padding:0 6px;border-radius:4px;background:var(--ai-soft);color:var(--ai);font:600 11px/18px var(--sans);vertical-align:1px}
.c-state.delivered{background:var(--green-soft);color:var(--green)}
.c-state.stopped{background:var(--red-soft);color:var(--red)}
.c-state.carried{background:var(--amber-soft);color:var(--amber)}
.c-empty{margin:0;font-size:13px;color:var(--muted)}
@media (max-width:900px){
.app.live .inspector{position:static;transform:none;visibility:visible;max-height:none;height:auto;border-radius:0;box-shadow:none;border-top:1px solid var(--line)}
.follow{left:50%}
}
`.trim()

/**
 * ブラウザで動かす素の JavaScript。
 *
 * すること:
 * - `/events` (SSE) を `EventSource` で受け、snapshot / replace / append / status / comments / redirect を当てる
 * - 文書を小さな Markdown 描画器で描く (見出し、段落、箇条書き、番号付き、コードフェンス、引用、水平線、
 *   行の中の太字とコード。表は記法のまま等幅)。`textContent` と `createElement` だけで描き、`innerHTML` は使わない
 * - 描き直しは 100 ms ごとにまとめる (requestAnimationFrame)
 * - 最下部に追従する。上へスクロールしたら追従を止め、[最新へ] を出す。文字列を選んでいる間も追従しない
 * - 文書の文字列を選ぶと引用欄に入れ、コメントと一緒に `/comments` へ POST する (ライブ指摘)
 * - 書きかけの指摘を localStorage に残し、再読み込みで戻す
 */
/** 画面が持つ文書の上限 (文字)。受信サーバの LIVE_MAX_TEXT と同じ */
const MAX_TEXT = 100000

const SCRIPT = `
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('di-live').textContent);
  var live = data.live;
  var root = document.getElementById('di-app');
  var docEl = document.getElementById('di-doc');
  var stateEl = document.getElementById('di-state');
  var phaseEl = document.getElementById('di-phase');
  var elapsedEl = document.getElementById('di-elapsed');
  var charsEl = document.getElementById('di-chars');
  var followEl = document.getElementById('di-follow');
  var quoteBoxEl = document.getElementById('di-quote-box');
  var quoteEl = document.getElementById('di-quote');
  var textEl = document.getElementById('di-text');
  var afterEl = document.getElementById('di-after');
  var nowEl = document.getElementById('di-now');
  var listEl = document.getElementById('di-list');
  var noteEl = document.getElementById('di-note');
  var noticeEl = document.getElementById('di-notice');
  var token = new URLSearchParams(location.search).get('t') || '';
  var query = '?t=' + encodeURIComponent(token);
  var draftKey = 'doc-desk:live:' + live.documentId + ':' + live.label;
  var MAX_QUOTE = 200;
  var STATES = {
    waiting: '送りました',
    taken: 'Claude 側で受け取りました',
    delivered: '届けました (Write の後)',
    stopped: '止めました',
    carried: '指摘の画面へ持ち越し'
  };
  // 状態の種類 (hooks/live/live-v1.ts の LivePhase)。画面は文言ではなくこれで振る舞いを決める
  var IDLE_PHASES = { done: true, aborted: true, ended: true, moving: true, closed: true };
  var MAX_TEXT = ${MAX_TEXT};
  // 受信サーバが文言なしで流す状態の文 (hooks/views/strings.ts から埋める)
  var MOVING_TEXT = ${JSON.stringify(STRINGS.liveMoving)};
  var CLOSED_TEXTS = ${JSON.stringify(STRINGS.liveClosedOf)};

  var text = '';
  var quote = '';
  var following = true;
  var scheduled = false;
  var openedAt = Date.now();
  var nowLockedUntil = 0;
  var isStopSeen = false;
  var isRedrawDeferred = false;

  // 行の中の太字とコードの印だけを描く
  function inline(parent, line) {
    var pattern = /(\\*\\*[^*]+\\*\\*|\`[^\`]+\`)/g;
    var last = 0;
    var match;
    while ((match = pattern.exec(line)) !== null) {
      if (match.index > last) parent.appendChild(document.createTextNode(line.slice(last, match.index)));
      var marked = match[0];
      var el = document.createElement(marked.charAt(0) === '*' ? 'strong' : 'code');
      el.textContent = marked.charAt(0) === '*' ? marked.slice(2, -2) : marked.slice(1, -1);
      parent.appendChild(el);
      last = match.index + marked.length;
    }
    if (last < line.length) parent.appendChild(document.createTextNode(line.slice(last)));
  }

  function add(parent, tag, className) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    parent.appendChild(el);
    return el;
  }

  // 行単位で描く。閉じていないコードフェンスや途中の箇条書きは、開いたまま描く
  function renderMarkdown(source, target) {
    while (target.firstChild) target.removeChild(target.firstChild);
    var lines = source.split('\\n');
    var paragraph = null, list = null, listTag = '', blockquote = null, fence = null, table = null;
    function close() { paragraph = null; list = null; listTag = ''; blockquote = null; table = null; }
    lines.forEach(function (line) {
      if (fence) {
        if (/^\\s*\`\`\`/.test(line)) { fence = null; return; }
        fence.textContent += (fence.textContent ? '\\n' : '') + line;
        return;
      }
      if (/^\\s*\`\`\`/.test(line)) {
        close();
        fence = add(add(target, 'pre'), 'code');
        return;
      }
      if (line.trim() === '') { close(); return; }
      var heading = /^(#{1,4})\\s+(.*)$/.exec(line);
      if (heading) {
        close();
        inline(add(target, 'h' + (heading[1].length + 1)), heading[2]);
        return;
      }
      if (/^\\s*(-{3,}|\\*{3,}|_{3,})\\s*$/.test(line)) { close(); add(target, 'hr'); return; }
      if (/^\\s*\\|/.test(line)) {
        if (!table) { close(); table = add(target, 'pre', 'md-table'); }
        table.textContent += (table.textContent ? '\\n' : '') + line;
        return;
      }
      var bullet = /^\\s*[-*+]\\s+(.*)$/.exec(line);
      var numbered = /^\\s*\\d+[.)]\\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        var tag = bullet ? 'ul' : 'ol';
        if (!list || listTag !== tag) { close(); list = add(target, tag); listTag = tag; }
        inline(add(list, 'li'), (bullet || numbered)[1]);
        return;
      }
      var quoted = /^\\s*>\\s?(.*)$/.exec(line);
      if (quoted) {
        if (!blockquote) { close(); blockquote = add(add(target, 'blockquote'), 'p'); }
        else blockquote.appendChild(document.createTextNode(' '));
        inline(blockquote, quoted[1]);
        return;
      }
      if (list && /^\\s{2,}\\S/.test(line) && list.lastChild) {
        list.lastChild.appendChild(document.createTextNode(' '));
        inline(list.lastChild, line.trim());
        return;
      }
      if (paragraph) paragraph.appendChild(document.createTextNode(' '));
      else { close(); paragraph = add(target, 'p'); }
      inline(paragraph, line);
    });
    if (source === '') {
      add(target, 'p', 'empty').textContent = 'Claude が書き始めると、ここに文書が流れます。';
    }
    var last = target.lastElementChild;
    if (last && source !== '') {
      var host = last.tagName === 'UL' || last.tagName === 'OL' || last.tagName === 'BLOCKQUOTE' ? (last.lastElementChild || last) : last;
      add(host.tagName === 'PRE' ? host.lastElementChild || host : host, 'span', 'caret').setAttribute('aria-hidden', 'true');
    }
  }

  function isSelecting() {
    var selection = window.getSelection();
    return !!selection && !selection.isCollapsed && docEl.contains(selection.anchorNode);
  }

  function isAtBottom() {
    return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 48;
  }

  // 文字列を選んでいる間は描き直さない (描き直すと選択が消え、追従も止められない)。選択が外れたら描き直す
  function draw() {
    scheduled = false;
    charsEl.textContent = String(text.length);
    if (isSelecting()) {
      isRedrawDeferred = true;
      return;
    }
    isRedrawDeferred = false;
    renderMarkdown(text, docEl);
    if (following) window.scrollTo(0, document.documentElement.scrollHeight);
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () { requestAnimationFrame(draw); }, 100);
  }

  function textOf(status) {
    if (status.text) return status.text;
    if (status.phase === 'moving') return MOVING_TEXT;
    if (status.phase === 'closed') return CLOSED_TEXTS[status.reason] || CLOSED_TEXTS.closed;
    return '';
  }

  function setState(status) {
    if (!status) return;
    var text = textOf(status);
    if (!text) return;
    stateEl.textContent = text;
    phaseEl.textContent = text;
    root.classList.toggle('idle', IDLE_PHASES[status.phase] === true);
    root.classList.toggle('stopped', status.phase === 'stopped');
    if (status.phase === 'stopped') isStopSeen = true;
    if (status.phase === 'moving') noteEl.textContent = '指摘の画面へ移ります。ここからは指摘の画面で指摘を付けてください。';
    if (status.phase === 'closed') {
      // 受信サーバが終わる。再接続を試み続けない
      root.classList.add('closed');
      events.close();
      noteEl.textContent = 'ライブ表示は終わりました。指摘は送れません。';
      afterEl.disabled = true;
      nowEl.disabled = true;
    }
  }

  function trimmed(value) {
    return value.length > MAX_TEXT ? value.slice(value.length - MAX_TEXT) : value;
  }

  function showTruncated(payload) {
    noticeEl.hidden = !(payload && payload.truncated);
  }

  function renderComments(comments) {
    while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
    if (!comments.length) {
      add(listEl, 'p', 'c-empty').textContent = 'まだ指摘はありません。';
      return;
    }
    var ol = add(listEl, 'ol', 'c-list');
    comments.forEach(function (comment) {
      var li = add(ol, 'li', 'c-item');
      var state = add(li, 'span', 'c-state ' + comment.state);
      state.textContent = (comment.mode === 'now' ? '今すぐ / ' : '書き終わったら / ') + (STATES[comment.state] || comment.state);
      if (comment.quote) add(li, 'span', 'c-quote').textContent = '「' + comment.quote + '」';
      li.appendChild(document.createTextNode(comment.text));
    });
  }

  function setQuote(value) {
    quote = value.replace(/\\s+/g, ' ').trim().slice(0, MAX_QUOTE);
    quoteEl.textContent = quote ? '「' + quote + '」' : '';
    quoteBoxEl.hidden = !quote;
    saveDraft();
  }

  function saveDraft() {
    try { localStorage.setItem(draftKey, JSON.stringify({ quote: quote, text: textEl.value })); } catch (e) { /* 保存できなくても続ける */ }
  }

  function restoreDraft() {
    try {
      var saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
      if (saved && typeof saved.text === 'string') textEl.value = saved.text;
      if (saved && typeof saved.quote === 'string') setQuote(saved.quote);
    } catch (e) { /* 読めなければ空から */ }
  }

  function refreshButtons() {
    if (root.classList.contains('closed')) return;
    var empty = textEl.value.trim() === '';
    afterEl.disabled = empty;
    nowEl.disabled = empty || Date.now() < nowLockedUntil;
  }

  function send(mode) {
    var body = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      quote: quote,
      text: textEl.value.trim(),
      mode: mode,
      at: text.length
    };
    if (!body.text) return;
    if (mode === 'now') nowLockedUntil = Date.now() + 10000;
    afterEl.disabled = true;
    nowEl.disabled = true;
    fetch('/comments' + query, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (response) {
        if (response.status === 409) {
          nowLockedUntil = 0;
          noteEl.textContent = 'もう指摘の画面へ移るところなので、この指摘は送れません。指摘の画面で付けてください。';
          return;
        }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        textEl.value = '';
        setQuote('');
        noteEl.textContent = mode === 'now' ? 'Claude を止めて、書き直しを頼みます。' : '今の書き込みが終わったら Claude に届きます。';
      })
      .catch(function () {
        nowLockedUntil = 0;
        noteEl.textContent = '送れませんでした。受信サーバが終わっているかもしれません。/doc-desk-resume で開き直してください。';
      })
      .then(refreshButtons);
    setTimeout(refreshButtons, 10050);
  }

  // マウスでもキーボード (Shift と矢印) でも、文書の中で選んだ文字列を引用に入れる
  document.addEventListener('selectionchange', function () {
    if (isSelecting()) {
      setQuote(String(window.getSelection()));
      return;
    }
    if (isRedrawDeferred) schedule();
  });
  document.getElementById('di-quote-clear').addEventListener('click', function () { setQuote(''); });
  textEl.addEventListener('input', function () { saveDraft(); refreshButtons(); });
  afterEl.addEventListener('click', function () { send('after'); });
  nowEl.addEventListener('click', function () { send('now'); });
  followEl.addEventListener('click', function () {
    following = true;
    followEl.hidden = true;
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  window.addEventListener('scroll', function () {
    following = isAtBottom();
    followEl.hidden = following;
  }, { passive: true });

  setInterval(function () {
    elapsedEl.textContent = String(Math.floor((Date.now() - openedAt) / 1000));
  }, 1000);

  function onDocumentChanged() {
    // Claude の書き直しが始まったら [今すぐ止めて直す] を戻す
    if (isStopSeen) { isStopSeen = false; nowLockedUntil = 0; }
    schedule();
    refreshButtons();
  }

  var events = new EventSource('/events' + query);
  function on(name, handler) {
    events.addEventListener(name, function (event) {
      var payload;
      try { payload = JSON.parse(event.data); } catch (e) { return; }
      handler(payload);
    });
  }
  on('snapshot', function (payload) {
    text = typeof payload.text === 'string' ? payload.text : '';
    setState(payload.status);
    showTruncated(payload);
    renderComments(Array.isArray(payload.comments) ? payload.comments : []);
    schedule();
  });
  on('replace', function (payload) { text = trimmed(String(payload.text || '')); onDocumentChanged(); });
  on('append', function (payload) { text = trimmed(text + String(payload.text || '')); onDocumentChanged(); });
  on('status', setState);
  on('truncated', showTruncated);
  on('comments', function (payload) { renderComments(Array.isArray(payload.comments) ? payload.comments : []); });
  on('redirect', function (payload) {
    events.close();
    if (typeof payload.url === 'string' && payload.url.indexOf('http://127.0.0.1:') === 0) location.href = payload.url;
  });
  events.onerror = function () {
    if (events.readyState === EventSource.CLOSED || !root.classList.contains('idle')) {
      noteEl.textContent = '受信サーバとの接続が切れました。/doc-desk-resume で開き直せます。';
    }
  };

  restoreDraft();
  refreshButtons();
  draw();
})();
`

/**
 * ライブ表示の自己完結の HTML を作ります。文書の中身は含みません (受信サーバの SSE で流れてきます)。
 * トークンは HTML に埋めず、ブラウザの JS が URL の `?t=` から読みます。
 *
 * @param input ライブ表示と日付
 * @returns HTML 全文
 */
export function renderLiveHtml(input: LiveSheetInput): string {
  const { live, date } = input
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- doc-desk-format: live-v1 -->
<title>${escapeHtml(live.title)} (書いています)</title>
<style>
${STYLE}
${LIVE_STYLE}
</style>
</head>
<body>
<div id="di-app" class="app live">
<header class="topbar">
<div class="brand"><span class="mark">LIVE</span><span class="doc-id">${escapeHtml(live.documentId)}</span></div>
<div class="meta"><span class="date">${escapeHtml(date)}</span><span class="phase" id="di-phase">書き始めるのを待っています</span></div>
</header>
<div class="ws">
<main class="canvas">
<article class="doc">
<p class="eyebrow"><span>書いている文書</span><span>${escapeHtml(live.source)}</span></p>
<h1>${escapeHtml(live.title)}</h1>
<p class="lead">Claude が書いている文がここに流れます。読みながら気づいたことは、文字列を選んで右から指摘できます。</p>
<div class="outline doc-body" id="di-doc"></div>
</article>
</main>
<aside class="inspector" aria-label="状態とライブ指摘">
<div class="panel">
<p class="live-state" id="di-state" aria-live="polite">書き始めるのを待っています</p>
<dl class="stats"><div><dt>経過 (秒)</dt><dd id="di-elapsed">0</dd></div><div><dt>文字数</dt><dd id="di-chars">0</dd></div></dl>
<p class="help" id="di-notice" hidden>${escapeHtml(STRINGS.liveTruncated)}</p>
<p class="help">タブを閉じても Claude の作業は止まりません。/doc-desk-resume で開き直せます。書き終わると、このタブが指摘の画面へ移ります。</p>
<div class="p-sec">
<p class="p-label">ライブ指摘</p>
<div class="quote-box" id="di-quote-box" hidden><span id="di-quote"></span><button type="button" class="icon-btn" id="di-quote-clear">外す</button></div>
<textarea id="di-text" placeholder="気づいたこと (例: 90 日を選んだはず)。文書の文字列を選ぶと引用に入ります"></textarea>
<div class="send-row"><button type="button" class="btn ghost" id="di-after">書き終わったら直す</button><button type="button" class="btn stop" id="di-now">今すぐ止めて直す</button></div>
<p class="help" id="di-note">[書き終わったら直す] は今の書き込みが終わった時に、[今すぐ止めて直す] は Claude を止めて届けます。</p>
</div>
<div class="p-sec">
<p class="p-label">送った指摘</p>
<div id="di-list"></div>
</div>
</div>
</aside>
</div>
<button type="button" class="btn primary follow" id="di-follow" hidden>最新へ</button>
</div>
<script type="application/json" id="di-live">${safeJson({ live })}</script>
<script>
${SCRIPT}
</script>
</body>
</html>
`
}
