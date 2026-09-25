import { describe, expect, test, tier } from 'claude-code/testing'

import { formatReply } from '../hooks/reply/format'
import { summarizeReply } from '../hooks/reply/summary'
import { formatReviewReply } from '../hooks/review/format'
import Fixtures from './fixtures'

tier('user')

describe('summarizeReply', () => {
  test('質問票の固定形 (ゴールデン) を選んだ案と補足の数に畳む', () => {
    expect(summarizeReply(Fixtures.REPLY_FULL)).toEqual({
      documentId: 'spec-auth-01',
      detail: 'Q1=A  Q2=お任せ  補足 2 件',
    })
    expect(summarizeReply(Fixtures.REPLY_BARE)).toEqual({ documentId: 'spec-auth-01', detail: 'Q1=B  Q2=A' })
  })

  test('表の無い質問票で全体へのコメントがあっても畳む (コメントの中の行は数えない)', () => {
    const reply = formatReply(Fixtures.FORM_NO_TABLES, {
      ...Fixtures.ANSWER_BARE,
      globalNote: '全体に短く\nQ9. 題: Z — 紛らわしい行\n#3 削除',
    })
    expect(summarizeReply(reply)).toEqual({ documentId: 'spec-auth-01', detail: 'Q1=B  Q2=A  補足 1 件' })

    const review = formatReviewReply(Fixtures.REVIEW, {
      ...Fixtures.REVIEW_ANSWER_EMPTY,
      globalNote: '全体に\n#3 削除\n#4 書き換え (そのまま)',
    })
    expect(summarizeReply(review)?.detail).toBe('指摘 0 件  全体へのコメントあり')
  })

  test('問いの題に「: 」があっても選んだ案を読む', () => {
    const text = ['【doc-desk 回答】d', 'Q1. 方式: どれにしますか: B — 二つ目', '---', '締め'].join('\n')
    expect(summarizeReply(text)?.detail).toBe('Q1=B')
  })

  test('指摘の画面の固定形を指摘と書き換えの数に畳む', () => {
    expect(summarizeReply(Fixtures.REVIEW_REPLY)?.documentId).toBe('spec-auth-01')
    expect(summarizeReply(Fixtures.REVIEW_REPLY)?.detail).toMatch(/^指摘 \d+ 件/)
    expect(summarizeReply(Fixtures.REVIEW_REPLY_EMPTY)).toEqual({ documentId: 'spec-auth-01', detail: '指摘 0 件' })

    const text = [
      '【doc-desk 回答】d',
      '対象: doc-desk/d-review.doc.html',
      '## 指摘',
      '#3 [短くする]',
      '#7 [根拠が要る] 「速い」 何秒か',
      '## 指摘した段落',
      '#3 あ',
      '#7 い',
      '## 書き換え',
      '#2 書き換え (そのまま)',
      '前: a',
      '後: b',
      '#4 削除',
      '前: c',
      '#6 の後に追加 (参考にして直す)',
      '後: d',
      '全体へのコメント: よい',
      '---',
      '締め',
    ].join('\n')
    expect(summarizeReply(text)?.detail).toBe('指摘 2 件  書き換え 3 件  全体へのコメントあり')
  })

  test('固定形でなければ null', () => {
    expect(summarizeReply('ふつうの依頼です')).toBeNull()
    expect(summarizeReply('【doc-desk 回答】d\nQ1. 題: A — 案')).toBeNull()
    expect(summarizeReply('【doc-desk 回答】d\n自由な文\n---\n締め')).toBeNull()
    expect(summarizeReply('【doc-desk 回答】\nQ1. 題: A — 案\n---')).toBeNull()
  })

  test('問いの題が分かれば、題に「: A — B」のような文字列があっても選んだ案を取り違えない', () => {
    const text = [
      '【doc-desk 回答】d',
      'Q1. 方式: A — 甲にしますか: (未選択 = お任せ)',
      'Q2. 期限: B — 乙: C — 三つ目',
      '---',
      '締め',
    ].join('\n')
    expect(summarizeReply(text, ['方式: A — 甲にしますか', '期限: B — 乙'])?.detail).toBe('Q1=お任せ  Q2=C')
    expect(summarizeReply(text, ['違う題', '期限: B — 乙']), '題が合わなければ読めない').toBeNull()
  })
})
