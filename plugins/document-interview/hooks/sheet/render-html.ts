import type { FormV1, Question, Table } from '../form/form-v1'
import { questionsOf } from '../form/form-v1'

/**
 * HTML シートの生成に要るもの。
 */
export type SheetInput = {
  /** 検証済みの質問票 */
  form: FormV1
  /** キッカーに出す日付 (YYYY-MM-DD) */
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
 * 7 トークンだけの CSS。akapen の paper-spec-v3 の骨格に倣い、
 * 赤は論点 (問い番号、推奨バッジ) 専任、青は導線 (送信ボタン) 専任です。
 * 外部リソースは読みません (フォントもシステムフォント)。
 */
const STYLE = `
:root{--ink:#212529;--muted:#64707C;--line:#DEE2E6;--paper:#FFFFFF;--paper-dim:#F6F8FA;--accent:#2563EB;--red:#DC2626}
body{background:var(--paper);color:var(--ink);font-family:'Hiragino Kaku Gothic ProN','Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif;font-size:14.5px;line-height:1.9;margin:0;border-top:3px solid var(--red);padding:14px 16px 20px}
main{max-width:760px;margin:0 auto}
.kicker{font-family:Menlo,Consolas,monospace;font-size:12.5px;letter-spacing:.08em;color:var(--red);font-weight:600}
h1{font-size:25px;line-height:1.45;margin:8px 0 12px}
h2{font-size:19px;line-height:1.45;margin:30px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line)}
p{margin:8px 0}
.concl{border:1px solid var(--line);border-left:3px solid var(--red);border-radius:10px;padding:14px 18px}
.m{color:var(--muted);font-size:12.5px;line-height:1.7}
.mono{font-family:Menlo,Consolas,monospace;font-size:13px}
.gl{font-size:12.5px;color:var(--muted);line-height:1.75;border-left:2px solid var(--line);padding-left:10px;margin:8px 0}
.qcard{border:1px solid var(--line);border-left:3px solid var(--red);border-radius:10px;padding:12px 16px;margin:12px 0}
.qcard .qt{font-weight:700;margin:0 0 6px}
.qcard .qn{color:var(--red)}
.qcard .cite{margin:0 0 8px;color:var(--muted);font-size:12.5px;line-height:1.6}
.qcard ul{list-style:none;margin:4px 0;padding:0}
.qcard li{margin:6px 0}
.qcard label{display:block;padding:6px 8px;border:1px solid var(--line);border-radius:8px;cursor:pointer}
.qcard label:has(input:checked){background:var(--paper-dim);border-color:var(--ink)}
.qcard input[type=radio]{margin-right:6px}
.rec{font-family:Menlo,Consolas,monospace;font-size:11px;color:var(--red);border:1px solid var(--red);border-radius:4px;padding:0 5px;margin-left:4px;white-space:nowrap}
.note{width:100%;box-sizing:border-box;margin-top:8px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;font:inherit;font-size:13.5px}
table{border-collapse:collapse;width:100%;font-size:13.5px;line-height:1.6;margin:8px 0}
caption{text-align:left;font-weight:700;padding:4px 0}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{font-size:11.5px;letter-spacing:.06em;color:var(--muted);font-weight:500;white-space:nowrap;border-bottom:1.5px solid var(--ink)}
td input{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--line);border-radius:4px;font:inherit;font-size:13px}
textarea{width:100%;box-sizing:border-box;min-height:88px;padding:8px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:13.5px}
footer{margin-top:28px;border-top:1px solid var(--line);padding-top:10px}
.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
button{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:8px 18px;font:inherit;font-weight:700;cursor:pointer}
button:disabled{background:var(--muted);cursor:default}
#di-status{margin:8px 0;font-weight:700}
#di-status.err{color:var(--red)}
#di-fallback{display:none}
#di-fallback.shown{display:block;margin-top:8px}
`.trim()

/**
 * ブラウザで動かす素の JavaScript。TypeScript の関数を toString で埋めません。
 *
 * すること: 選択肢の再クリックで解除、補足と表と全体コメントの下書きを
 * localStorage に保存して復元、進捗の表示、[送信] で回答 JSON を
 * `/answer?t=<token>` に POST (token は URL の `?t=` から読む)、失敗時の代替導線。
 */
const SCRIPT = `
(function () {
  'use strict';
  var form = JSON.parse(document.getElementById('di-form').textContent);
  var root = document.getElementById('di-answer');
  var statusEl = document.getElementById('di-status');
  var progressEl = document.getElementById('di-progress');
  var submitEl = document.getElementById('di-submit');
  var fallbackEl = document.getElementById('di-fallback');
  var draftKey = 'document-interview:' + form.documentId + ':' + form.revision;
  var questions = [];
  form.themes.forEach(function (theme) {
    theme.questions.forEach(function (question) { questions.push(question); });
  });
  var tables = form.tables || [];
  var token = new URLSearchParams(location.search).get('t') || '';

  function radiosOf(questionId) {
    return Array.prototype.slice.call(root.querySelectorAll('input[name="q-' + questionId + '"]'));
  }

  function collect() {
    var answers = {};
    questions.forEach(function (question) {
      var checked = radiosOf(question.id).filter(function (radio) { return radio.checked; })[0];
      var noteEl = root.querySelector('input[name="note-' + question.id + '"]');
      answers[question.id] = {
        choice: checked ? checked.value : null,
        note: noteEl ? noteEl.value : ''
      };
    });
    var filled = {};
    tables.forEach(function (table) {
      filled[table.id] = table.rows.map(function (row, rowIndex) {
        return row.map(function (cell, cellIndex) {
          var input = root.querySelector('input[name="cell-' + table.id + '-' + rowIndex + '-' + cellIndex + '"]');
          return input ? input.value : cell;
        });
      });
    });
    var globalEl = root.querySelector('textarea[name="globalNote"]');
    return {
      schemaVersion: 1,
      documentId: form.documentId,
      revision: form.revision,
      answers: answers,
      tables: filled,
      globalNote: globalEl ? globalEl.value : ''
    };
  }

  function answeredCount(answer) {
    return questions.filter(function (question) {
      var a = answer.answers[question.id];
      return a && (a.choice !== null || a.note.trim() !== '');
    }).length;
  }

  function refreshProgress() {
    progressEl.textContent = '回答あり ' + answeredCount(collect()) + ' / ' + questions.length;
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
    if (!saved || saved.schemaVersion !== 1) return;
    questions.forEach(function (question) {
      var a = saved.answers && saved.answers[question.id];
      if (!a) return;
      radiosOf(question.id).forEach(function (radio) {
        radio.checked = radio.value === a.choice;
        radio.dataset.wasChecked = radio.checked ? '1' : '0';
      });
      var noteEl = root.querySelector('input[name="note-' + question.id + '"]');
      if (noteEl && typeof a.note === 'string') noteEl.value = a.note;
    });
    tables.forEach(function (table) {
      var rows = saved.tables && saved.tables[table.id];
      if (!Array.isArray(rows)) return;
      rows.forEach(function (row, rowIndex) {
        if (!Array.isArray(row)) return;
        row.forEach(function (cell, cellIndex) {
          var input = root.querySelector('input[name="cell-' + table.id + '-' + rowIndex + '-' + cellIndex + '"]');
          if (input && typeof cell === 'string') input.value = cell;
        });
      });
    });
    var globalEl = root.querySelector('textarea[name="globalNote"]');
    if (globalEl && typeof saved.globalNote === 'string') globalEl.value = saved.globalNote;
  }

  // 選択肢: 選択中のものをもう一度クリックすると解除 (お任せに戻す)
  root.querySelectorAll('input[type="radio"]').forEach(function (radio) {
    radio.addEventListener('click', function () {
      var group = radiosOf(radio.name.slice(2));
      if (radio.dataset.wasChecked === '1') {
        radio.checked = false;
        radio.dataset.wasChecked = '0';
      } else {
        group.forEach(function (other) { other.dataset.wasChecked = '0'; });
        radio.dataset.wasChecked = '1';
      }
      saveDraft();
      refreshProgress();
    });
  });

  root.addEventListener('input', function () { saveDraft(); refreshProgress(); });

  function disableAll() {
    root.querySelectorAll('input, textarea, button').forEach(function (el) { el.disabled = true; });
  }

  function showFallback(answer, message) {
    statusEl.textContent = message;
    statusEl.className = 'err';
    fallbackEl.value = JSON.stringify(answer, null, 2);
    fallbackEl.className = 'shown';
    fallbackEl.disabled = false;
    fallbackEl.readOnly = true;
  }

  var FALLBACK_MESSAGE = '受信サーバが応答しません。下の JSON をそのまま Claude Code のチャットに貼ってください。';

  root.addEventListener('submit', function (event) {
    event.preventDefault();
    var answer = collect();
    answer.submittedAt = new Date().toISOString();
    submitEl.disabled = true;
    statusEl.textContent = '送信しています…';
    statusEl.className = '';
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
      disableAll();
      statusEl.textContent = '送信しました。Claude Code に戻ってください。';
      statusEl.className = '';
      try { localStorage.removeItem(draftKey); } catch (e) { /* 消せなくてもよい */ }
    }).catch(function () {
      submitEl.disabled = false;
      showFallback(answer, FALLBACK_MESSAGE);
    });
  });

  restoreDraft();
  refreshProgress();
})();
`.trim()

function glossaryHtml(form: FormV1): string {
  const entries = form.glossary ?? []
  if (entries.length === 0) return ''
  const items = entries
    .map(entry => `<b>${escapeHtml(entry.term)}</b> = ${escapeHtml(entry.definition)}`)
    .join('<br>')
  return `<div class="gl"><b>このシートで使う言葉</b><br>${items}</div>`
}

function questionHtml(question: Question, number: number): string {
  const options = question.options
    .map(option => {
      const badge = option.recommended === true ? '<span class="rec">推奨</span>' : ''
      return (
        `<li><label><input type="radio" name="q-${escapeHtml(question.id)}" value="${escapeHtml(option.id)}">` +
        `<b>${escapeHtml(option.id)}. ${escapeHtml(option.label)}</b>${badge}<br>` +
        `<span class="m">利点: ${escapeHtml(option.pros)} / 代償: ${escapeHtml(option.cons)}</span></label></li>`
      )
    })
    .join('')
  const placeholder = question.note?.placeholder ?? '補足があれば 1 行で'
  return (
    `<div class="qcard" data-question="${escapeHtml(question.id)}">` +
    `<p class="qt"><span class="qn">問 ${number}.</span> ${escapeHtml(question.title)}</p>` +
    `<p class="cite mono">根拠: ${escapeHtml(question.cite)}</p>` +
    `<ul>${options}</ul>` +
    `<input type="text" class="note" name="note-${escapeHtml(question.id)}" placeholder="${escapeHtml(placeholder)}">` +
    `</div>`
  )
}

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
    `<table data-table="${escapeHtml(table.id)}"><caption>${escapeHtml(table.title)}</caption>` +
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
  )
}

/**
 * 質問票 JSON から自己完結の HTML シートを作ります。
 *
 * トークンは HTML に埋めません。ブラウザの JS が URL の `?t=` から読んで
 * POST に付けるので、生成した HTML はそのまま受信サーバが配れます。
 *
 * @param input 質問票と日付
 * @returns HTML 全文
 */
export function renderHtml(input: SheetInput): string {
  const { form, date } = input
  const questions = questionsOf(form)

  let number = 0
  const themes = form.themes
    .map(theme => {
      const cards = theme.questions
        .map(question => {
          number += 1
          return questionHtml(question, number)
        })
        .join('')
      return `<h2>${escapeHtml(theme.name)}</h2>${cards}`
    })
    .join('')

  const tables = (form.tables ?? []).length > 0
    ? `<h2>表</h2><p class="m">編集できる欄はそのまま書き換えてください。</p>${(form.tables ?? []).map(tableHtml).join('')}`
    : ''

  const globalLabel = form.globalNote?.label ?? '全体へのコメント'

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
<main>
<div class="kicker">✎ INTERVIEW — ${escapeHtml(date)}</div>
<h1>${escapeHtml(form.title)}</h1>
<div class="concl">${escapeHtml(form.conclusion)}</div>
${glossaryHtml(form)}
<form id="di-answer">
${themes}
${tables}
<h2>${escapeHtml(globalLabel)}</h2>
<textarea name="globalNote" placeholder="問いに収まらないことがあれば、ここに書いてください"></textarea>
<footer>
<p class="m">未選択の問いはお任せ (推奨案) で進みます。</p>
<div class="actions"><button type="submit" id="di-submit">送信</button><span id="di-progress">回答あり 0 / ${questions.length}</span></div>
<p id="di-status"></p>
<textarea id="di-fallback" readonly></textarea>
</footer>
</form>
</main>
<script type="application/json" id="di-form">${safeJson(form)}</script>
<script>
${SCRIPT}
</script>
</body>
</html>
`
}
