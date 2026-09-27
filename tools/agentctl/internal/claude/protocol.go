// Package claude is the Claude Code adapter. It reads Claude Code's own
// session records and transcripts, and talks to the agentctl Mod through files
// under ~/.agentctl/claude/<sessionId>/.
package claude

// ProtocolVersion is the "v" of every file in the shared directory. The Mod
// (plugins/agentctl/hooks/protocol.ts) writes and reads the same shapes; both
// test suites read plugins/agentctl/tests/fixtures/protocol/*.json.
const ProtocolVersion = 1

// ModFile is mod.json, written by the Mod when a session starts.
type ModFile struct {
	V          int    `json:"v"`
	SessionID  string `json:"sessionId"`
	PID        int    `json:"pid"`
	ModVersion string `json:"modVersion"`
	StartedAt  int64  `json:"startedAt"`
}

// MetaFile is meta.json, written only by the CLI.
type MetaFile struct {
	V         int    `json:"v"`
	Name      string `json:"name,omitempty"`
	Archived  bool   `json:"archived"`
	UpdatedAt int64  `json:"updatedAt"`
}

// InboxMessage is inbox/<id>.json, written only by the CLI.
type InboxMessage struct {
	V         int    `json:"v"`
	ID        string `json:"id"`
	Kind      string `json:"kind"` // prompt | interrupt
	Text      string `json:"text,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

// Ack is acks/<id>.json, written only by the Mod.
type Ack struct {
	V      int    `json:"v"`
	ID     string `json:"id"`
	Status string `json:"status"` // queued | submitted | dropped | aborted | no_turn | error
	Detail string `json:"detail,omitempty"`
	At     int64  `json:"at"`
}

// Ack statuses. queued is the only one that changes later (to submitted).
const (
	AckQueued    = "queued"
	AckSubmitted = "submitted"
	AckDropped   = "dropped"
	AckAborted   = "aborted"
	AckNoTurn    = "no_turn"
	AckError     = "error"
)
