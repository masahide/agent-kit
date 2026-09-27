package codex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/masahide/agent-kit/tools/agentctl/internal/session"
)

// Adapter implements session.Adapter for Codex.
type Adapter struct {
	// Socket is the daemon's control socket.
	Socket string
	// StartDaemon starts the daemon when nothing listens on Socket. Nil
	// disables it (AGENTCTL_CODEX_SOCKET is set, or in tests).
	StartDaemon func(ctx context.Context) error
}

// New returns the adapter for the user's home directory. AGENTCTL_CODEX_SOCKET
// points at another socket (and turns off starting the daemon); CODEX_HOME
// moves Codex's directory (default ~/.codex).
func New(home string) *Adapter {
	if s := os.Getenv("AGENTCTL_CODEX_SOCKET"); s != "" {
		return &Adapter{Socket: s}
	}
	codexHome := os.Getenv("CODEX_HOME")
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	return &Adapter{
		Socket:      filepath.Join(codexHome, "app-server-control", "app-server-control.sock"),
		StartDaemon: startDaemon,
	}
}

func startDaemon(ctx context.Context) error {
	path, err := exec.LookPath("codex")
	if err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	return exec.CommandContext(cctx, path, "app-server", "daemon", "start").Run()
}

func (a *Adapter) Provider() session.Provider { return session.Codex }

func (a *Adapter) conn(ctx context.Context) (*client, error) {
	c, err := connect(ctx, a.Socket)
	// Any dial error may mean the daemon is not running (the message differs by OS).
	if err != nil && a.StartDaemon != nil {
		if serr := a.StartDaemon(ctx); serr == nil {
			c, err = connect(ctx, a.Socket)
		}
	}
	if err != nil {
		if a.StartDaemon != nil {
			if _, lerr := exec.LookPath("codex"); lerr != nil {
				return nil, session.Errf(session.CodeProviderUnavailable, "codex is not installed (not on PATH)").
					WithHint("install it with: npm i -g @openai/codex")
			}
		}
		return nil, session.Errf(session.CodeProviderUnavailable, "cannot reach the Codex app-server daemon at %s: %v", a.Socket, err).
			WithHint("run: codex app-server daemon start")
	}
	return c, nil
}

// with runs f on a fresh connection and turns daemon errors into session errors.
func (a *Adapter) with(ctx context.Context, f func(c *client) error) error {
	c, err := a.conn(ctx)
	if err != nil {
		return err
	}
	defer c.close()
	return mapErr(f(c))
}

func mapErr(err error) error {
	var re *RPCError
	if errors.As(err, &re) {
		e := session.Errf(session.CodeProviderError, "codex: %s", re.Message)
		e.Detail, _ = json.Marshal(re)
		return e
	}
	return err
}

type threadStatus struct {
	Type        string   `json:"type"`
	ActiveFlags []string `json:"activeFlags"`
}

type thread struct {
	ID        string       `json:"id"`
	Cwd       string       `json:"cwd"`
	Name      *string      `json:"name"`
	Preview   string       `json:"preview"`
	CreatedAt int64        `json:"createdAt"`
	UpdatedAt int64        `json:"updatedAt"`
	Status    threadStatus `json:"status"`
}

func stateOf(st threadStatus) session.State {
	switch st.Type {
	case "idle":
		return session.Idle
	case "active":
		if len(st.ActiveFlags) > 0 {
			return session.Waiting
		}
		return session.Running
	case "systemError":
		return session.Errored
	default:
		return session.Stopped
	}
}

func secTime(s int64) *time.Time {
	if s <= 0 {
		return nil
	}
	t := time.Unix(s, 0)
	return &t
}

// previewTitle is the start of the first message when a thread has no name.
func previewTitle(p string) string {
	p = strings.Join(strings.Fields(p), " ")
	if r := []rune(p); len(r) > 80 {
		return string(r[:80]) + "..."
	}
	return p
}

func toSession(t thread, archived bool) session.Session {
	state := stateOf(t.Status)
	if archived {
		state = session.Archived
	}
	s := session.Session{
		ID: t.ID, Provider: session.Codex, State: state, Cwd: t.Cwd,
		CreatedAt: secTime(t.CreatedAt), UpdatedAt: secTime(t.UpdatedAt),
		Capabilities: session.Capabilities{Send: !archived, Interrupt: state == session.Running || state == session.Waiting, Stop: !archived},
		Surface:      session.Ptr("codex-daemon"),
	}
	if !state.Live() {
		s.Surface = nil
	}
	switch {
	case t.Name != nil && *t.Name != "":
		s.Title = session.Ptr(*t.Name)
	case t.Preview != "":
		s.Title = session.Ptr(previewTitle(t.Preview))
	}
	if flags := t.Status.ActiveFlags; len(flags) > 0 {
		s.WaitingFor = session.Ptr(strings.Join(flags, ","))
	}
	return s
}

type threadResp struct {
	Thread thread `json:"thread"`
}

func (a *Adapter) List(ctx context.Context, q session.ListQuery) ([]session.Session, *string, error) {
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	var out []session.Session
	var next *string
	err := a.with(ctx, func(c *client) error {
		seen := map[string]bool{}
		if q.State != session.Archived && q.Cursor == "" {
			var loaded struct {
				Data []string `json:"data"`
			}
			if err := c.call("thread/loaded/list", map[string]any{}, &loaded); err != nil {
				return err
			}
			for _, id := range loaded.Data {
				seen[id] = true
				var r threadResp
				if err := c.call("thread/read", map[string]any{"threadId": id}, &r); err != nil {
					out = append(out, busySession(id))
					continue
				}
				out = append(out, toSession(r.Thread, false))
			}
		}
		if !q.All && q.State != session.Stopped && q.State != session.Archived {
			return nil
		}
		params := map[string]any{"limit": limit, "archived": q.State == session.Archived}
		if q.Cursor != "" {
			params["cursor"] = q.Cursor
		}
		if q.Cwd != "" {
			params["cwd"] = q.Cwd
		}
		var page struct {
			Data       []thread `json:"data"`
			NextCursor *string  `json:"nextCursor"`
		}
		if err := c.call("thread/list", params, &page); err != nil {
			return err
		}
		for _, t := range page.Data {
			if !seen[t.ID] {
				out = append(out, toSession(t, q.State == session.Archived))
			}
		}
		next = page.NextCursor
		return nil
	})
	return out, next, err
}

func (a *Adapter) Get(ctx context.Context, id string) (session.Detail, error) {
	var d session.Detail
	err := a.with(ctx, func(c *client) error {
		var raw json.RawMessage
		if err := c.call("thread/read", map[string]any{"threadId": id}, &raw); err != nil {
			if loaded, lerr := isLoaded(c, id); lerr == nil && loaded {
				d = session.Detail{Session: busySession(id), Raw: map[string]string{"readError": err.Error()}}
				return nil
			}
			return notFoundOr(id, err)
		}
		var r threadResp
		if err := json.Unmarshal(raw, &r); err != nil {
			return err
		}
		d = session.Detail{Session: toSession(r.Thread, false), Raw: raw}
		return nil
	})
	if err == nil && d.State == session.Stopped && a.isArchived(ctx, id) {
		d.State = session.Archived
		d.Capabilities = session.Capabilities{}
	}
	return d, err
}

// busySession stands for a thread the daemon has loaded but thread/read did
// not answer for. On Windows this was seen while a turn ran; treating it as
// running keeps `sessions wait` waiting instead of failing with not_found.
func busySession(id string) session.Session {
	return session.Session{
		ID: id, Provider: session.Codex, State: session.Running,
		Capabilities: session.Capabilities{Send: true, Interrupt: true, Stop: true},
		Surface:      session.Ptr("codex-daemon"),
	}
}

func isLoaded(c *client, id string) (bool, error) {
	var loaded struct {
		Data []string `json:"data"`
	}
	if err := c.call("thread/loaded/list", map[string]any{}, &loaded); err != nil {
		return false, err
	}
	for _, l := range loaded.Data {
		if l == id {
			return true, nil
		}
	}
	return false, nil
}

// isArchived looks for id among the archived threads.
func (a *Adapter) isArchived(ctx context.Context, id string) bool {
	items, _, err := a.List(ctx, session.ListQuery{State: session.Archived, Limit: 1000})
	if err != nil {
		return false
	}
	for _, s := range items {
		if s.ID == id {
			return true
		}
	}
	return false
}

func notFoundOr(id string, err error) error {
	var re *RPCError
	if errors.As(err, &re) && strings.Contains(strings.ToLower(re.Message), "not found") {
		return session.Errf(session.CodeNotFound, "no Codex thread %s", id)
	}
	return err
}

type item struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Text    string `json:"text"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func (a *Adapter) Messages(ctx context.Context, id string, last int) ([]session.Message, error) {
	var out []session.Message
	err := a.with(ctx, func(c *client) error {
		var cursor any
		for len(out) < last {
			params := map[string]any{"threadId": id, "sortDirection": "desc", "limit": 50}
			if cursor != nil {
				params["cursor"] = cursor
			}
			var page struct {
				Data []struct {
					Item        item  `json:"item"`
					StartedAtMs int64 `json:"startedAtMs"`
				} `json:"data"`
				NextCursor json.RawMessage `json:"nextCursor"`
			}
			if err := c.call("thread/items/list", params, &page); err != nil {
				return notFoundOr(id, err)
			}
			for _, d := range page.Data {
				m, ok := toMessage(d.Item, d.StartedAtMs)
				if ok && len(out) < last {
					out = append(out, m)
				}
			}
			if len(page.NextCursor) == 0 || string(page.NextCursor) == "null" || len(page.Data) == 0 {
				break
			}
			cursor = page.NextCursor
		}
		return nil
	})
	// out is newest first; messages are shown oldest first.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, err
}

const maxText = 2000

func toMessage(it item, atMs int64) (session.Message, bool) {
	var role, text string
	switch it.Type {
	case "agentMessage":
		role, text = "assistant", it.Text
	case "userMessage":
		role = "user"
		var parts []string
		for _, c := range it.Content {
			if c.Type == "text" && c.Text != "" {
				parts = append(parts, c.Text)
			}
		}
		text = strings.Join(parts, "\n")
	default:
		return session.Message{}, false
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return session.Message{}, false
	}
	m := session.Message{ID: it.ID, Role: role, Text: text}
	if atMs > 0 {
		m.At = session.Ptr(time.UnixMilli(atMs))
	}
	if r := []rune(text); len(r) > maxText {
		m.Text, m.Truncated = string(r[:maxText]), true
	}
	return m, true
}

func textInput(text string) []map[string]any {
	return []map[string]any{{"type": "text", "text": text}}
}

func (a *Adapter) Create(ctx context.Context, dir string, o session.CreateOptions) (session.Session, bool, error) {
	var s session.Session
	err := a.with(ctx, func(c *client) error {
		var r threadResp
		if err := c.call("thread/start", map[string]any{"cwd": dir}, &r); err != nil {
			return err
		}
		if o.Name != "" {
			if err := c.call("thread/name/set", map[string]any{"threadId": r.Thread.ID, "name": o.Name}, nil); err != nil {
				return err
			}
			r.Thread.Name = &o.Name
		}
		s = toSession(r.Thread, false)
		return nil
	})
	return s, false, err
}

func (a *Adapter) Resume(ctx context.Context, id string) (session.Session, error) {
	var s session.Session
	err := a.with(ctx, func(c *client) error {
		var r threadResp
		if err := c.call("thread/resume", map[string]any{"threadId": id}, &r); err != nil {
			return notFoundOr(id, err)
		}
		s = toSession(r.Thread, false)
		return nil
	})
	return s, err
}

// activeTurn returns the id of the running turn of a loaded thread, or "".
func activeTurn(c *client, id string) (string, error) {
	var page struct {
		Data []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"data"`
	}
	if err := c.call("thread/turns/list", map[string]any{"threadId": id, "limit": 1}, &page); err != nil {
		return "", err
	}
	if len(page.Data) > 0 && page.Data[0].Status == "inProgress" {
		return page.Data[0].ID, nil
	}
	return "", nil
}

func (a *Adapter) Send(ctx context.Context, id, text string) (session.Delivery, error) {
	var d session.Delivery
	err := a.with(ctx, func(c *client) error {
		var r threadResp
		if err := c.call("thread/read", map[string]any{"threadId": id}, &r); err != nil {
			return notFoundOr(id, err)
		}
		if r.Thread.Status.Type == "notLoaded" {
			if err := c.call("thread/resume", map[string]any{"threadId": id}, &r); err != nil {
				return err
			}
		}
		if r.Thread.Status.Type == "active" {
			turn, err := activeTurn(c, id)
			if err != nil {
				return err
			}
			if turn != "" {
				d = session.Steered
				return c.call("turn/steer", map[string]any{"threadId": id, "expectedTurnId": turn, "input": textInput(text)}, nil)
			}
		}
		d = session.TurnStarted
		return c.call("turn/start", map[string]any{"threadId": id, "input": textInput(text)}, nil)
	})
	return d, err
}

func (a *Adapter) Stop(ctx context.Context, id string, turnOnly bool) (session.StopResult, error) {
	var res session.StopResult
	err := a.with(ctx, func(c *client) error {
		var r threadResp
		if err := c.call("thread/read", map[string]any{"threadId": id}, &r); err != nil {
			return notFoundOr(id, err)
		}
		if r.Thread.Status.Type != "active" {
			return nil
		}
		turn, err := activeTurn(c, id)
		if err != nil || turn == "" {
			return err
		}
		if err := c.call("turn/interrupt", map[string]any{"threadId": id, "turnId": turn}, nil); err != nil {
			return err
		}
		res.TurnInterrupted = true
		return nil
	})
	if !turnOnly {
		res.Hint = "codex threads stay loaded in the daemon; the running turn (if any) was interrupted"
	}
	return res, err
}

func (a *Adapter) Archive(ctx context.Context, id string) error {
	return a.with(ctx, func(c *client) error {
		return notFoundOr(id, c.call("thread/archive", map[string]any{"threadId": id}, nil))
	})
}

func (a *Adapter) Delete(ctx context.Context, id string) error {
	return a.with(ctx, func(c *client) error {
		return notFoundOr(id, c.call("thread/delete", map[string]any{"threadId": id}, nil))
	})
}

// Raw is `raw codex`.
func (a *Adapter) Raw(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	err := a.with(ctx, func(c *client) error {
		var err error
		out, err = c.callRaw(method, params)
		return err
	})
	return out, err
}

// Doctor reports what works on the Codex side.
func (a *Adapter) Doctor(ctx context.Context) any {
	out := map[string]any{"available": false, "socket": a.Socket}
	problems := []string{}
	if path, err := exec.LookPath("codex"); err != nil {
		problems = append(problems, "codex is not on PATH")
	} else {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if b, err := exec.CommandContext(cctx, path, "--version").Output(); err == nil {
			out["version"] = strings.TrimSpace(string(b))
		}
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	c, err := connect(cctx, a.Socket)
	if err != nil {
		problems = append(problems, "the app-server daemon is not reachable at "+a.Socket+" (agentctl starts it on first use; or run: codex app-server daemon start)")
	} else {
		var loaded struct {
			Data []string `json:"data"`
		}
		if c.call("thread/loaded/list", map[string]any{}, &loaded) == nil {
			out["available"] = true
			out["loadedThreads"] = len(loaded.Data)
		}
		c.close()
	}
	out["problems"] = problems
	return out
}
