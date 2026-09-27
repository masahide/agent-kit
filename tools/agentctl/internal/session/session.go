// Package session holds the types shared by the CLI and the provider adapters.
package session

import (
	"context"
	"time"
)

// Provider is the agent that runs a session.
type Provider string

const (
	Claude Provider = "claude"
	Codex  Provider = "codex"
)

// Providers lists every provider in the order the CLI shows them.
var Providers = []Provider{Claude, Codex}

// State is the provider-independent state of a session.
type State string

const (
	Running  State = "running"
	Waiting  State = "waiting"
	Idle     State = "idle"
	Stopped  State = "stopped"
	Archived State = "archived"
	Errored  State = "error"
)

// States lists every state, for argument checks and help.
var States = []State{Running, Waiting, Idle, Stopped, Archived, Errored}

// Live reports whether a session in this state has a live process or loaded thread.
func (s State) Live() bool { return s == Running || s == Waiting || s == Idle }

// Session is one Claude session or Codex thread.
type Session struct {
	ID           string       `json:"id"`
	Provider     Provider     `json:"provider"`
	State        State        `json:"state"`
	Cwd          string       `json:"cwd"`
	Title        *string      `json:"title"`
	CreatedAt    *time.Time   `json:"createdAt"`
	UpdatedAt    *time.Time   `json:"updatedAt"`
	Capabilities Capabilities `json:"capabilities"`
	WaitingFor   *string      `json:"waitingFor"`
	Surface      *string      `json:"surface"`
	Process      Process      `json:"process"`
}

// Capabilities says which write commands work on a session right now.
type Capabilities struct {
	Send      bool `json:"send"`
	Interrupt bool `json:"interrupt"`
	Stop      bool `json:"stop"`
}

// Process is the OS process behind a session, if any.
type Process struct {
	PID *int `json:"pid"`
}

// Detail is a session plus the provider's own data, for `sessions get`.
type Detail struct {
	Session
	Raw any `json:"raw"`
}

// Message is one user or assistant message of a session.
type Message struct {
	ID        string     `json:"id"`
	Role      string     `json:"role"`
	Text      string     `json:"text"`
	At        *time.Time `json:"at"`
	Truncated bool       `json:"truncated,omitempty"`
}

// ListQuery narrows `sessions list`.
type ListQuery struct {
	All    bool
	Cwd    string
	State  State
	Limit  int
	Cursor string
}

// CreateOptions are the flags of `sessions create`.
type CreateOptions struct {
	Name string
	New  bool
	// After is when the command started; with New, only sessions started later count.
	After time.Time
}

// Delivery says how `sessions send` reached the session.
type Delivery string

const (
	TurnStarted Delivery = "turn_started"
	Steered     Delivery = "steered"
	Submitted   Delivery = "submitted"
	Queued      Delivery = "queued"
)

// StopResult says what `sessions stop` did.
type StopResult struct {
	TurnInterrupted bool   `json:"turnInterrupted"`
	ProcessStopped  bool   `json:"processStopped"`
	Hint            string `json:"hint,omitempty"`
}

// Adapter hides the differences between providers.
type Adapter interface {
	Provider() Provider
	List(ctx context.Context, q ListQuery) (items []Session, nextCursor *string, err error)
	Get(ctx context.Context, id string) (Detail, error)
	Messages(ctx context.Context, id string, last int) ([]Message, error)
	// Create returns a session in dir and whether it was already running. The
	// Claude adapter never starts a process; it returns a *Error with
	// CodeUserAction instead.
	Create(ctx context.Context, dir string, o CreateOptions) (s Session, reused bool, err error)
	Resume(ctx context.Context, id string) (Session, error)
	Send(ctx context.Context, id, text string) (Delivery, error)
	Stop(ctx context.Context, id string, turnOnly bool) (StopResult, error)
	Archive(ctx context.Context, id string) error
	Delete(ctx context.Context, id string) error
}

// Ptr returns a pointer to v.
func Ptr[T any](v T) *T { return &v }
