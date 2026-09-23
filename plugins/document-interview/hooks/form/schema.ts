/**
 * `$.tool.register` の `inputSchema`。質問票 JSON スキーマ v1 (skills/document-interview/references/form-spec-v1.md) を
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
    label: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: '証跡ファイル名 (interview/<label>.json)' },
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
  required: ['schemaVersion', 'documentId', 'revision', 'label', 'title', 'conclusion', 'themes'],
} as const

/**
 * ツール `open_form` の入力全体。
 */
export const TOOL_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    form: FORM_SCHEMA,
    openBrowser: {
      type: 'boolean',
      description: 'false ならブラウザを起動せず URL だけ返す (既定 true)',
    },
    waitSeconds: {
      type: 'integer',
      minimum: 0,
      maximum: 1800,
      description:
        'ツール呼び出しの中で回答を待つ上限 (秒)。既定 300。0 なら待たずに pending を返す。' +
        '上限までに回答が届けば status "answered" と reply (回答固定形) を返す',
    },
  },
  required: ['form'],
} as const
