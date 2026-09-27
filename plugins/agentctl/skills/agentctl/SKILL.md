---
name: agentctl
description: Drive other running Claude Code and Codex sessions from the shell with the agentctl CLI - list them, read their last messages, send them work, wait for them to finish, stop, archive or delete them. Use when the user asks to hand a task to another agent session, check on or steer a session that is already running, or clean up sessions.
---

# agentctl

`agentctl` lists and drives running Claude Code and Codex sessions. Every command takes `--json`.

Start with:

```bash
agentctl --json doctor
agentctl --json sessions list
```

To hand work to another agent:

```bash
agentctl --json sessions create codex <dir> --prompt-file task.md
agentctl --json sessions wait <id> --until idle --timeout 1800
agentctl --json sessions messages <id> --last 1
```

To steer a running session:

```bash
agentctl --json sessions resolve <dir or title>
agentctl --json sessions send <id> --text-file -
```

Rules:

- Use `--json` when reading output. Use the full `id` from the output in later commands.
- Claude sessions are never started by agentctl. If a command fails with `user_action_required` (exit 5),
  show `error.action.instructions` to the user, then run the command in `error.next`
  (it waits until the user has started or resumed the session).
- `send` to a Claude session needs the agentctl Mod in that session. On `unsupported`, tell the user what `error.hint` says.
- Do not stop, archive or delete sessions the user did not ask about.
- `delete` needs `--yes`; ask the user first.
- On `invalid_argument`, read `error.usage` (the command's help) and fix the command.
- Use `agentctl raw ...` only when a `sessions` command is missing.
- `agentctl <command> --help` shows arguments, flags, output shape and exit codes.
