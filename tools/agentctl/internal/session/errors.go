package session

import (
	"encoding/json"
	"fmt"
)

// Error codes. They are part of the JSON contract; see docs/agentctl/plan.md 3.5.
const (
	CodeInvalidArgument      = "invalid_argument"
	CodeConfirmationRequired = "confirmation_required"
	CodeNotFound             = "not_found"
	CodeAmbiguousID          = "ambiguous_id"
	CodeUnsupported          = "unsupported"
	CodeProviderUnavailable  = "provider_unavailable"
	CodeUserAction           = "user_action_required"
	CodeTimeout              = "timeout"
	CodeProviderError        = "provider_error"
)

// ExitCode maps an error code to the process exit code.
func ExitCode(code string) int {
	switch code {
	case CodeInvalidArgument, CodeConfirmationRequired:
		return 2
	case CodeNotFound, CodeAmbiguousID:
		return 3
	case CodeUnsupported, CodeProviderUnavailable:
		return 4
	case CodeUserAction:
		return 5
	default:
		return 1
	}
}

// Candidate is one match of an ambiguous id.
type Candidate struct {
	ID       string   `json:"id"`
	Provider Provider `json:"provider"`
	Cwd      string   `json:"cwd,omitempty"`
	Title    *string  `json:"title,omitempty"`
}

// Action tells an agent what a human has to do before it can go on.
type Action struct {
	Kind         string            `json:"kind"`
	Dir          string            `json:"dir,omitempty"`
	SessionID    *string           `json:"sessionId"`
	Instructions map[string]string `json:"instructions"`
}

// Error is the error every command returns. It is printed as {"error": ...}.
type Error struct {
	Code        string          `json:"code"`
	Message     string          `json:"message"`
	Hint        string          `json:"hint,omitempty"`
	Candidates  []Candidate     `json:"candidates,omitempty"`
	Suggestions []string        `json:"suggestions,omitempty"`
	Usage       string          `json:"usage,omitempty"`
	Help        string          `json:"help,omitempty"`
	Action      *Action         `json:"action,omitempty"`
	Next        []string        `json:"next,omitempty"`
	Detail      json.RawMessage `json:"detail,omitempty"`
}

func (e *Error) Error() string { return e.Message }

// Errf builds an *Error with a formatted message.
func Errf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// WithHint returns e with a hint.
func (e *Error) WithHint(format string, args ...any) *Error {
	e.Hint = fmt.Sprintf(format, args...)
	return e
}
