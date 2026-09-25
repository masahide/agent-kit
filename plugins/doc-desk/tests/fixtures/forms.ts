import type { FormV1 } from '../../hooks/form/form-v1'

/**
 * 構成案のうち、表の節を除いた部分。
 */
const OUTLINE_BODY = [
  '<h2>前提</h2>',
  '<p>対象は、自前のセッションでログインしている既存ユーザーです。</p>',
  '<h2>移行</h2>',
  '<p><span data-q="q1"></span>移行期間は 2 週間で、期間が過ぎたら自前のセッションの発行を止めます。</p>',
  '<h2>運用</h2>',
  '<p>監査ログは <span data-q="q2"></span> 保持します。</p>',
].join('\n')

/**
 * 構成案の表の節。
 */
const OUTLINE_TABLE = [
  '<h2>画面</h2>',
  '<p>ログインが要る画面を、次の表で決めます。</p>',
  '<div data-table="tb1"></div>',
].join('\n')

/**
 * references/form-spec-v1.md の完全な例の質問票 (問いを 2 つにし、表を 1 つ付けたもの)。
 * 手動確認用の JSON は同じ内容を `spec-auth-01.form.json` に置いてあります。
 */
export const FORM: FormV1 = {
  schemaVersion: 1,
  documentId: 'spec-auth-01',
  revision: 1,
  label: 'spec-auth-01',
  source: 'docs/auth.md',
  title: '認証方式は OIDC に統一する',
  conclusion:
    '結論: 認証は OIDC に統一します。自前のセッション管理は捨てます。移行期間は 2 週間です。',
  glossary: [
    { term: 'OIDC', definition: 'OpenID Connect。OAuth 2.0 の上で認証を行う標準です。' },
  ],
  outline: `${OUTLINE_BODY}\n${OUTLINE_TABLE}`,
  themes: [
    {
      id: 't1',
      name: '方式',
      questions: [
        {
          id: 'q1',
          title: '既存ユーザーの移行をどう扱いますか',
          cite: 'src/auth/session.ts:40-88 に自前セッションの発行があります',
          options: [
            {
              id: 'A',
              label: '初回ログイン時に自動移行',
              pros: '利用者の操作が増えません',
              cons: '移行失敗時の切り分けが難しくなります',
              recommended: true,
              preview: '既存ユーザーは、初回ログイン時に自動で移行します。',
            },
            {
              id: 'B',
              label: '全員に再登録を求める',
              pros: '実装が単純です',
              cons: '離脱が増えます',
              preview: '既存ユーザーには、全員に再登録を求めます。',
            },
          ],
          note: { placeholder: '補足があれば 1 行で' },
        },
      ],
    },
    {
      id: 't2',
      name: '運用',
      questions: [
        {
          id: 'q2',
          title: 'ログの保持期間',
          cite: 'docs/ops/retention.md:12 に「監査ログは 90 日」とあります',
          options: [
            {
              id: 'A',
              label: '90 日',
              pros: '現行の規定と揃います',
              cons: '長期の調査に使えません',
              recommended: true,
            },
            {
              id: 'B',
              label: '1 年',
              pros: '長期の調査に使えます',
              cons: '保存費用が約 4 倍になります',
            },
          ],
        },
      ],
    },
  ],
  tables: [
    {
      id: 'tb1',
      title: '画面ごとの認証要否',
      columns: ['画面', '認証', '備考'],
      rows: [
        ['トップ', '', ''],
        ['設定', '', ''],
      ],
      editable: [false, true, true],
    },
  ],
  globalNote: { label: '全体へのコメント' },
}

/**
 * 表の無い質問票 (FORM から tables と構成案の表の節を外したもの)。
 */
export const FORM_NO_TABLES: FormV1 = (() => {
  const { tables: _tables, ...rest } = FORM
  return { ...rest, label: 'spec-auth-01-nt', outline: OUTLINE_BODY }
})()

/**
 * 質問票の深いコピー (検証テストで一部を壊すために使う)。
 */
export const cloneForm = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
