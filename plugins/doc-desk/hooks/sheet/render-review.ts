import { BLOCK_TAGS, DOCUMENT_ATTRIBUTES, DOCUMENT_TAGS } from '../review/document'
import type { ReviewCandidate } from '../review/candidates'
import { CANDIDATE_MARK } from '../review/format'
import { KEEP_CHIP, REVIEW_CHIPS, type ReviewV1 } from '../review/review-v1'
import { escapeHtml, safeJson, STYLE } from './common'

/**
 * 指摘の画面の生成に要るもの。
 */
export type ReviewSheetInput = {
  /** 検証済みの指摘の画面 */
  review: ReviewV1
  /** 文書の HTML (`doc-desk/<label>.doc.html` の中身、検査済み) */
  html: string
  /** 上部バーに出す日付 (YYYY-MM-DD) */
  date: string
  /** Claude が自分の文書に付けた指摘の候補 (`review/candidates.ts`)。無ければ省略 */
  candidates?: readonly ReviewCandidate[]
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
.doc-body .blk.edited,.doc-body .blk.moved{box-shadow:inset 3px 0 0 var(--red)}
.doc-body .blk.deleted{box-shadow:inset 3px 0 0 var(--red);opacity:.55;text-decoration:line-through}
.doc-body tr.blk.edited,.doc-body tr.blk.moved,.doc-body tr.blk.deleted{box-shadow:none}
.doc-body tr.blk.edited>:first-child,.doc-body tr.blk.moved>:first-child,.doc-body tr.blk.deleted>:first-child{box-shadow:inset 3px 0 0 var(--red)}
.doc-body .added{cursor:pointer;padding-left:6px;margin-left:-6px;border-radius:6px;background:var(--red-soft);box-shadow:inset 3px 0 0 var(--red)}
.doc-body tr.added{box-shadow:none}
.etag{display:inline-block;margin-right:6px;padding:0 6px;border-radius:4px;background:var(--red-soft);color:var(--red);font:600 11px/18px var(--sans);vertical-align:1px;user-select:none;-webkit-user-select:none}
.edit-actions{display:flex;flex-wrap:wrap;gap:6px}
.edit-actions .btn{padding:5px 12px;font-size:12.5px;font-weight:500}
.editor{margin-top:10px}
.editor textarea{min-height:96px}
.editor-row{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:8px;font-size:13px}
.editor-row input{width:84px;padding:6px 8px;background:var(--surface);border:1px solid var(--line);border-radius:6px}
.doc-body mark{color:inherit;border-radius:3px;padding:1px 0;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.doc-body mark.sel{background:#FFE08A;box-shadow:0 0 0 2px #F2A20C}
.doc-body mark.q{background:var(--blue-soft);border-bottom:2px solid var(--blue)}
.doc-body mark.q.keep{background:var(--green-soft);border-bottom-color:var(--green)}
.doc-body mark.q[data-no]::after{content:attr(data-no);display:inline-grid;place-items:center;min-width:15px;height:15px;margin-left:2px;padding:0 4px;border-radius:999px;background:var(--blue);color:var(--on-strong);font:700 10px/1 var(--mono);vertical-align:2px}
.doc-body mark.q.keep[data-no]::after{background:var(--green)}
@media (prefers-color-scheme:dark){.doc-body mark.sel{background:rgba(244,183,64,.35);box-shadow:0 0 0 2px var(--amber)}}
.modes{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.mode{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:12.5px;line-height:1.5;color:var(--muted);cursor:pointer}
.mode:has(input:checked){border-color:var(--blue);background:var(--blue-soft)}
.mode input{margin:3px 0 0}
.mode b{display:block;color:var(--ink);font-size:13px}
.e-no{flex:none;padding:0 6px;border-radius:4px;background:var(--red-soft);color:var(--red);font:600 11px/20px var(--sans)}
.doc-body .blk.cand{background:var(--amber-soft)}
.ctag,.c-src{display:inline-block;margin-right:6px;padding:0 6px;border-radius:4px;background:var(--amber-soft);color:var(--amber);font:600 11px/18px var(--sans);vertical-align:1px;user-select:none;-webkit-user-select:none}
.cand-actions{display:flex;flex:none;gap:6px}
.cand-actions .btn{padding:3px 10px;font-size:12px;font-weight:500}
`.trim()

/**
 * ブラウザで動かす素の JavaScript。TypeScript の関数を toString で埋めません。
 *
 * すること:
 * - 文書の HTML を DOMParser で解析し、許可した要素と属性だけで組み直す (Claude の HTML は実行しない)
 * - 段落 (自分の文字を持つ h2〜h4、p、li、dt、dd と、pre、表の行) に上から番号を振り、押せる領域にする
 * - 段落を押すか、1 つの段落の中で文字列を選ぶと、右に指摘の操作を出す。チップとコメントで指摘を足す
 * - 指摘を付けた段落に、指摘の通し番号の小さな印を付ける。何も選んでいないときは指摘の一覧を出す
 * - Claude の候補 (data.candidates) を段落の帯と右の一覧に出し、[採用] で指摘に入れ、[却下] で消す
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
  var CANDIDATE_MARK = ${JSON.stringify(CANDIDATE_MARK)};
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
  var editListEl = document.getElementById('di-edit-list');
  var editAllEl = document.getElementById('di-edit-all');
  var candAllSecEl = document.getElementById('di-cand-all-sec');
  var candAllEl = document.getElementById('di-cand-all');
  var candBlockSecEl = document.getElementById('di-cand-block-sec');
  var candBlockEl = document.getElementById('di-cand-block');
  var editorEl = document.getElementById('di-editor');
  var editorLabelEl = document.getElementById('di-editor-label');
  var editorTextEl = document.getElementById('di-editor-text');
  var MODE_LABELS = { exact: 'そのまま', guide: '参考にして直す' };
  var moverEl = document.getElementById('di-mover');
  var moveToEl = document.getElementById('di-move-to');
  var deleteEl = root.querySelector('[data-edit="delete"]');
  var phaseEl = document.getElementById('di-phase');
  var statusEl = document.getElementById('di-status');
  var submitEl = document.getElementById('di-submit');
  var fallbackPanel = document.getElementById('di-fallback-panel');
  var fallbackEl = document.getElementById('di-fallback');
  var fallbackMessageEl = document.getElementById('di-fallback-message');
  var draftKey = 'doc-desk:review:' + review.documentId + ':' + review.revision + ':' + review.label;
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
    blocks.push({ el: el, text: text, orig: null });
    var n = blocks.length;
    el.classList.add('blk');
    el.setAttribute('data-n', String(n));
    el.setAttribute('tabindex', '0');
    el.setAttribute('title', '段落 ' + n);
  });

  // Claude の候補。quote をまず候補の段落で探し、無ければ全段落で探し、それでも無ければ全体へのコメントの候補にする
  var candidates = (Array.isArray(data.candidates) ? data.candidates : []).map(function (c) {
    var quote = typeof c.quote === 'string' ? c.quote : '';
    var block = blocks[c.block - 1] && (!quote || blocks[c.block - 1].text.indexOf(quote) >= 0) ? c.block : 0;
    if (!block && quote) {
      for (var i = 0; i < blocks.length; i += 1) {
        if (blocks[i].text.indexOf(quote) >= 0) { block = i + 1; break; }
      }
    }
    return { block: block, chip: c.chip, quote: block ? quote : '', text: block || !quote ? c.text : '「' + quote + '」 ' + c.text, state: 'open' };
  });

  // 元の姿は、全部の段落に番号を振り終えてから複製する (段落の中の段落にも blk と data-n が付いた姿を残すため。
  // 振る途中で複製すると、外側の段落を元に戻したときに内側の段落が印の無い複製に置き換わり、押せなくなる)
  blocks.forEach(function (block) { block.orig = block.el.cloneNode(true); });

  // 段落 n の、いま文書にある要素。外側の段落を元に戻すと内側の段落の要素は複製に置き換わるので、番号で探し直す
  function elementOf(n) {
    return docEl.querySelector('.blk[data-n="' + n + '"]') || blocks[n - 1].el;
  }

  var comments = [];
  var edits = [];
  var current = null;
  var chip = null;
  var editorMode = null;

  function blockOf(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentNode);
    var found = el && el.closest ? el.closest('.blk, .added') : null;
    if (!found || !docEl.contains(found)) return null;
    return Number(found.getAttribute(found.classList.contains('added') ? 'data-parent' : 'data-n'));
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
    if (entry.comment.source === 'claude') {
      var src = document.createElement('span');
      src.className = 'c-src';
      src.textContent = 'Claude の候補';
      body.appendChild(src);
    }
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

  // 添削: 段落を元に戻してから、書き換え、削除、移動、追加を描き直す (元の段落の文字は block.text に残す)
  var EDIT_LABELS = { rewrite: '書き換え', delete: '削除', move: '移動', add: '追加' };

  function editsOf(n) { return edits.filter(function (edit) { return edit.block === n; }); }

  function tagOf(text) {
    var tag = document.createElement('span');
    tag.className = 'etag';
    tag.setAttribute('aria-hidden', 'true');
    tag.textContent = text;
    return tag;
  }

  function setText(block, text) {
    if (block.el.tagName !== 'TR') {
      // 自分の文字 (直下の文字と強調やコード) だけを置き換え、段落の中の段落 (入れ子の箇条書きなど) は残す
      var kept = Array.prototype.filter.call(block.el.childNodes, function (node) {
        return node.nodeType === 1 && !INLINE[node.tagName];
      });
      while (block.el.firstChild) block.el.removeChild(block.el.firstChild);
      block.el.appendChild(document.createTextNode(text));
      kept.forEach(function (node) { block.el.appendChild(node); });
      return;
    }
    var cells = Array.prototype.slice.call(block.el.children);
    var parts = text.split('|').map(function (part) { return part.trim(); });
    cells.forEach(function (cell, index) {
      cell.textContent = parts.length === cells.length ? parts[index] : (index === 0 ? text : '');
    });
  }

  function hostOf(el) { return el.tagName === 'TR' ? el.firstElementChild : el; }

  function addedOf(block, text, n) {
    var tag = block.el.tagName;
    var el;
    if (tag === 'TR') {
      el = document.createElement('tr');
      var cell = document.createElement('td');
      cell.setAttribute('colspan', String(block.el.children.length || 1));
      cell.textContent = text;
      el.appendChild(cell);
    } else {
      el = document.createElement(tag === 'LI' ? 'li' : (tag === 'DT' || tag === 'DD') ? 'dd' : tag === 'PRE' ? 'pre' : 'p');
      el.textContent = text;
    }
    el.className = 'added';
    el.setAttribute('data-parent', String(n));
    var host = hostOf(el);
    host.insertBefore(tagOf('追加'), host.firstChild);
    return el;
  }

  function applyEdits() {
    all('.added', docEl).forEach(function (el) { el.parentNode.removeChild(el); });
    blocks.forEach(function (block, index) {
      block.el = elementOf(index + 1);
      block.el.classList.remove('edited', 'deleted', 'moved');
      var fresh = block.orig.cloneNode(true);
      while (block.el.firstChild) block.el.removeChild(block.el.firstChild);
      while (fresh.firstChild) block.el.appendChild(fresh.firstChild);
      var list = editsOf(index + 1);
      var tags = [];
      var last = block.el;
      list.forEach(function (edit) {
        if (edit.kind === 'rewrite') {
          setText(block, edit.text);
          block.el.classList.add('edited');
          tags.push('書き換え');
        } else if (edit.kind === 'delete') {
          block.el.classList.add('deleted');
          tags.push('削除');
        } else if (edit.kind === 'move') {
          block.el.classList.add('moved');
          tags.push('移動 → #' + edit.to + ' の後へ');
        }
      });
      list.filter(function (edit) { return edit.kind === 'add'; }).forEach(function (edit) {
        var el = addedOf(block, edit.text, index + 1);
        last.parentNode.insertBefore(el, last.nextSibling);
        last = el;
      });
      var host = hostOf(block.el);
      tags.reverse().forEach(function (text) { if (host) host.insertBefore(tagOf(text), host.firstChild); });
    });
  }

  function describeEdit(edit) {
    if (edit.kind === 'delete') return 'この段落を消す';
    if (edit.kind === 'move') return '#' + edit.to + ' の後へ動かす';
    return '(' + MODE_LABELS[edit.mode] + ') ' + edit.text;
  }

  function modeField() { return root.elements.namedItem('edit-mode'); }

  function setMode(mode) {
    Array.prototype.forEach.call(modeField(), function (radio) { radio.checked = radio.value === mode; });
  }

  function modeOf() {
    var checked = Array.prototype.filter.call(modeField(), function (radio) { return radio.checked; })[0];
    return checked && checked.value === 'guide' ? 'guide' : 'exact';
  }

  function fillEdits(listNode, list, withBlock, empty) {
    while (listNode.firstChild) listNode.removeChild(listNode.firstChild);
    if (list.length === 0) {
      var p = document.createElement('p');
      p.className = 'c-empty';
      p.textContent = empty;
      listNode.appendChild(p);
      return;
    }
    var ol = document.createElement('ol');
    ol.className = 'c-list';
    list.forEach(function (edit) {
      var li = document.createElement('li');
      li.className = 'c-item';
      var no = document.createElement('span');
      no.className = 'e-no';
      no.textContent = EDIT_LABELS[edit.kind];
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'c-go';
      if (withBlock) {
        var at = document.createElement('span');
        at.className = 'c-at';
        at.textContent = '#' + edit.block;
        go.appendChild(at);
      }
      var body = document.createElement('span');
      body.className = 'c-body';
      body.textContent = describeEdit(edit);
      go.appendChild(body);
      go.addEventListener('click', function () {
        selectBlock(edit.block, '');
        reveal(edit.block);
      });
      var undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'link c-del';
      undo.textContent = '元に戻す';
      undo.addEventListener('click', function () {
        var index = edits.indexOf(edit);
        if (index >= 0) edits.splice(index, 1);
        saveDraft();
        render();
      });
      li.appendChild(no);
      li.appendChild(go);
      li.appendChild(undo);
      ol.appendChild(li);
    });
    listNode.appendChild(ol);
  }

  // 文字位置: 段落の中の何文字目か。指摘の番号の印 (.mk) と添削の印 (.etag) の文字は数えない
  function isDecoration(node) {
    var el = node.nodeType === 1 ? node : node.parentNode;
    return !!(el && el.closest && el.closest('.mk, .etag, .ctag'));
  }

  function charOffset(blockEl, container, offset) {
    var range = document.createRange();
    range.setStart(blockEl, 0);
    range.setEnd(container, offset);
    var holder = document.createElement('div');
    holder.appendChild(range.cloneContents());
    Array.prototype.forEach.call(holder.querySelectorAll('.mk, .etag, .ctag'), function (el) { el.parentNode.removeChild(el); });
    return holder.textContent.length;
  }

  // 段落の start〜end 文字目を mark で囲む。文字の節をまたぐときは節ごとに囲む
  function highlight(blockEl, start, end, className, no) {
    if (!(end > start)) return;
    var walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    var nodes = [];
    while (walker.nextNode()) if (!isDecoration(walker.currentNode)) nodes.push(walker.currentNode);
    var position = 0;
    var marks = [];
    nodes.forEach(function (node) {
      var length = node.nodeValue.length;
      var from = Math.max(start, position);
      var to = Math.min(end, position + length);
      position += length;
      if (to <= from) return;
      var target = node;
      if (from - (position - length) > 0) target = target.splitText(from - (position - length));
      if (to - from < target.nodeValue.length) target.splitText(to - from);
      var mark = document.createElement('mark');
      mark.className = className;
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      marks.push(mark);
    });
    if (no && marks.length > 0) marks[marks.length - 1].setAttribute('data-no', String(no));
  }

  function openCandidates(n) {
    return candidates.filter(function (c) { return c.state === 'open' && (n === undefined || c.block === n); });
  }

  function adopt(candidate) {
    // 押し重ねや描き直しの遅れで 2 回呼ばれても、指摘は 1 つだけ足す
    if (candidate.state !== 'open') return;
    if (candidate.block) {
      var block = blocks[candidate.block - 1];
      var at = candidate.quote ? block.orig.textContent.indexOf(candidate.quote) : -1;
      comments.push({
        block: candidate.block,
        chip: candidate.chip,
        quote: candidate.quote,
        text: candidate.text,
        range: at >= 0 ? [at, at + candidate.quote.length] : null,
        source: 'claude'
      });
    } else if (globalEl) {
      var line = '[' + candidate.chip + '] ' + candidate.text + ' ' + CANDIDATE_MARK;
      globalEl.value = globalEl.value ? globalEl.value.replace(/\\s+$/, '') + '\\n' + line : line;
    }
    candidate.state = 'adopted';
    saveDraft();
    render();
  }

  function reject(candidate) {
    if (candidate.state !== 'open') return;
    candidate.state = 'rejected';
    saveDraft();
    render();
  }

  function fillCandidates(listNode, list, withBlock, empty) {
    while (listNode.firstChild) listNode.removeChild(listNode.firstChild);
    if (list.length === 0) {
      var p = document.createElement('p');
      p.className = 'c-empty';
      p.textContent = empty;
      listNode.appendChild(p);
      return;
    }
    var ol = document.createElement('ol');
    ol.className = 'c-list';
    list.forEach(function (candidate) {
      var li = document.createElement('li');
      li.className = 'c-item';
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'c-go';
      if (withBlock) {
        var at = document.createElement('span');
        at.className = 'c-at';
        at.textContent = candidate.block ? '#' + candidate.block : '全体';
        go.appendChild(at);
      }
      var body = document.createElement('span');
      body.className = 'c-body';
      var c = document.createElement('span');
      c.className = 'c-chip';
      c.textContent = candidate.chip;
      body.appendChild(c);
      if (candidate.quote) {
        var q = document.createElement('span');
        q.className = 'c-quote';
        q.textContent = '「' + candidate.quote + '」';
        body.appendChild(q);
      }
      body.appendChild(document.createTextNode(candidate.text));
      go.appendChild(body);
      go.addEventListener('click', function () {
        if (!candidate.block) return;
        selectBlock(candidate.block, '');
        reveal(candidate.block);
      });
      var actions = document.createElement('span');
      actions.className = 'cand-actions';
      [['採用', adopt, 'primary'], ['却下', reject, 'ghost']].forEach(function (spec) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn cand-btn ' + spec[2];
        button.textContent = spec[0];
        button.addEventListener('click', function () { spec[1](candidate); });
        actions.appendChild(button);
      });
      li.appendChild(go);
      li.appendChild(actions);
      ol.appendChild(li);
    });
    listNode.appendChild(ol);
  }

  // 指摘の印、一覧、数を描き直す
  function render() {
    applyEdits();
    // 元に戻した外側の段落の中では、内側の段落の要素が入れ替わるので、選択中の印を付け直す
    blocks.forEach(function (block, index) { block.el.classList.toggle('active', !!current && current.block === index + 1); });
    sorted().forEach(function (entry) {
      var block = blocks[entry.comment.block - 1];
      if (!block || !entry.comment.range || block.el.classList.contains('edited')) return;
      highlight(block.el, entry.comment.range[0], entry.comment.range[1], 'q' + (isKeep(entry.comment) ? ' keep' : ''), entry.no);
    });
    if (current && current.range) {
      var selected = blocks[current.block - 1];
      if (selected) highlight(selected.el, current.range[0], current.range[1], 'sel', 0);
    }
    all('.mk', docEl).forEach(function (el) { el.parentNode.removeChild(el); });
    blocks.forEach(function (block) { block.el.classList.remove('has', 'keep', 'cand'); });
    blocks.forEach(function (block, index) {
      if (openCandidates(index + 1).length === 0) return;
      block.el.classList.add('cand');
      var host = hostOf(block.el);
      if (!host) return;
      var tag = document.createElement('span');
      tag.className = 'ctag';
      tag.setAttribute('aria-hidden', 'true');
      tag.textContent = 'Claude の候補';
      host.insertBefore(tag, host.firstChild);
    });
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
    var sortedEdits = edits.slice().sort(function (a, b) { return a.block - b.block; });
    fillEdits(editAllEl, sortedEdits, true, '書き換えはまだありません。');
    candAllSecEl.hidden = candidates.length === 0;
    fillCandidates(candAllEl, openCandidates(), true, 'Claude の候補はすべて選びました。');
    if (current) {
      fill(blockListEl, entries.filter(function (entry) { return entry.comment.block === current.block; }), false, 'この段落の指摘はまだありません。');
      fillEdits(editListEl, editsOf(current.block), false, 'この段落の書き換えはまだありません。');
      var here = openCandidates(current.block);
      candBlockSecEl.hidden = here.length === 0;
      fillCandidates(candBlockEl, here, false, '');
      var deleted = editsOf(current.block).some(function (edit) { return edit.kind === 'delete'; });
      deleteEl.textContent = deleted ? '消すのをやめる' : 'この段落を消す';
    }
    var keep = comments.filter(isKeep).length;
    var stats = { comments: comments.length - keep, keep: keep, edits: edits.length, blocks: Object.keys(byBlock).length, total: blocks.length };
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

  function selectBlock(n, quote, range) {
    var block = blocks[n - 1];
    if (!block) return;
    current = { block: n, quote: quote, range: quote && range ? range : null };
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
    closeEditors();
    render();
    inspectorEl.scrollTop = 0;
    openSheet();
  }

  // 右: 添削の操作。書き換えと削除は同じ段落に 1 つだけ。削除した段落は動かさない
  function closeEditors() {
    editorMode = null;
    editorEl.hidden = true;
    moverEl.hidden = true;
  }

  function without(n, kinds) {
    edits = edits.filter(function (edit) { return !(edit.block === n && kinds.indexOf(edit.kind) >= 0); });
  }

  function openEditor(mode) {
    if (!current) return;
    closeEditors();
    editorMode = mode;
    var existing = editsOf(current.block).filter(function (edit) { return edit.kind === 'rewrite'; })[0];
    editorLabelEl.textContent = mode === 'rewrite' ? '書き換えた後の文 (書式なし)' : 'この段落の下に足す文';
    editorTextEl.value = mode === 'rewrite' ? (existing ? existing.text : blocks[current.block - 1].text) : '';
    setMode(mode === 'rewrite' && existing ? existing.mode : 'exact');
    editorEl.hidden = false;
    editorTextEl.focus();
  }

  function confirmEditor() {
    if (!current || !editorMode) return;
    var text = editorTextEl.value.replace(/\\s+$/, '');
    if (editorMode === 'rewrite') {
      without(current.block, ['rewrite', 'delete']);
      if (text.trim() && text !== blocks[current.block - 1].text) edits.push({ kind: 'rewrite', block: current.block, text: text, mode: modeOf() });
    } else if (text.trim()) {
      edits.push({ kind: 'add', block: current.block, text: text, mode: modeOf() });
    }
    closeEditors();
    saveDraft();
    render();
  }

  function confirmMove() {
    if (!current) return;
    var to = Number(moveToEl.value);
    if (!(to >= 1 && to <= blocks.length && Math.floor(to) === to) || to === current.block) {
      setStatus('移動先は 1〜' + blocks.length + ' の、この段落とは別の段落番号にしてください。', 'err');
      return;
    }
    without(current.block, ['move', 'delete']);
    edits.push({ kind: 'move', block: current.block, to: to });
    closeEditors();
    saveDraft();
    render();
    setStatus(HINT, '');
  }

  all('[data-edit]').forEach(function (button) {
    button.addEventListener('click', function () {
      if (!current) return;
      var kind = button.getAttribute('data-edit');
      if (kind === 'rewrite' || kind === 'add') {
        openEditor(kind);
      } else if (kind === 'delete') {
        var deleted = editsOf(current.block).some(function (edit) { return edit.kind === 'delete'; });
        without(current.block, ['delete', 'rewrite', 'move']);
        if (!deleted) edits.push({ kind: 'delete', block: current.block });
        closeEditors();
        saveDraft();
        render();
      } else if (kind === 'move') {
        closeEditors();
        var existing = editsOf(current.block).filter(function (edit) { return edit.kind === 'move'; })[0];
        moveToEl.value = existing ? String(existing.to) : '';
        moveToEl.max = String(blocks.length);
        moverEl.hidden = false;
        moveToEl.focus();
      }
    });
  });
  all('[data-action="editor-ok"]').forEach(function (button) { button.addEventListener('click', confirmEditor); });
  all('[data-action="move-ok"]').forEach(function (button) { button.addEventListener('click', confirmMove); });
  all('[data-action="editor-cancel"]').forEach(function (button) { button.addEventListener('click', closeEditors); });
  editorTextEl.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      confirmEditor();
    }
  });
  moveToEl.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    confirmMove();
  });

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
    comments.push({ block: current.block, chip: chip, quote: current.quote || '', text: text, range: current.quote ? current.range : null });
    current.quote = '';
    current.range = null;
    quoteBoxEl.hidden = true;
    textEl.value = '';
    setChip(null);
    saveDraft();
    render();
    setStatus(HINT, '');
  }

  // 左: 1 つの段落の中で文字列を選んでマウスを離すと、その文字列に色を付けて、右に指摘の操作を出す。
  // 選んだ位置は段落の中の文字位置で覚え、描き直しても色を付け直す (ブラウザの選択は描き直しで消えるため)
  function takeSelection() {
    var selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !docEl.contains(selection.anchorNode)) return false;
    var start = blockOf(selection.anchorNode);
    var end = blockOf(selection.focusNode);
    var quote = selection.toString().replace(/\\s+/g, ' ').trim();
    if (start === null || !quote) return false;
    if (start !== end) {
      setStatus('文字列は 1 つの段落の中で選んでください。', 'err');
      selection.removeAllRanges();
      return true;
    }
    var block = blocks[start - 1];
    var range = selection.getRangeAt(0);
    var from = charOffset(block.el, range.startContainer, range.startOffset);
    var to = charOffset(block.el, range.endContainer, range.endOffset);
    selection.removeAllRanges();
    selectBlock(start, quote.length > MAX_QUOTE ? quote.slice(0, MAX_QUOTE) + '…' : quote, [Math.min(from, to), Math.max(from, to)]);
    setStatus('選んだ文字列に色を付けました。右でチップかコメントを入れて [指摘を足す] を押します。', '');
    return true;
  }

  // 文書の中で離せば直後の click が選択を読む。文書の外 (右の欄など) で離したときは click が来ないので、ここで読む
  document.addEventListener('mouseup', function () {
    setTimeout(takeSelection, 0);
  });

  canvasEl.addEventListener('click', function (event) {
    if (takeSelection()) return;
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
      if (current) {
        current.quote = '';
        current.range = null;
      }
      quoteBoxEl.hidden = true;
      render();
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
    comments.concat(edits).forEach(function (item) {
      var block = blocks[item.block - 1];
      if (block) texts[String(item.block)] = block.text;
    });
    return {
      schemaVersion: 1,
      kind: 'review',
      documentId: review.documentId,
      revision: review.revision,
      comments: comments.map(function (comment) {
        var item = { block: comment.block, chip: comment.chip, quote: comment.quote, text: comment.text };
        if (comment.range) item.range = comment.range;
        if (comment.source === 'claude') item.source = 'claude';
        return item;
      }),
      edits: edits.map(function (edit) {
        if (edit.kind === 'delete') return { kind: 'delete', block: edit.block };
        if (edit.kind === 'move') return { kind: 'move', block: edit.block, to: edit.to };
        return { kind: edit.kind, block: edit.block, text: edit.text, mode: edit.mode };
      }),
      blocks: texts,
      globalNote: globalEl ? globalEl.value : ''
    };
  }

  function saveDraft() {
    var draft = collect();
    draft.candidateStates = candidates.map(function (candidate) { return candidate.state; });
    try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch (e) { /* 保存できなくても続ける */ }
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
        text: typeof comment.text === 'string' ? comment.text : '',
        range: Array.isArray(comment.range) && comment.range.length === 2 &&
          typeof comment.range[0] === 'number' && typeof comment.range[1] === 'number' ? comment.range : null,
        source: comment.source === 'claude' ? 'claude' : undefined
      });
    });
    (Array.isArray(saved.edits) ? saved.edits : []).forEach(function (edit) {
      if (!edit || typeof edit.block !== 'number' || !blocks[edit.block - 1]) return;
      if ((edit.kind === 'rewrite' || edit.kind === 'add') && typeof edit.text === 'string' && edit.text.trim()) {
        edits.push({ kind: edit.kind, block: edit.block, text: edit.text, mode: edit.mode === 'guide' ? 'guide' : 'exact' });
      } else if (edit.kind === 'delete') {
        edits.push({ kind: 'delete', block: edit.block });
      } else if (edit.kind === 'move' && typeof edit.to === 'number' && blocks[edit.to - 1] && edit.to !== edit.block) {
        edits.push({ kind: 'move', block: edit.block, to: edit.to });
      }
    });
    if (globalEl && typeof saved.globalNote === 'string') globalEl.value = saved.globalNote;
    if (Array.isArray(saved.candidateStates) && saved.candidateStates.length === candidates.length) {
      saved.candidateStates.forEach(function (state, index) {
        if (state === 'adopted' || state === 'rejected') candidates[index].state = state;
      });
    }
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
    all('input, textarea, .chip, .c-del, .cand-btn, #di-add, [data-edit], [data-action="editor-ok"], [data-action="move-ok"]').forEach(function (el) { el.disabled = true; });
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
    `<div data-stat="edits"><dt>書き換え</dt><dd>0</dd></div>` +
    `<div data-stat="blocks"><dt>指摘した段落</dt><dd>0</dd></div>` +
    `<div data-stat="total"><dt>段落</dt><dd>0</dd></div></dl>` +
    `<div class="p-sec" id="di-cand-all-sec" hidden><p class="p-label">Claude の候補</p><div id="di-cand-all"></div>` +
    `<p class="help">Claude が自分で見つけた直しどころです。[採用] で指摘に入り、[却下] で消えます。選ばなかった候補は送りません。</p></div>` +
    `<div class="p-sec"><p class="p-label">指摘の一覧</p><div id="di-list"></div></div>` +
    `<div class="p-sec"><p class="p-label">書き換えの一覧</p><div id="di-edit-all"></div></div>` +
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
    `<div class="p-sec" id="di-cand-block-sec" hidden><p class="p-label">Claude の候補</p><div id="di-cand-block"></div></div>` +
    `<div class="p-sec"><p class="p-label">この段落の指摘</p><div id="di-block-list"></div></div>` +
    `<div class="p-sec"><p class="p-label">直接直す</p><div class="edit-actions">` +
    `<button type="button" class="btn ghost" data-edit="rewrite">書き換える</button>` +
    `<button type="button" class="btn ghost" data-edit="delete">この段落を消す</button>` +
    `<button type="button" class="btn ghost" data-edit="move">移動する</button>` +
    `<button type="button" class="btn ghost" data-edit="add">この下に段落を足す</button></div>` +
    `<div class="editor" id="di-editor" hidden><label><span class="p-label" id="di-editor-label">書き換えた後の文</span>` +
    `<textarea id="di-editor-text"></textarea></label>` +
    `<div class="modes" role="radiogroup" aria-label="この文の使い方">` +
    `<label class="mode"><input type="radio" name="edit-mode" value="exact" checked><span><b>そのまま使う</b>書いた文を一字一句そのまま入れます</span></label>` +
    `<label class="mode"><input type="radio" name="edit-mode" value="guide"><span><b>参考にして直す</b>書いた文の意図に沿って、Claude が前後に合わせて直します</span></label></div>` +
    `<div class="editor-row"><button type="button" class="btn ghost" data-action="editor-cancel">やめる</button>` +
    `<button type="button" class="btn primary" data-action="editor-ok">確定</button></div></div>` +
    `<div class="editor" id="di-mover" hidden><div class="editor-row"><label>段落 <input type="number" id="di-move-to" min="1"> の後へ</label>` +
    `<button type="button" class="btn ghost" data-action="editor-cancel">やめる</button>` +
    `<button type="button" class="btn primary" data-action="move-ok">確定</button></div></div>` +
    `<p class="help">書き換えは書式なしの文で書きます (太字などの印は Claude が付け直します)。Ctrl+Enter でも確定できます。「参考にして直す」にすると、Claude は完了報告で書いた文と直した文を並べて示します。</p></div>` +
    `<div class="p-sec"><p class="p-label">この段落の書き換え</p><div id="di-edit-list"></div></div>` +
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
  const { review, html, date, candidates = [] } = input
  const part = review.part ? `<span>${review.part.index} / ${review.part.total} 回目</span>` : ''
  const partMeta = review.part ? `<span class="rev">${review.part.index}/${review.part.total}</span>` : ''
  const source = review.source ? `<span>${escapeHtml(review.source)}</span>` : ''

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- doc-desk-format: review-v1 -->
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
<div class="counts" id="di-progress" aria-live="polite"><span class="count" data-count="comments"><span class="lbl">指摘</span><b>0</b></span><span class="count" data-count="keep"><span class="lbl">ここは良い</span><b>0</b></span><span class="count" data-count="edits"><span class="lbl">書き換え</span><b>0</b></span></div>
<p class="bar-msg" id="di-status">${HINT}</p>
<button type="button" class="btn ghost only-narrow" data-action="open-overview">全体</button>
<button type="submit" class="btn primary" id="di-submit">送信</button>
</footer>
<div class="fallback" id="di-fallback-panel" hidden>
<div class="fallback-head"><p class="fallback-title" id="di-fallback-message">送信できませんでした</p><button type="button" class="icon-btn" data-action="close-fallback">閉じる</button></div>
<textarea id="di-fallback" readonly></textarea>
</div>
</form>
<script type="application/json" id="di-review">${safeJson({ review, html, candidates })}</script>
<script>
${SCRIPT}
</script>
</body>
</html>
`
}
