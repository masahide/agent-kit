# agentctl Mod

`agentctl` CLI ([tools/agentctl](../../tools/agentctl)) が Claude Code のセッションにメッセージを届けるための Claude Mod と、agent に agentctl の使い方を教える付属スキル (`skills/agentctl`) です。使い方は [docs/agentctl/usage.md](../../docs/agentctl/usage.md)、背景と決定は [docs/agentctl/plan.md](../../docs/agentctl/plan.md) にあります。

対象は Claude Code 2.1.283 の Claude Mods (function hooks、早期アクセス) です。`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` が要ります。

## 何をするか

セッションの一覧と状態は、CLI が Claude Code 本体のセッション記録 (`~/.claude/sessions/<pid>.json`) から読みます。この Mod がするのは、受信箱のメッセージを Claude に届けることだけです。

```
~/.agentctl/claude/<sessionId>/
  mod.json            Mod が session.start で書く ({ v, sessionId, pid, modVersion, startedAt })
  meta.json           CLI だけが書く (名前、アーカイブの印)
  inbox/<id>.json     CLI が書く ({ v, id, kind: "prompt"|"interrupt", text?, createdAt })
  acks/<id>.json      Mod が書く ({ v, id, status, detail?, at })
```

- `session.start`: `mod.json` を書きます。`pid` は `sh -c 'echo $PPID'` で取った claude の pid で、CLI はこれをセッション記録の pid と照合して、前のプロセスが残した `mod.json` を使いません。`AGENTCTL_HOME` があれば `~/.agentctl` の代わりに使います。
- 500 ms ごとに `inbox/` を `$.fs.list` し、まだ ack の無いメッセージを古い順に処理します。
  - `prompt`: turn の実行中なら先に `queued` の ack を書き、`$.prompt.submit` が返ったら (次の turn が始まったら) `submitted` に書き換えます。`{ drop }` なら `dropped`、throw したら `error` です。
  - `interrupt`: main の turn の実行中なら `$.turn.abort` で止めて `aborted`、そうでなければ `no_turn` です。
- `turn.start` / `turn.complete` (main のみ): 実行中の turn の id を覚えます。
- Mod はファイルを消しません。処理済みの受信箱と ack は CLI が消します。

Claude には、投入した文が「The agentctl plugin sent a message:」を前に付けた user turn として見えます (Claude Code がそう見せます)。

## 確かめ方

```bash
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate plugins/agentctl
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugins/agentctl
npx -y -p typescript tsc -p plugins/agentctl --noEmit   # 先に /plugin-types で .claude/types を作る
```

`claude plugin validate` の印字:

```
> ./register.ts hooks: turn.start, turn.complete, session.start
> ./register.ts calls: $.clock.every, $.clock.now, $.env.get, $.fs.exists, $.fs.list, $.fs.read, $.fs.write, $.process.run, $.prompt.submit, $.session.id, $.turn.abort, $.ui.log
> ./register.ts env reads: AGENTCTL_HOME, HOME
```

## ファイル

| パス | 中身 |
|---|---|
| `hooks/register.ts` | フックの登録と受信箱の監視 |
| `hooks/inbox.ts` | 受信箱の処理の純関数 (ファイル名の選別、メッセージの検査、ack の作成) |
| `hooks/protocol.ts` | 共有ディレクトリのファイルの形。CLI の `internal/claude/protocol.go` と同じ |
| `skills/agentctl/SKILL.md` | 付属スキル。Codex でも `~/.codex/skills/` に写せば使える |
| `tests/fixtures/protocol/*.json` | ファイルの見本。Go のテストも読む |
| `tests/fixtures/protocol.ts` | 同じ見本の TS 版 (Mod のテストは JSON を import できないため)。ずれは Go の `TestProtocolFixtures` が見つける |
