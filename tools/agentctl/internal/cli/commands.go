package cli

import (
	"strings"

	"github.com/masahide/agent-kit/tools/agentctl/internal/session"
)

// Flag is one flag of a command. A flag with an empty Value is a boolean.
type Flag struct {
	Name  string
	Value string
	Help  string
	Enum  []string
	Int   bool
}

// Arg is one required positional argument.
type Arg struct {
	Name string
	Help string
}

// Command is one leaf command. The parser, the checks and the help text are
// all built from this table so that they cannot drift apart.
type Command struct {
	Path        []string
	Group       string
	Summary     string
	Synopsis    string // extra usage text after the flags, e.g. "(--text TEXT | --text-file F)"
	Description string
	Args        []Arg
	Flags       []Flag
	Examples    []string
	Output      string
	Write       bool
	Check       func(in *Input) *session.Error
	Run         func(c *Ctx, in *Input) (any, error)
}

// Name is the command path joined by spaces, e.g. "sessions send".
func (c *Command) Name() string { return strings.Join(c.Path, " ") }

// Groups in the order the top-level help lists them.
var groupOrder = []string{"Discover", "Resolve", "Read", "Wait", "Write (live: these change sessions)", "Raw (repair hatch; codex writes are live)", "Help"}

// Top-level aliases kept from the first design for humans.
var aliases = map[string][]string{
	"ps":      {"sessions", "list"},
	"info":    {"sessions", "get"},
	"new":     {"sessions", "create"},
	"send":    {"sessions", "send"},
	"stop":    {"sessions", "stop"},
	"archive": {"sessions", "archive"},
	"delete":  {"sessions", "delete"},
}

var providerEnum = []string{string(session.Claude), string(session.Codex)}

func stateEnum() []string {
	out := make([]string, len(session.States))
	for i, s := range session.States {
		out[i] = string(s)
	}
	return out
}

var idArg = Arg{Name: "id", Help: "session id or unique id prefix; claude:<prefix> or codex:<prefix> limits the provider (see: agentctl sessions resolve)"}

const sessionShape = `Session = { "id", "provider": "claude"|"codex", "state": "running"|"waiting"|"idle"|"stopped"|"archived"|"error",
            "cwd", "title", "createdAt", "updatedAt", "waitingFor", "surface",
            "capabilities": { "send", "interrupt", "stop" }, "process": { "pid" } }`

func commands() []*Command {
	return []*Command{
		{
			Path: []string{"doctor"}, Group: "Discover",
			Summary:     "show which providers work and what is missing",
			Description: "Checks the claude and codex binaries, Claude Code's session records, the agentctl Mod and the Codex app-server daemon.\nAlways exits 0; problems are reported per provider.",
			Examples:    []string{"agentctl --json doctor"},
			Output:      `{ "providers": { "claude": { "available", "version", "liveSessions", "modSessions", "problems": [string] }, "codex": { ... } } }`,
			Run:         runDoctor,
		},
		{
			Path: []string{"sessions", "list"}, Group: "Discover",
			Summary:     "list sessions (running ones by default)",
			Description: "Lists running Claude sessions (from ~/.claude/sessions) and loaded Codex threads.\n--all adds stopped sessions. Archived sessions are listed only with --state archived.\nAt most --limit sessions per provider. --cursor and nextCursor need --provider.",
			Flags: []Flag{
				{Name: "cwd", Value: "DIR", Help: "only sessions whose working directory is DIR"},
				{Name: "state", Value: "S", Help: "only sessions in state S", Enum: stateEnum()},
				{Name: "all", Help: "include stopped sessions"},
				{Name: "limit", Value: "N", Help: "at most N sessions per provider (default 20)", Int: true},
				{Name: "cursor", Value: "C", Help: "continue from nextCursor of the previous page (needs --provider)"},
			},
			Examples: []string{"agentctl --json sessions list", "agentctl --json sessions list --all --provider codex --limit 50"},
			Output:   `{ "items": [Session], "nextCursor": string|null }` + "\n  " + sessionShape,
			Check:    checkList,
			Run:      runList,
		},
		{
			Path: []string{"sessions", "resolve"}, Group: "Resolve",
			Summary:     "turn an id prefix, a name or a directory into session ids",
			Description: "Matches the query against id prefixes, titles and working directories of all sessions (running and stopped).\nUse the full id from the output in later commands.",
			Args:        []Arg{{Name: "query", Help: "id prefix, title, or directory path"}},
			Examples:    []string{"agentctl --json sessions resolve ~/src/api", "agentctl --json sessions resolve 0199a1"},
			Output:      `{ "query": string, "items": [Session] }`,
			Run:         runResolve,
		},
		{
			Path: []string{"sessions", "get"}, Group: "Read",
			Summary:  "show one session",
			Args:     []Arg{idArg},
			Examples: []string{"agentctl --json sessions get 3f746262"},
			Output:   `Session + { "raw": provider data }`,
			Run:      runGet,
		},
		{
			Path: []string{"sessions", "messages"}, Group: "Read",
			Summary:     "show the last messages of a session",
			Description: "Returns user and assistant messages, oldest first. Each text is cut at 2000 characters (truncated: true).",
			Args:        []Arg{idArg},
			Flags:       []Flag{{Name: "last", Value: "N", Help: "number of messages (default 10)", Int: true}},
			Examples:    []string{"agentctl --json sessions messages 3f746262 --last 1"},
			Output:      `{ "items": [ { "id", "role": "user"|"assistant", "text", "at", "truncated" } ] }`,
			Run:         runMessages,
		},
		{
			Path: []string{"sessions", "wait"}, Group: "Wait",
			Summary:     "wait until a session reaches a state",
			Description: "Polls the session every second. Waiting for idle also ends when the session stops or fails; check \"reached\".",
			Args:        []Arg{idArg},
			Flags: []Flag{
				{Name: "until", Value: "S", Help: "idle (default), stopped or waiting", Enum: []string{"idle", "stopped", "waiting"}},
				{Name: "timeout", Value: "SEC", Help: "give up after SEC seconds (default 600)", Int: true},
			},
			Examples: []string{"agentctl --json sessions wait 0199a1c2 --until idle --timeout 1800"},
			Output:   `{ "session": Session, "reached": bool }`,
			Run:      runWait,
		},
		{
			Path: []string{"sessions", "create"}, Group: "Write (live: these change sessions)",
			Summary: "start a session in a directory (claude: use one the user started)",
			Description: "codex: starts a new thread in the Codex daemon.\n" +
				"claude: agentctl never starts Claude. It returns a running session in DIRECTORY (reused: true),\n" +
				"or fails with user_action_required (exit 5) and instructions for the user. With --wait it waits\n" +
				"until the user has started one. --new ignores sessions that were already running.",
			Args: []Arg{{Name: "provider", Help: "claude or codex"}, {Name: "directory", Help: "working directory of the session"}},
			Flags: []Flag{
				{Name: "prompt", Value: "TEXT", Help: "send TEXT once the session is ready"},
				{Name: "prompt-file", Value: "F", Help: "read the prompt from F (\"-\" for stdin)"},
				{Name: "name", Value: "NAME", Help: "name the session (usable with sessions resolve)"},
				{Name: "new", Help: "claude: do not reuse a session that is already running"},
				{Name: "wait", Value: "SEC", Help: "claude: wait up to SEC seconds for the user to start the session", Int: true},
			},
			Examples: []string{
				"agentctl --json sessions create codex ~/src/api --prompt-file task.md",
				"agentctl --json sessions create claude ~/src/api --wait 600",
			},
			Output: `{ "session": Session, "reused": bool, "delivery": string|null, "next": [string] }`,
			Write:  true,
			Check:  checkCreate,
			Run:    runCreate,
		},
		{
			Path: []string{"sessions", "resume"}, Group: "Write (live: these change sessions)",
			Summary:     "bring a stopped session back",
			Description: "codex: loads the thread into the daemon. claude: returns the session if it runs, otherwise user_action_required\nwith the command for the user (claude --resume <id>). --wait waits for the user.",
			Args:        []Arg{idArg},
			Flags:       []Flag{{Name: "wait", Value: "SEC", Help: "claude: wait up to SEC seconds for the user", Int: true}},
			Examples:    []string{"agentctl --json sessions resume 3f746262 --wait 600"},
			Output:      `{ "session": Session, "next": [string] }`,
			Write:       true,
			Run:         runResume,
		},
		{
			Path: []string{"sessions", "send"}, Group: "Write (live: these change sessions)",
			Summary:  "send a message to a session",
			Synopsis: "(--text TEXT | --text-file F)",
			Description: "Starts a turn if the session is idle. If a turn is running, codex steers it (steered) and claude\n" +
				"queues the message as the next turn (queued). claude needs the agentctl Mod in the session.",
			Args: []Arg{idArg},
			Flags: []Flag{
				{Name: "text", Value: "TEXT", Help: "message body"},
				{Name: "text-file", Value: "F", Help: "read the body from F (\"-\" for stdin)"},
			},
			Examples: []string{
				`agentctl --json sessions send 0199a1c2 --text "run the tests again"`,
				`echo "..." | agentctl --json sessions send 0199a1c2 --text-file -`,
			},
			Output: `{ "session": Session, "delivery": "turn_started"|"steered"|"submitted"|"queued", "next": [string] }`,
			Write:  true,
			Check:  checkSend,
			Run:    runSend,
		},
		{
			Path: []string{"sessions", "stop"}, Group: "Write (live: these change sessions)",
			Summary: "stop the running turn, and the process where agentctl may",
			Description: "Interrupts the running turn. claude sessions in a terminal or tmux are then ended with SIGTERM;\n" +
				"Claude Desktop and VS Code sessions keep their process (close them in the app). codex threads stay\n" +
				"loaded in the daemon. --turn only interrupts the turn.",
			Args:     []Arg{idArg},
			Flags:    []Flag{{Name: "turn", Help: "only interrupt the running turn"}},
			Examples: []string{"agentctl --json sessions stop 3f746262 --turn"},
			Output:   `{ "session": Session, "turnInterrupted": bool, "processStopped": bool, "hint": string }`,
			Write:    true,
			Run:      runStop,
		},
		{
			Path: []string{"sessions", "archive"}, Group: "Write (live: these change sessions)",
			Summary:     "hide a session from lists (the conversation is kept)",
			Description: "codex: thread/archive (stops a running turn). claude: marks the session archived in ~/.agentctl;\nthe session must not be running.",
			Args:        []Arg{idArg},
			Examples:    []string{"agentctl --json sessions archive 0199a1c2"},
			Output:      `{ "id": string, "archived": true }`,
			Write:       true,
			Run:         runArchive,
		},
		{
			Path: []string{"sessions", "delete"}, Group: "Write (live: these change sessions)",
			Summary:     "delete a session and its conversation",
			Synopsis:    "--yes",
			Description: "codex: thread/delete. claude: removes the transcript and ~/.agentctl data; the session must not be running.\nThere is no prompt: without --yes the command fails with confirmation_required. Ask the user first.",
			Args:        []Arg{idArg},
			Flags:       []Flag{{Name: "yes", Help: "confirm the deletion"}},
			Examples:    []string{"agentctl --json sessions delete 0199a1c2 --yes"},
			Output:      `{ "id": string, "deleted": true }`,
			Write:       true,
			Check:       checkDelete,
			Run:         runDelete,
		},
		{
			Path: []string{"raw", "codex"}, Group: "Raw (repair hatch; codex writes are live)",
			Summary:     "call a Codex app-server JSON-RPC method as is",
			Description: "Sends METHOD with --params-json to the Codex daemon and prints the result. Methods such as\nthread/delete really change data. Use only when a sessions command is missing.",
			Args:        []Arg{{Name: "method", Help: "JSON-RPC method, e.g. thread/read"}},
			Flags:       []Flag{{Name: "params-json", Value: "JSON", Help: "params object (default {})"}},
			Examples:    []string{`agentctl --json raw codex thread/read --params-json '{"threadId":"0199a1c2-..."}'`},
			Output:      "the JSON-RPC result",
			Run:         runRawCodex,
		},
		{
			Path: []string{"raw", "claude", "record"}, Group: "Raw (repair hatch; codex writes are live)",
			Summary:     "print Claude Code's session record and agentctl's files for a session",
			Description: "Read only. Prints ~/.claude/sessions/<pid>.json, mod.json and meta.json as they are.",
			Args:        []Arg{idArg},
			Examples:    []string{"agentctl --json raw claude record 3f746262"},
			Output:      `{ "record": object|null, "mod": object|null, "meta": object|null, "transcript": string|null }`,
			Run:         runRawClaudeRecord,
		},
		{
			Path: []string{"help"}, Group: "Help",
			Summary:     "show help for a command (same as <command> --help)",
			Synopsis:    "[<command>...]",
			Description: "With --json, prints the command table as JSON.",
			Examples:    []string{"agentctl help sessions send", "agentctl --json help sessions send"},
			Output:      `{ "command", "usage", "description", "args", "flags", "examples", "output", "exitCodes", "isWrite" }`,
		},
	}
}
