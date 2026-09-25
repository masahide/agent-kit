/**
 * `$.tool.register` の `inputSchema`。質問票 JSON スキーマ v1 (skills/doc-desk/references/form-spec-v1.md) を
 * JSON Schema で書いたものです。細かい規則 (問いの数、ID の一意性など) は
 * `validate.ts` が検査し、エラーを Claude に返します。
 */
const nonEmptyString = { type: 'string', minLength: 1 } as const

export const FORM_SCHEMA = {
  type: 'object',
  description: '質問票 JSON スキーマ v1',
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    documentId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: '文書の識別子' },
    revision: { type: 'integer', minimum: 1, description: '同じ文書の何枚目の質問票か' },
    label: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: '証跡ファイル名 (doc-desk/<label>.json)' },
    source: {
      type: 'string',
      minLength: 1,
      maxLength: 1024,
      description: 'これから書く、または更新する文書のパス。回答が届くまで Mod がこのパスへの書き込みを止める',
    },
    title: { ...nonEmptyString, description: '主張のタイトル (要約ではなく言い切り)' },
    conclusion: { ...nonEmptyString, description: '「結論:」で始まる 3 文以内' },
    glossary: {
      type: 'array',
      description: '読者が知らない語だけ 1 行ずつ',
      items: {
        type: 'object',
        properties: { term: nonEmptyString, definition: nonEmptyString },
        required: ['term', 'definition'],
      },
    },
    outline: {
      ...nonEmptyString,
      description:
        '構成案。文書の見出しと各節の要旨を書いた HTML の断片 (本文は書かない)。' +
        '問いは <span data-q="問い ID"></span>、表は <div data-table="表 ID"></div> の印で、影響する箇所に置く',
    },
    themes: {
      type: 'array',
      minItems: 1,
      description: 'テーマ (章)。全テーマの問いの合計は 2〜5 問',
      items: {
        type: 'object',
        properties: {
          id: nonEmptyString,
          name: nonEmptyString,
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: nonEmptyString,
                title: { ...nonEmptyString, description: '問いの 1 文' },
                cite: { ...nonEmptyString, description: '根拠: file:line か実行結果の引用' },
                options: {
                  type: 'array',
                  minItems: 2,
                  items: {
                    type: 'object',
                    properties: {
                      id: nonEmptyString,
                      label: nonEmptyString,
                      pros: { ...nonEmptyString, description: '利点 (選ぶ理由) 1 行' },
                      cons: { ...nonEmptyString, description: '代償 1 行' },
                      recommended: { type: 'boolean', description: '推奨案。1 問に 1 つまで' },
                      preview: { type: 'string', description: 'この案を選んだときに構成案の印に入る文。省略時は label' },
                    },
                    required: ['id', 'label', 'pros', 'cons'],
                  },
                },
                note: {
                  type: 'object',
                  properties: { placeholder: { type: 'string' } },
                },
              },
              required: ['id', 'title', 'cite', 'options'],
            },
          },
        },
        required: ['id', 'name', 'questions'],
      },
    },
    tables: {
      type: 'array',
      description: '人に埋めてもらう表',
      items: {
        type: 'object',
        properties: {
          id: nonEmptyString,
          title: nonEmptyString,
          columns: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } },
          rows: {
            type: 'array',
            maxItems: 20,
            items: { type: 'array', items: { type: 'string' } },
          },
          editable: { type: 'array', items: { type: 'boolean' }, description: '列ごとに編集可か。省略時は全列 true' },
        },
        required: ['id', 'title', 'columns', 'rows'],
      },
    },
    globalNote: {
      type: 'object',
      properties: { label: { type: 'string' } },
    },
  },
  required: ['schemaVersion', 'documentId', 'revision', 'label', 'title', 'conclusion', 'outline', 'themes'],
} as const

const OPEN_BROWSER = {
  type: 'boolean',
  description: 'false ならブラウザを起動せず URL だけ返す (既定 true)',
} as const

const WAIT_SECONDS = {
  type: 'integer',
  minimum: 0,
  maximum: 1800,
  description:
    'ツール呼び出しの中で回答を待つ上限 (秒)。既定 300。0 なら待たずに pending を返す。' +
    '上限までに回答が届けば status "answered" と reply (回答固定形) を返す',
} as const

/**
 * ツール `open_form` の入力全体。
 */
export const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    form: FORM_SCHEMA,
    openBrowser: OPEN_BROWSER,
    waitSeconds: WAIT_SECONDS,
  },
  required: ['form'],
} as const

/**
 * 指摘の画面 (skills/doc-desk/references/review-mode.md) の `review`。
 * 文書の本文は入力に載せず、Claude が `doc-desk/<label>.doc.html` に書き出したものを Mod が読みます。
 */
export const REVIEW_SCHEMA = {
  type: 'object',
  description: '指摘の画面 v1。文書の HTML は doc-desk/<label>.doc.html に先に書き出しておく',
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    documentId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: '文書の識別子 (質問票と同じでよい)' },
    revision: { type: 'integer', minimum: 1, description: '同じ文書の何回目の指摘の画面か' },
    label: {
      type: 'string',
      pattern: '^[A-Za-z0-9_-]{1,64}$',
      description: '画面の名前。文書の HTML を doc-desk/<label>.doc.html から読み、証跡を doc-desk/<label>.* に書く',
    },
    title: { ...nonEmptyString, description: '画面の上に出す文書の題名' },
    source: {
      type: 'string',
      description: '元の文書のパス。画面に出し、指摘が届くまで Mod がこのパスと doc-desk/<label>.doc.html への書き込みを止める',
    },
    part: {
      type: 'object',
      description: '長い文書を分けて出すときの、何回目か (index) と全部で何回か (total)',
      properties: { index: { type: 'integer', minimum: 1 }, total: { type: 'integer', minimum: 2 } },
      required: ['index', 'total'],
    },
  },
  required: ['schemaVersion', 'documentId', 'revision', 'label', 'title'],
} as const

/**
 * ツール `open_review` の入力全体。
 */
export const REVIEW_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    review: REVIEW_SCHEMA,
    openBrowser: OPEN_BROWSER,
    waitSeconds: WAIT_SECONDS,
    selfReview: {
      type: 'boolean',
      description:
        '既定 true。画面を出す前に、あなた自身が文書の直しどころを最大 5 件見つけ、画面に「Claude の候補」として出します (人は採用か却下を選ぶだけ)。false で出しません',
    },
  },
  required: ['review'],
} as const
