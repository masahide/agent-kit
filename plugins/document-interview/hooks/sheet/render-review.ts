import { BLOCK_TAGS, DOCUMENT_ATTRIBUTES, DOCUMENT_TAGS } from '../review/document'
import { KEEP_CHIP, REVIEW_CHIPS, type ReviewV1 } from '../review/review-v1'
import { escapeHtml, safeJson, STYLE } from './common'

/**
 * 指摘の画面の生成に要るもの。
 */
export type ReviewSheetInput = {
  /** 検証済みの指摘の画面 */
  review: ReviewV1
  /** 文書の HTML (`interview/<label>.doc.html` の中身、検査済み) */
  html: string
  /** 上部バーに出す日付 (YYYY-MM-DD) */
  date: string
}

/**
 * 指摘が無いときの扱いの一文。
 */
const HINT = '直すところが無ければ、何も付けずに送信すると完了報告に進みます。'

/**
 * 指摘の画面で足す CSS。段落は押せる領域にし、指摘を付けた段落には左の線と、指摘の通し番号の
 * 小さな印を付けます。本文の文字の色は変えません。
 */
const REVIEW_STYLE = `
.lead{margin:0 0 4px;font-size:13px;color:var(--muted)}
.doc-body .blk{cursor:pointer;border-radius:6px;transition:background .15s,box-shadow .15s}
.doc-body .blk:hover{background:var(--surface-2)}
.doc-body .blk:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.doc-body p.blk,.doc-body li.blk,.doc-body dt.blk,.doc-body dd.blk,.doc-body pre.blk,.doc-body h2.blk,.doc-body h3.blk,.doc-body h4.blk{padding-left:6px;margin-left:-6px}
.doc-body .blk.has{box-shadow:inset 3px 0 0 var(--blue)}
.doc-body .blk.has.keep{box-shadow:inset 3px 0 0 var(--green)}
.doc-body tr.blk.has{box-shadow:none}
.doc-body tr.blk.has>:first-child{box-shadow:inset 3px 0 0 var(--blue)}
.doc-body tr.blk.has.keep>:first-child{box-shadow:inset 3px 0 0 var(--green)}
.doc-body .blk.active{background:var(--blue-soft)}
.mk{display:inline-flex;gap:3px;margin-right:6px;vertical-align:1px;user-select:none;-webkit-user-select:none}
.mk i,.c-no{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--blue);color:var(--on-strong);font:700 11px/1 var(--mono);font-style:normal}
.mk i.keep,.c-no.keep{background:var(--green)}
.excerpt{margin:0;max-height:9.5em;overflow:auto;padding:10px 12px;background:var(--surface-2);border-radius:8px;font-size:13px;line-height:1.65;white-space:pre-wrap;word-break:break-word}
.quote-box{display:flex;align-items:flex-start;gap:10px;padding:8px 12px;background:var(--blue-soft);border-radius:8px;font-size:13px}
.quote-box span{flex:1;min-width:0;word-break:break-word}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{padding:5px 11px;background:var(--surface);border:1px solid var(--line);border-radius:999px;font-size:12.5px;line-height:1.4;cursor:pointer}
.chip:hover{border-color:var(--line-strong)}
.chip[aria-pressed="true"]{background:var(--blue);border-color:var(--blue);color:var(--on-strong)}
.chip.keep[aria-pressed="true"]{background:var(--green);border-color:var(--green)}
.add-row{display:flex;gap:8px;margin-top:10px}
.add-row .note{flex:1}
.c-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.c-item{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;background:var(--surface-2);border-radius:8px;font-size:13px;line-height:1.6}
.c-go{flex:1;min-width:0;padding:0;background:none;border:0;text-align:left;cursor:pointer;word-break:break-word}
.c-go:hover .c-body{text-decoration:underline}
.c-at{font:600 12px/1.6 var(--mono);color:var(--muted);margin-right:6px}
.c-chip{font-weight:600;margin-right:6px}
.c-quote{color:var(--muted);margin-right:6px}
.c-del{flex:none}
.c-empty{margin:0;font-size:13px;color:var(--muted)}
`.trim()

/**
 * ブラウザで動かす素の JavaScript。TypeScript の関数を toString で埋めません。
 *
 * すること:
 * - 文書の HTML を DOMParser で解析し、許可した要素と属性だけで組み直す (Claude の HTML は実行しない)
 * - 段落 (自分の文字を持つ h2〜h4、p、li、dt、dd と、pre、表の行) に上から番号を振り、押せる領域にする
 * - 段落を押すか、1 つの段落の中で文字列を選ぶと、右に指摘の操作を出す。チップとコメントで指摘を足す
 * - 指摘を付けた段落に、指摘の通し番号の小さな印を付ける。何も選んでいないときは指摘の一覧を出す
 * - 指摘と全体コメントの下書きを localStorage に保存して復元
 * - [送信] で回答 JSON を `/answer?t=<token>` に POST (token は URL の `?t=` から読む)、失敗時の代替導線
 */
const SCRIPT = `
(function () {
  'use strict';
  var TAGS = ${JSON.stringify(DOCUMENT_TAGS)};
  var ATTRIBUTES = ${JSON.stringify(DOCUMENT_ATTRIBUTES)};
  var BLOCKS = ${JSON.stringify(BLOCK_TAGS)};
  var KEEP = ${JSON.stringify(KEEP_CHIP)};
  var INLINE = { STRONG: true, EM: true, CODE: true, SPAN: true, BR: true };
  var data = JSON.parse(document.getElementById('di-review').textContent);
  var review = data.review;
  var root = document.getElementById('di-answer');
  var ws = document.getElementById('di-ws');
  var canvasEl = document.getElementById('di-canvas');
  var docEl = document.getElementById('di-doc');
  var inspectorEl = document.getElementById('di-inspector');
  var overviewEl = root.querySelector('[data-panel="overview"]');
  var blockPanelEl = root.querySelector('[data-panel="block"]');
  var overviewButton = root.querySelector('[data-action="overview"]');
  var crumbSepEl = document.getElementById('di-crumb-sep');
  var crumbEl = document.getElementById('di-crumb');
  var listEl = document.getElementById('di-list');
  var blockNoEl = document.getElementById('di-block-no');
  var excerptEl = document.getElementById('di-excerpt');
  var quoteBoxEl = document.getElementById('di-quote-box');
  var quoteEl = document.getElementById('di-quote');
  var textEl = document.getElementById('di-text');
  var addEl = document.getElementById('di-add');
  var blockListEl = document.getElementById('di-block-list');
  var phaseEl = document.getElementById('di-phase');
  var statusEl = document.getElementById('di-status');
  var submitEl = document.getElementById('di-submit');
  var fallbackPanel = document.getElementById('di-fallback-panel');
  var fallbackEl = document.getElementById('di-fallback');
  var fallbackMessageEl = document.getElementById('di-fallback-message');
  var draftKey = 'document-interview:review:' + review.documentId + ':' + review.revision + ':' + review.label;
  var token = new URLSearchParams(location.search).get('t') || '';
  var MAX_QUOTE = 200;
  var HINT = ${JSON.stringify(HINT)};

  function all(selector, scope) { return Array.prototype.slice.call((scope || root).querySelectorAll(selector)); }

  // 文書を、許可した要素と属性だけで組み直す
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

  rebuild(new DOMParser().parseFromString(data.html, 'text/html').body, docEl);

  // 段落に番号を振る。自分の文字 (直下の文字か、直下の強調やコードの文字) を持つものだけ。pre と表の行は常に
  function ownText(el) {
    var text = '';
    Array.prototype.forEach.call(el.childNodes, function (node) {
      if (node.nodeType === 3) text += node.nodeValue;
      else if (node.nodeType === 1 && INLINE[node.tagName]) text += node.tagName === 'BR' ? ' ' : node.textContent;
    });
    return text;
  }

  function textOf(el) {
    if (el.tagName === 'TR') {
      return Array.prototype.map.call(el.children, function (cell) { return cell.textContent.trim(); }).join(' | ');
    }
    if (el.tagName === 'PRE') return el.textContent;
    return ownText(el).replace(/\\s+/g, ' ').trim();
  }

  var blocks = [];
  all(BLOCKS.join(','), docEl).forEach(function (el) {
    var always = el.tagName === 'PRE' || el.tagName === 'TR';
    if (!always && ownText(el).trim() === '') return;
    var text = textOf(el);
    if (text.trim() === '') return;
    blocks.push({ el: el, text: text });
    var n = blocks.length;
    el.classList.add('blk');
    el.setAttribute('data-n', String(n));
    el.setAttribute('tabindex', '0');
    el.setAttribute('title', '段落 ' + n);
  });

  var comments = [];
  var current = null;
  var chip = null;

  function blockOf(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentNode);
    var found = el && el.closest ? el.closest('.blk') : null;
    return found && docEl.contains(found) ? Number(found.getAttribute('data-n')) : null;
  }

  function isKeep(comment) { return comment.chip === KEEP; }

  function describe(comment) {
    var parts = [];
    if (comment.chip) parts.push('[' + comment.chip + ']');
    if (comment.quote) parts.push('「' + comment.quote + '」');
    if (comment.text) parts.push(comment.text);
    return parts.join(' ');
  }

  function sorted() {
    return comments
      .map(function (comment, index) { return { comment: comment, no: index + 1 }; })
      .sort(function (a, b) { return a.comment.block - b.comment.block || a.no - b.no; });
  }

  function itemOf(entry, withBlock) {
    var li = document.createElement('li');
    li.className = 'c-item';
    var no = document.createElement('span');
    no.className = 'c-no' + (isKeep(entry.comment) ? ' keep' : '');
    no.textContent = String(entry.no);
    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'c-go';
    if (withBlock) {
      var at = document.createElement('span');
      at.className = 'c-at';
      at.textContent = '#' + entry.comment.block;
      go.appendChild(at);
    }
    var body = document.createElement('span');
    body.className = 'c-body';
    if (entry.comment.chip) {
      var c = document.createElement('span');
      c.className = 'c-chip';
      c.textContent = entry.comment.chip;
      body.appendChild(c);
    }
    if (entry.comment.quote) {
      var q = document.createElement('span');
      q.className = 'c-quote';
      q.textContent = '「' + entry.comment.quote + '」';
      body.appendChild(q);
    }
    if (entry.comment.text) body.appendChild(document.createTextNode(entry.comment.text));
    go.appendChild(body);
    go.addEventListener('click', function () {
      selectBlock(entry.comment.block, '');
      reveal(entry.comment.block);
    });
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'link c-del';
    del.textContent = '消す';
    del.setAttribute('aria-label', '指摘 ' + entry.no + ' を消す');
    del.addEventListener('click', function () {
      comments.splice(entry.no - 1, 1);
      saveDraft();
      render();
    });
    li.appendChild(no);
    li.appendChild(go);
    li.appendChild(del);
    return li;
  }

  function fill(listNode, entries, withBlock, empty) {
    while (listNode.firstChild) listNode.removeChild(listNode.firstChild);
    if (entries.length === 0) {
      var p = document.createElement('p');
      p.className = 'c-empty';
      p.textContent = empty;
      listNode.appendChild(p);
      return;
    }
    var ol = document.createElement('ol');
    ol.className = 'c-list';
    entries.forEach(function (entry) { ol.appendChild(itemOf(entry, withBlock)); });
    listNode.appendChild(ol);
  }

  // 指摘の印、一覧、数を描き直す
  function render() {
    all('.mk', docEl).forEach(function (el) { el.parentNode.removeChild(el); });
    blocks.forEach(function (block) { block.el.classList.remove('has', 'keep'); });
    var byBlock = Object.create(null);
    sorted().forEach(function (entry) { (byBlock[entry.comment.block] = byBlock[entry.comment.block] || []).push(entry); });
    Object.keys(byBlock).forEach(function (key) {
      var block = blocks[Number(key) - 1];
      if (!block) return;
      var entries = byBlock[key];
      block.el.classList.add('has');
      if (entries.every(function (entry) { return isKeep(entry.comment); })) block.el.classList.add('keep');
      var mark = document.createElement('span');
      mark.className = 'mk';
      mark.setAttribute('aria-hidden', 'true');
      entries.forEach(function (entry) {
        var i = document.createElement('i');
        if (isKeep(entry.comment)) i.className = 'keep';
        i.textContent = String(entry.no);
        mark.appendChild(i);
      });
      var host = block.el.tagName === 'TR' ? block.el.firstElementChild : block.el;
      if (host) host.insertBefore(mark, host.firstChild);
    });

    var entries = sorted();
    fill(listEl, entries, true, 'まだ指摘はありません。' + HINT);
    if (current) {
      fill(blockListEl, entries.filter(function (entry) { return entry.comment.block === current.block; }), false, 'この段落の指摘はまだありません。');
    }
    var keep = comments.filter(isKeep).length;
    var stats = { comments: comments.length - keep, keep: keep, blocks: Object.keys(byBlock).length, total: blocks.length };
    all('[data-stat]').forEach(function (el) { el.querySelector('dd').textContent = String(stats[el.getAttribute('data-stat')]); });
    all('[data-count]').forEach(function (el) { el.querySelector('b').textContent = String(stats[el.getAttribute('data-count')]); });
    addEl.disabled = !(chip || textEl.value.trim());
  }

  function setChip(value) {
    chip = value;
    all('.chip').forEach(function (button) {
      button.setAttribute('aria-pressed', button.getAttribute('data-chip') === value ? 'true' : 'false');
    });
    addEl.disabled = !(chip || textEl.value.trim());
  }

  function showOverview() {
    current = null;
    overviewEl.hidden = false;
    blockPanelEl.hidden = true;
    blocks.forEach(function (block) { block.el.classList.remove('active'); });
    overviewButton.setAttribute('aria-pressed', 'true');
    crumbSepEl.hidden = true;
    crumbEl.textContent = '';
    inspectorEl.scrollTop = 0;
  }

  function selectBlock(n, quote) {
    var block = blocks[n - 1];
    if (!block) return;
    current = { block: n, quote: quote };
    overviewEl.hidden = true;
    blockPanelEl.hidden = false;
    blocks.forEach(function (b, index) { b.el.classList.toggle('active', index === n - 1); });
    overviewButton.setAttribute('aria-pressed', 'false');
    crumbSepEl.hidden = false;
    crumbEl.textContent = '段落 ' + n;
    blockNoEl.textContent = '#' + n;
    excerptEl.textContent = block.text;
    quoteEl.textContent = quote ? '「' + quote + '」' : '';
    quoteBoxEl.hidden = !quote;
    textEl.value = '';
    setChip(null);
    render();
    inspectorEl.scrollTop = 0;
    openSheet();
  }

  function reveal(n) {
    var block = blocks[n - 1];
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (block) block.el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }

  function openSheet() { ws.classList.add('sheet-open'); }
  function closeSheet() { ws.classList.remove('sheet-open'); }

  function addComment() {
    if (!current) return;
    var text = textEl.value.trim();
    if (!chip && !text) return;
    comments.push({ block: current.block, chip: chip, quote: current.quote || '', text: text });
    current.quote = '';
    quoteBoxEl.hidden = true;
    textEl.value = '';
    setChip(null);
    saveDraft();
    render();
    setStatus(HINT, '');
  }

  // 左: 段落を押すと、その段落の指摘の操作を出す。1 つの段落の中で文字列を選んでいれば、その文字列に付ける
  canvasEl.addEventListener('click', function (event) {
    var selection = window.getSelection ? window.getSelection() : null;
    if (selection && !selection.isCollapsed && docEl.contains(selection.anchorNode)) {
      var start = blockOf(selection.anchorNode);
      var end = blockOf(selection.focusNode);
      var quote = selection.toString().replace(/\\s+/g, ' ').trim();
      if (start !== null && start === end && quote) {
        selectBlock(start, quote.length > MAX_QUOTE ? quote.slice(0, MAX_QUOTE) + '…' : quote);
        return;
      }
      if (start !== null && start !== end) {
        setStatus('文字列は 1 つの段落の中で選んでください。', 'err');
        return;
      }
    }
    var n = blockOf(event.target);
    if (n === null) {
      showOverview();
      closeSheet();
      return;
    }
    selectBlock(n, '');
  });
  docEl.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var n = blockOf(event.target);
    if (n === null || event.target !== blocks[n - 1].el) return;
    event.preventDefault();
    selectBlock(n, '');
  });

  // 右: チップ、コメント、指摘を足す、全体に戻る
  all('.chip').forEach(function (button) {
    button.addEventListener('click', function () {
      var value = button.getAttribute('data-chip');
      setChip(chip === value ? null : value);
    });
  });
  textEl.addEventListener('input', function () { addEl.disabled = !(chip || textEl.value.trim()); });
  textEl.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    addComment();
  });
  addEl.addEventListener('click', addComment);
  all('[data-action="clear-quote"]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (current) current.quote = '';
      quoteBoxEl.hidden = true;
    });
  });
  overviewButton.addEventListener('click', showOverview);
  all('[data-action="back"]').forEach(function (button) { button.addEventListener('click', showOverview); });
  all('[data-action="open-overview"]').forEach(function (button) {
    button.addEventListener('click', function () { showOverview(); openSheet(); });
  });
  all('[data-action="close"]').forEach(function (button) { button.addEventListener('click', closeSheet); });
  all('[data-action="close-fallback"]').forEach(function (button) {
    button.addEventListener('click', function () { fallbackPanel.hidden = true; });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeSheet();
  });

  var globalEl = root.elements.namedItem('globalNote');
  if (globalEl) globalEl.addEventListener('input', saveDraft);

  function collect() {
    var texts = {};
    comments.forEach(function (comment) {
      var block = blocks[comment.block - 1];
      if (block) texts[String(comment.block)] = block.text;
    });
    return {
      schemaVersion: 1,
      kind: 'review',
      documentId: review.documentId,
      revision: review.revision,
      comments: comments.map(function (comment) {
        return { block: comment.block, chip: comment.chip, quote: comment.quote, text: comment.text };
      }),
      blocks: texts,
      globalNote: globalEl ? globalEl.value : ''
    };
  }

  function saveDraft() {
    try { localStorage.setItem(draftKey, JSON.stringify(collect())); } catch (e) { /* 保存できなくても続ける */ }
  }

  function restoreDraft() {
    var raw = null;
    try { raw = localStorage.getItem(draftKey); } catch (e) { return; }
    if (!raw) return;
    var saved;
    try { saved = JSON.parse(raw); } catch (e) { return; }
    if (!saved || saved.kind !== 'review' || !Array.isArray(saved.comments)) return;
    saved.comments.forEach(function (comment) {
      if (!comment || typeof comment.block !== 'number' || !blocks[comment.block - 1]) return;
      comments.push({
        block: comment.block,
        chip: typeof comment.chip === 'string' ? comment.chip : null,
        quote: typeof comment.quote === 'string' ? comment.quote : '',
        text: typeof comment.text === 'string' ? comment.text : ''
      });
    });
    if (globalEl && typeof saved.globalNote === 'string') globalEl.value = saved.globalNote;
  }

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
    all('input, textarea, .chip, .c-del, #di-add').forEach(function (el) { el.disabled = true; });
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
  showOverview();
  render();
})();
`.trim()

function chipsHtml(): string {
  return REVIEW_CHIPS.map(
    chip =>
      `<button type="button" class="chip${chip === KEEP_CHIP ? ' keep' : ''}" data-chip="${escapeHtml(chip)}" aria-pressed="false">${escapeHtml(chip)}</button>`,
  ).join('')
}

/**
 * 右に出す全体 (何も選んでいないとき)。指摘の数、指摘の一覧、全体へのコメントの欄です。
 */
function overviewHtml(): string {
  return (
    `<section class="panel" data-panel="overview">` +
    `<p class="p-label">指摘の数</p>` +
    `<dl class="stats"><div data-stat="comments"><dt>指摘</dt><dd>0</dd></div>` +
    `<div data-stat="keep"><dt>ここは良い</dt><dd>0</dd></div>` +
    `<div data-stat="blocks"><dt>指摘した段落</dt><dd>0</dd></div>` +
    `<div data-stat="total"><dt>段落</dt><dd>0</dd></div></dl>` +
    `<div class="p-sec"><p class="p-label">指摘の一覧</p><div id="di-list"></div></div>` +
    `<div class="p-sec"><label><span class="p-label">全体へのコメント</span>` +
    `<textarea name="globalNote" placeholder="段落に収まらないことがあれば、ここに書いてください"></textarea></label></div>` +
    `<p class="help">段落を押すか、段落の中の文字列を選ぶと、指摘を付けられます。${HINT}</p>` +
    `</section>`
  )
}

/**
 * 右に出す段落 (左で段落を押したとき)。段落の文字列、選んだ文字列、チップ、コメント、この段落の指摘です。
 */
function blockPanelHtml(): string {
  return (
    `<section class="panel" data-panel="block" hidden>` +
    `<div class="p-head"><span class="badge t" id="di-block-no">#</span><span class="p-eyebrow">段落</span></div>` +
    `<p class="excerpt" id="di-excerpt"></p>` +
    `<div class="p-sec quote-box" id="di-quote-box" hidden><span id="di-quote"></span>` +
    `<button type="button" class="link" data-action="clear-quote">外す</button></div>` +
    `<div class="p-sec"><p class="p-label">チップ</p><div class="chips">${chipsHtml()}</div>` +
    `<div class="add-row"><input type="text" class="note" id="di-text" placeholder="コメント (任意、1 行)" aria-label="コメント">` +
    `<button type="button" class="btn primary" id="di-add" disabled>指摘を足す</button></div>` +
    `<p class="help">チップかコメントのどちらかがあれば足せます。1 つの段落に何件でも付けられます。</p></div>` +
    `<div class="p-sec"><p class="p-label">この段落の指摘</p><div id="di-block-list"></div></div>` +
    `<div class="p-foot"><button type="button" class="btn ghost" data-action="back">全体に戻る</button></div>` +
    `</section>`
  )
}

/**
 * 書き上げた文書から自己完結の HTML (指摘の画面) を作ります。
 *
 * 文書の HTML はそのまま差し込みません。JSON の中に入れて渡し、ブラウザの JS が許可した要素と
 * 属性だけで組み直して描きます。トークンは HTML に埋めず、ブラウザの JS が URL の `?t=` から読みます。
 *
 * @param input 指摘の画面、文書の HTML、日付
 * @returns HTML 全文
 */
export function renderReviewHtml(input: ReviewSheetInput): string {
  const { review, html, date } = input
  const part = review.part ? `<span>${review.part.index} / ${review.part.total} 回目</span>` : ''
  const partMeta = review.part ? `<span class="rev">${review.part.index}/${review.part.total}</span>` : ''
  const source = review.source ? `<span>${escapeHtml(review.source)}</span>` : ''

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- document-interview-format: review-v1 -->
<title>${escapeHtml(review.title)}</title>
<style>
${STYLE}
${REVIEW_STYLE}
</style>
</head>
<body>
<form id="di-answer" class="app" novalidate>
<header class="topbar">
<div class="brand"><span class="mark">REVIEW</span><span class="doc-id">${escapeHtml(review.documentId)}</span><span class="rev">rev ${review.revision}</span>${partMeta}</div>
<div class="meta"><span class="date">${escapeHtml(date)}</span><span class="phase" id="di-phase">指摘中</span></div>
</header>
<div class="ws" id="di-ws">
<main class="canvas" id="di-canvas">
<article class="doc">
<p class="eyebrow"><span>書き上げた文書</span>${source}${part}</p>
<h1>${escapeHtml(review.title)}</h1>
<p class="lead">段落を押すか、段落の中の文字列を選ぶと、右で指摘を付けられます。</p>
<div class="outline doc-body" id="di-doc"></div>
</article>
</main>
<aside class="inspector" id="di-inspector" aria-label="指摘">
<div class="insp-head"><button type="button" class="crumb" data-action="overview" aria-pressed="true">全体</button><span class="crumb-sep" id="di-crumb-sep" aria-hidden="true" hidden>/</span><span class="crumb-cur" id="di-crumb"></span><button type="button" class="icon-btn sheet-close" data-action="close">閉じる</button></div>
${overviewHtml()}
${blockPanelHtml()}
</aside>
</div>
<footer class="bar">
<div class="counts" id="di-progress" aria-live="polite"><span class="count" data-count="comments"><span class="lbl">指摘</span><b>0</b></span><span class="count" data-count="keep"><span class="lbl">ここは良い</span><b>0</b></span></div>
<p class="bar-msg" id="di-status">${HINT}</p>
<button type="button" class="btn ghost only-narrow" data-action="open-overview">全体</button>
<button type="submit" class="btn primary" id="di-submit">送信</button>
</footer>
<div class="fallback" id="di-fallback-panel" hidden>
<div class="fallback-head"><p class="fallback-title" id="di-fallback-message">送信できませんでした</p><button type="button" class="icon-btn" data-action="close-fallback">閉じる</button></div>
<textarea id="di-fallback" readonly></textarea>
</div>
</form>
<script type="application/json" id="di-review">${safeJson({ review, html })}</script>
<script>
${SCRIPT}
</script>
</body>
</html>
`
}
