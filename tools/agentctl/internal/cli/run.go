// Package cli is the agentctl command line: parsing, help, output and the
// provider-independent part of every command.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/masahide/agent-kit/tools/agentctl/internal/claude"
	"github.com/masahide/agent-kit/tools/agentctl/internal/codex"
	"github.com/masahide/agent-kit/tools/agentctl/internal/session"
)

// Deps are the parts of the outside world a command touches. Tests replace them.
type Deps struct {
	Adapters []session.Adapter
	Now      func() time.Time
	Sleep    func(context.Context, time.Duration) error
}

// Doctorer is implemented by adapters that can report their own health.
type Doctorer interface {
	Doctor(ctx context.Context) any
}

// RawCaller is implemented by the Codex adapter for `raw codex`.
type RawCaller interface {
	Raw(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error)
}

// IDLister is implemented by adapters that can list every session id
// (running, stopped and archived) more cheaply than List. resolve uses it.
type IDLister interface {
	IDs(ctx context.Context) ([]string, error)
}

// Recorder is implemented by the Claude adapter for `raw claude record`.
type Recorder interface {
	Record(ctx context.Context, id string) (any, error)
}

// Ctx is what a command runs with.
type Ctx struct {
	context.Context
	Deps
	Stdin    io.Reader
	Stdout   io.Writer
	Stderr   io.Writer
	JSON     bool
	Provider session.Provider
}

// Run is the real entry point used by main.
func Run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	home, _ := os.UserHomeDir()
	deps := Deps{
		Adapters: []session.Adapter{claude.New(home), codex.New(home)},
		Now:      time.Now,
		Sleep:    sleepCtx,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	return RunWith(ctx, args, deps, stdin, stdout, stderr)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// RunWith runs one command line and returns the exit code.
func RunWith(ctx context.Context, args []string, deps Deps, stdin io.Reader, stdout, stderr io.Writer) int {
	root := buildTree(commands())
	p, uerr := parse(args, root)
	if uerr != nil {
		jsonMode := contains(args, "--json")
		return writeUsageError(uerr, jsonMode, root, stdout, stderr)
	}
	c := &Ctx{Context: ctx, Deps: deps, Stdin: stdin, Stdout: stdout, Stderr: stderr, JSON: p.globals.JSON, Provider: p.globals.Provider}
	if p.globals.Help {
		if c.JSON {
			writeJSON(stdout, helpAsJSON(p.node))
		} else {
			fmt.Fprint(stdout, helpText(p.node, root))
		}
		return 0
	}
	res, err := p.node.cmd.Run(c, p.input)
	if err != nil {
		return c.writeError(err)
	}
	c.emit(res)
	return 0
}

func writeUsageError(u *usageError, jsonMode bool, root *node, stdout, stderr io.Writer) int {
	help := helpText(u.node, root)
	e := u.err
	if u.node == root {
		e.Help = "agentctl --help"
	} else {
		e.Help = "agentctl " + strings.Join(u.node.path, " ") + " --help"
	}
	if jsonMode {
		e.Usage = help
		writeJSON(stdout, map[string]any{"error": e})
	} else {
		fmt.Fprintf(stderr, "error: %s\n", e.Message)
		if e.Hint != "" {
			fmt.Fprintf(stderr, "hint: %s\n", e.Hint)
		}
	}
	if len(e.Suggestions) > 0 {
		fmt.Fprintf(stderr, "did you mean: %s?\n", strings.Join(e.Suggestions, ", "))
	}
	fmt.Fprint(stderr, "\n"+help)
	return session.ExitCode(e.Code)
}

func (c *Ctx) writeError(err error) int {
	var e *session.Error
	if !errors.As(err, &e) {
		if errors.Is(err, context.Canceled) {
			e = session.Errf(session.CodeTimeout, "interrupted")
		} else {
			e = session.Errf(session.CodeProviderError, "%s", err.Error())
		}
	}
	if c.JSON {
		writeJSON(c.Stdout, map[string]any{"error": e})
		return session.ExitCode(e.Code)
	}
	fmt.Fprintf(c.Stderr, "error: %s\n", e.Message)
	for _, cand := range e.Candidates {
		fmt.Fprintf(c.Stderr, "  %s  %s  %s\n", cand.ID, cand.Provider, cand.Cwd)
	}
	if e.Action != nil {
		writeAction(c.Stderr, e.Action)
	}
	if e.Hint != "" {
		fmt.Fprintf(c.Stderr, "hint: %s\n", e.Hint)
	}
	for _, n := range e.Next {
		fmt.Fprintf(c.Stderr, "then: %s\n", n)
	}
	return session.ExitCode(e.Code)
}

func writeAction(w io.Writer, a *session.Action) {
	fmt.Fprintln(w, "Ask the user to do one of these:")
	for _, k := range []string{"desktop", "terminal", "vscode"} {
		if v, ok := a.Instructions[k]; ok {
			fmt.Fprintf(w, "  %-9s %s\n", k+":", v)
		}
	}
}

func writeJSON(w io.Writer, v any) {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// emit prints a result: JSON with --json, otherwise a table for lists and
// indented JSON for everything else.
func (c *Ctx) emit(v any) {
	if c.JSON {
		writeJSON(c.Stdout, v)
		return
	}
	if l, ok := v.(listResult); ok {
		writeTable(c.Stdout, l.Items, c.Now())
		for p, msg := range l.Unavailable {
			fmt.Fprintf(c.Stderr, "%s: %s\n", p, msg)
		}
		if l.NextCursor != nil {
			fmt.Fprintf(c.Stderr, "more: --cursor %s\n", *l.NextCursor)
		}
		return
	}
	writeJSON(c.Stdout, v)
}

func writeTable(w io.Writer, items []session.Session, now time.Time) {
	fmt.Fprintf(w, "%-13s %-8s %-9s %-12s %-5s %-30s %s\n", "ID", "PROVIDER", "STATE", "SURFACE", "AGE", "CWD", "TITLE")
	for _, s := range items {
		id := s.ID
		if len(id) > 13 {
			id = id[:13]
		}
		age := "-"
		if s.UpdatedAt != nil {
			age = shortDuration(now.Sub(*s.UpdatedAt))
		}
		title := ""
		if s.Title != nil {
			title = *s.Title
		}
		surface := "-"
		if s.Surface != nil {
			surface = *s.Surface
		}
		fmt.Fprintf(w, "%-13s %-8s %-9s %-12s %-5s %-30s %s\n", id, s.Provider, s.State, surface, age, s.Cwd, title)
	}
}

func shortDuration(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

// adaptersFor returns the adapters to use, honoring --provider.
func (c *Ctx) adaptersFor(p session.Provider) []session.Adapter {
	if p == "" {
		p = c.Provider
	}
	var out []session.Adapter
	for _, a := range c.Adapters {
		if p == "" || a.Provider() == p {
			out = append(out, a)
		}
	}
	return out
}

func (c *Ctx) adapter(p session.Provider) session.Adapter {
	for _, a := range c.Adapters {
		if a.Provider() == p {
			return a
		}
	}
	return nil
}

func isUnavailable(err error) bool {
	var e *session.Error
	return errors.As(err, &e) && e.Code == session.CodeProviderUnavailable
}

// everything lists all sessions of the given adapters, including stopped and archived ones.
func (c *Ctx) everything(adapters []session.Adapter) ([]session.Session, error) {
	var out []session.Session
	var firstErr error
	ok := 0
	for _, a := range adapters {
		items, _, err := a.List(c, session.ListQuery{All: true, Limit: 1000})
		if err == nil {
			var archived []session.Session
			archived, _, err = a.List(c, session.ListQuery{State: session.Archived, Limit: 1000})
			items = append(items, archived...)
		}
		if err != nil {
			if !isUnavailable(err) {
				return nil, err
			}
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		ok++
		out = append(out, items...)
	}
	if ok == 0 && firstErr != nil {
		return nil, firstErr
	}
	return out, nil
}

// candidates returns the sessions whose id starts with prefix. Adapters with
// IDLister are asked for ids first and read only the matching sessions.
func (c *Ctx) candidates(adapters []session.Adapter, prefix string) ([]session.Session, error) {
	var out, slow []session.Session
	var rest []session.Adapter
	for _, a := range adapters {
		l, ok := a.(IDLister)
		if !ok {
			rest = append(rest, a)
			continue
		}
		ids, err := l.IDs(c)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			if strings.HasPrefix(id, prefix) {
				if d, err := a.Get(c, id); err == nil {
					out = append(out, d.Session)
				}
			}
		}
	}
	if len(rest) > 0 {
		var err error
		slow, err = c.everything(rest)
		// An unreachable provider only matters when it was the only place to look.
		if err != nil && (!isUnavailable(err) || len(rest) == len(adapters)) {
			return nil, err
		}
	}
	return append(out, slow...), nil
}

// resolve turns an <id> argument into one session.
func (c *Ctx) resolve(arg string) (session.Adapter, session.Session, error) {
	var p session.Provider
	prefix := arg
	for _, pv := range session.Providers {
		if rest, ok := strings.CutPrefix(arg, string(pv)+":"); ok {
			p, prefix = pv, rest
		}
	}
	if prefix == "" {
		return nil, session.Session{}, session.Errf(session.CodeInvalidArgument, "empty session id")
	}
	all, err := c.candidates(c.adaptersFor(p), prefix)
	if err != nil {
		return nil, session.Session{}, err
	}
	var matches []session.Session
	seen := map[string]bool{}
	for _, s := range all {
		key := string(s.Provider) + ":" + s.ID
		if seen[key] {
			continue
		}
		if s.ID == prefix {
			return c.adapter(s.Provider), s, nil
		}
		if strings.HasPrefix(s.ID, prefix) {
			seen[key] = true
			matches = append(matches, s)
		}
	}
	switch len(matches) {
	case 0:
		return nil, session.Session{}, session.Errf(session.CodeNotFound, "no session matches %q", arg).
			WithHint("list sessions with: agentctl sessions list --all, or: agentctl sessions resolve <dir or title>")
	case 1:
		return c.adapter(matches[0].Provider), matches[0], nil
	}
	e := session.Errf(session.CodeAmbiguousID, "%s matches %d sessions", arg, len(matches)).
		WithHint("use a longer prefix or --provider")
	for _, m := range matches {
		e.Candidates = append(e.Candidates, session.Candidate{ID: m.ID, Provider: m.Provider, Cwd: m.Cwd, Title: m.Title})
	}
	return nil, session.Session{}, e
}

// get re-reads a session after a write.
func (c *Ctx) get(a session.Adapter, id string) session.Session {
	d, err := a.Get(c, id)
	if err != nil {
		return session.Session{ID: id, Provider: a.Provider()}
	}
	return d.Session
}

func nextAfterWrite(id string) []string {
	return []string{
		"agentctl --json sessions wait " + id + " --until idle",
		"agentctl --json sessions messages " + id + " --last 1",
	}
}

// Command handlers.

func runDoctor(c *Ctx, in *Input) (any, error) {
	out := map[string]any{}
	for _, a := range c.adaptersFor("") {
		if d, ok := a.(Doctorer); ok {
			out[string(a.Provider())] = d.Doctor(c)
		}
	}
	return map[string]any{"providers": out}, nil
}

type listResult struct {
	Items       []session.Session `json:"items"`
	NextCursor  *string           `json:"nextCursor"`
	Unavailable map[string]string `json:"unavailable,omitempty"`
}

func runList(c *Ctx, in *Input) (any, error) {
	q := session.ListQuery{
		All:    in.Bools["all"],
		State:  session.State(in.Flags["state"]),
		Limit:  in.Int("limit", 20),
		Cursor: in.Flags["cursor"],
	}
	if cwd := in.Flags["cwd"]; cwd != "" {
		q.Cwd = absPath(cwd)
	}
	if q.State != "" && !q.State.Live() {
		q.All = true
	}
	res := listResult{Items: []session.Session{}}
	for _, a := range c.adaptersFor("") {
		items, next, err := a.List(c, q)
		if err != nil {
			if isUnavailable(err) && c.Provider == "" {
				if res.Unavailable == nil {
					res.Unavailable = map[string]string{}
				}
				res.Unavailable[string(a.Provider())] = err.Error()
				continue
			}
			return nil, err
		}
		for _, s := range items {
			if q.Cwd != "" && s.Cwd != q.Cwd {
				continue
			}
			if q.State != "" && s.State != q.State {
				continue
			}
			if !q.All && !s.State.Live() {
				continue
			}
			res.Items = append(res.Items, s)
		}
		if c.Provider != "" {
			res.NextCursor = next
		}
	}
	return res, nil
}

func runResolve(c *Ctx, in *Input) (any, error) {
	q := in.Args["query"]
	all, err := c.everything(c.adaptersFor(""))
	if err != nil {
		return nil, err
	}
	dir := ""
	if st, err := os.Stat(expandHome(q)); err == nil && st.IsDir() {
		dir = absPath(q)
	}
	items := []session.Session{}
	for _, s := range all {
		title := ""
		if s.Title != nil {
			title = *s.Title
		}
		switch {
		case dir != "" && s.Cwd == dir,
			strings.HasPrefix(s.ID, q),
			title != "" && strings.EqualFold(title, q):
			items = append(items, s)
		}
	}
	return map[string]any{"query": q, "items": items}, nil
}

func runGet(c *Ctx, in *Input) (any, error) {
	a, s, err := c.resolve(in.Args["id"])
	if err != nil {
		return nil, err
	}
	return a.Get(c, s.ID)
}

func runMessages(c *Ctx, in *Input) (any, error) {
	a, s, err := c.resolve(in.Args["id"])
	if err != nil {
		return nil, err
	}
	msgs, err := a.Messages(c, s.ID, in.Int("last", 10))
	if err != nil {
		return nil, err
	}
	if msgs == nil {
		msgs = []session.Message{}
	}
	return map[string]any{"items": msgs}, nil
}

func runWait(c *Ctx, in *Input) (any, error) {
	a, s, err := c.resolve(in.Args["id"])
	if err != nil {
		return nil, err
	}
	until := session.State(in.Flags["until"])
	if until == "" {
		until = session.Idle
	}
	deadline := c.Now().Add(time.Duration(in.Int("timeout", 600)) * time.Second)
	for {
		d, err := a.Get(c, s.ID)
		if err != nil {
			return nil, err
		}
		st := d.State
		reached := st == until || (until == session.Stopped && st == session.Archived)
		ended := until != session.Stopped && (st == session.Stopped || st == session.Errored || st == session.Archived)
		if reached || ended {
			return map[string]any{"session": d.Session, "reached": reached}, nil
		}
		if !c.Now().Before(deadline) {
			e := session.Errf(session.CodeTimeout, "session %s is still %s after %ds", s.ID, st, in.Int("timeout", 600)).
				WithHint("wait longer with --timeout, or stop the turn: agentctl sessions stop %s --turn", s.ID)
			e.Detail, _ = json.Marshal(d.Session)
			return nil, e
		}
		if err := c.Sleep(c, time.Second); err != nil {
			return nil, err
		}
	}
}

// retryUserAction repeats f while it asks for a human, up to wait seconds.
func (c *Ctx) retryUserAction(wait int, f func() error) error {
	err := f()
	var e *session.Error
	if err == nil || wait <= 0 || !errors.As(err, &e) || e.Code != session.CodeUserAction {
		return err
	}
	fmt.Fprintf(c.Stderr, "%s\n", e.Message)
	if e.Action != nil {
		writeAction(c.Stderr, e.Action)
	}
	fmt.Fprintf(c.Stderr, "waiting up to %ds for the session to start...\n", wait)
	deadline := c.Now().Add(time.Duration(wait) * time.Second)
	for c.Now().Before(deadline) {
		if serr := c.Sleep(c, time.Second); serr != nil {
			return serr
		}
		err = f()
		if !errors.As(err, &e) || e.Code != session.CodeUserAction {
			return err
		}
	}
	e.Message = fmt.Sprintf("no session appeared within %ds: %s", wait, e.Message)
	return e
}

func (c *Ctx) readText(value string, file string, hasFile bool) (string, error) {
	if !hasFile {
		return value, nil
	}
	var b []byte
	var err error
	if file == "-" {
		b, err = io.ReadAll(c.Stdin)
	} else {
		b, err = os.ReadFile(expandHome(file))
	}
	if err != nil {
		return "", session.Errf(session.CodeInvalidArgument, "cannot read %s: %v", file, err)
	}
	return string(b), nil
}

func runCreate(c *Ctx, in *Input) (any, error) {
	p := session.Provider(in.Args["provider"])
	a := c.adapter(p)
	dir := absPath(in.Args["directory"])
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return nil, session.Errf(session.CodeInvalidArgument, "directory %s does not exist", dir)
	}
	pf, hasPF := in.Flags["prompt-file"]
	prompt, err := c.readText(in.Flags["prompt"], pf, hasPF)
	if err != nil {
		return nil, err
	}
	opts := session.CreateOptions{Name: in.Flags["name"], New: in.Bools["new"], After: c.Now()}
	var s session.Session
	var reused bool
	err = c.retryUserAction(in.Int("wait", 0), func() error {
		var err error
		s, reused, err = a.Create(c, dir, opts)
		return err
	})
	if err != nil {
		return nil, err
	}
	res := map[string]any{"session": s, "reused": reused, "delivery": nil, "next": nextAfterWrite(s.ID)}
	if strings.TrimSpace(prompt) != "" {
		d, err := c.sendWhenReady(a, s.ID, prompt)
		if err != nil {
			return nil, err
		}
		res["delivery"] = d
		res["session"] = c.get(a, s.ID)
	}
	return res, nil
}

// sendWhenReady waits up to 15 s for a fresh session to accept messages, then sends.
func (c *Ctx) sendWhenReady(a session.Adapter, id, text string) (session.Delivery, error) {
	deadline := c.Now().Add(15 * time.Second)
	for {
		d, err := a.Get(c, id)
		if err == nil && d.Capabilities.Send {
			break
		}
		if !c.Now().Before(deadline) {
			break // Send reports why it cannot deliver.
		}
		if err := c.Sleep(c, 500*time.Millisecond); err != nil {
			return "", err
		}
	}
	return a.Send(c, id, text)
}

func runResume(c *Ctx, in *Input) (any, error) {
	a, s, err := c.resolve(in.Args["id"])
	if err != nil {
		return nil, err
	}
	var out session.Session
	err = c.retryUserAction(in.Int("wait", 0), func() error {
		var err error
		out, err = a.Resume(c, s.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"session": out, "next": []string{"agentctl --json sessions send " + s.ID + " --text-file -"}}, nil
}

func runSend(c *Ctx, in *Input) (any, error) {
	tf, hasTF := in.Flags["text-file"]
	text, err := c.readText(in.Flags["text"], tf, hasTF)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(text) == "" {
		return nil, session.Errf(session.CodeInvalidArgument, "the message is empty")
	}
	a, s, err := c.resolve(in.Args["id"])
	if err != nil {
		return nil, err
	}
	d, err := a.Send(c, s.ID, text)
	if err != nil {
		return nil, err
	}
	return map[string]any{"session": c.get(a, s.ID), "delivery": d, "next": nextAfterWrite(s.ID)}, nil
}

func runStop(c *Ctx, in *Input) (any, error) {
	a, s, err := c.resolve(in.Args["id"])
	if err != nil {
		return nil, err
	}
	r, err := a.Stop(c, s.ID, in.Bools["turn"])
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"session": c.get(a, s.ID), "turnInterrupted": r.TurnInterrupted,
		"processStopped": r.ProcessStopped, "hint": r.Hint,
	}, nil
}

func runArchive(c *Ctx, in *Input) (any, error) {
	a, s, err := c.resolve(in.Args["id"])
	if err != nil {
		return nil, err
	}
	if err := a.Archive(c, s.ID); err != nil {
		return nil, err
	}
	return map[string]any{"id": s.ID, "provider": s.Provider, "archived": true}, nil
}

func runDelete(c *Ctx, in *Input) (any, error) {
	a, s, err := c.resolve(in.Args["id"])
	if err != nil {
		return nil, err
	}
	if err := a.Delete(c, s.ID); err != nil {
		return nil, err
	}
	return map[string]any{"id": s.ID, "provider": s.Provider, "deleted": true}, nil
}

func runRawCodex(c *Ctx, in *Input) (any, error) {
	r, ok := c.adapter(session.Codex).(RawCaller)
	if !ok {
		return nil, session.Errf(session.CodeUnsupported, "raw codex is not available")
	}
	params := json.RawMessage(`{}`)
	if v := in.Flags["params-json"]; v != "" {
		if !json.Valid([]byte(v)) {
			return nil, session.Errf(session.CodeInvalidArgument, "--params-json is not valid JSON")
		}
		params = json.RawMessage(v)
	}
	return r.Raw(c, in.Args["method"], params)
}

func runRawClaudeRecord(c *Ctx, in *Input) (any, error) {
	c.Provider = session.Claude
	a, s, err := c.resolve(in.Args["id"])
	if err != nil {
		return nil, err
	}
	r, ok := a.(Recorder)
	if !ok {
		return nil, session.Errf(session.CodeUnsupported, "raw claude record is not available")
	}
	return r.Record(c, s.ID)
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	return p
}

func absPath(p string) string {
	a, err := filepath.Abs(expandHome(p))
	if err != nil {
		return p
	}
	return a
}
