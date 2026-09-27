package claude

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/masahide/agent-kit/tools/agentctl/internal/session"
)

// Adapter implements session.Adapter for Claude Code.
type Adapter struct {
	SessionsDir string // ~/.claude/sessions
	ProjectsDir string // ~/.claude/projects
	store       store
	// Terminate and Alive are replaced in tests. CanTerminate is false on
	// Windows, where Stop only interrupts the turn.
	Terminate    func(pid int) error
	CanTerminate bool
	Alive        func(pid int, procStart string) bool
	Now          func() time.Time
	Sleep        func(context.Context, time.Duration) error
	// AckTimeout is how long send waits for the Mod.
	AckTimeout time.Duration
}

// New returns the adapter for the user's home directory. AGENTCTL_HOME moves
// the shared directory (default ~/.agentctl) and CLAUDE_CONFIG_DIR moves
// Claude Code's directory (default ~/.claude).
func New(home string) *Adapter {
	claudeDir := os.Getenv("CLAUDE_CONFIG_DIR")
	if claudeDir == "" {
		claudeDir = filepath.Join(home, ".claude")
	}
	base := os.Getenv("AGENTCTL_HOME")
	if base == "" {
		base = filepath.Join(home, ".agentctl")
	}
	return &Adapter{
		SessionsDir:  filepath.Join(claudeDir, "sessions"),
		ProjectsDir:  filepath.Join(claudeDir, "projects"),
		store:        store{base: filepath.Join(base, "claude")},
		Terminate:    terminate,
		CanTerminate: canTerminate,
		Alive:        processAlive,
		Now:          time.Now,
		Sleep: func(ctx context.Context, d time.Duration) error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(d):
				return nil
			}
		},
		AckTimeout: 10 * time.Second,
	}
}

func (a *Adapter) Provider() session.Provider { return session.Claude }

func msTime(ms int64) *time.Time {
	if ms <= 0 {
		return nil
	}
	t := time.UnixMilli(ms)
	return &t
}

// live returns the running sessions, keyed by session id. When two records
// claim one session id, the newer process wins.
func (a *Adapter) live() map[string]Record {
	recs, _ := readRecords(a.SessionsDir)
	out := map[string]Record{}
	for _, r := range recs {
		if !a.Alive(r.PID, r.ProcStart) {
			continue
		}
		if old, ok := out[r.SessionID]; ok && old.StartedAt > r.StartedAt {
			continue
		}
		out[r.SessionID] = r
	}
	return out
}

// modOK reports whether the Mod in the running process wrote mod.json. The
// Mod gets its pid from `sh`; where there is no sh (Windows) it writes pid 0,
// and a mod.json written after the process started counts instead.
func (a *Adapter) modOK(r Record) bool {
	m, ok := a.store.mod(r.SessionID)
	if !ok {
		return false
	}
	if m.PID != 0 {
		return m.PID == r.PID
	}
	return r.StartedAt > 0 && m.StartedAt >= r.StartedAt
}

// terminable reports whether Stop may end the process of r.
func (a *Adapter) terminable(r Record) bool {
	s := surfaceOf(r)
	return a.CanTerminate && (s == "terminal" || s == "tmux")
}

func (a *Adapter) fromRecord(r Record) session.Session {
	surface := surfaceOf(r)
	mod := a.modOK(r)
	state := session.Idle
	switch {
	case r.WaitingFor != "":
		state = session.Waiting
	case r.Status == "busy":
		state = session.Running
	}
	title := a.titleOf(r.SessionID, r)
	updated := r.StatusUpdatedAt
	if r.UpdatedAt > updated {
		updated = r.UpdatedAt
	}
	s := session.Session{
		ID: r.SessionID, Provider: session.Claude, State: state, Cwd: r.Cwd,
		CreatedAt: msTime(r.StartedAt), UpdatedAt: msTime(updated),
		Capabilities: session.Capabilities{
			Send: mod, Interrupt: mod,
			Stop: mod || a.terminable(r),
		},
		Surface: session.Ptr(surface),
		Process: session.Process{PID: session.Ptr(r.PID)},
	}
	if title != "" {
		s.Title = session.Ptr(title)
	}
	if r.WaitingFor != "" {
		s.WaitingFor = session.Ptr(r.WaitingFor)
	}
	return s
}

// titleOf prefers the name given with --name, then Claude's generated title,
// then a name the user set in Claude Code.
func (a *Adapter) titleOf(id string, r Record) string {
	if m := a.store.meta(id); m.Name != "" {
		return m.Name
	}
	if t, ok := findTranscript(a.ProjectsDir, id); ok {
		if h := readHead(t.Path); h.Title != "" {
			return h.Title
		}
	}
	if r.Name != "" && r.NameSource != "derived" {
		return r.Name
	}
	return ""
}

func (a *Adapter) fromTranscript(t transcript) session.Session {
	h := readHead(t.Path)
	meta := a.store.meta(t.ID)
	state := session.Stopped
	if meta.Archived {
		state = session.Archived
	}
	s := session.Session{
		ID: t.ID, Provider: session.Claude, State: state, Cwd: h.Cwd,
		CreatedAt: h.CreatedAt, UpdatedAt: session.Ptr(t.ModTime),
	}
	switch {
	case meta.Name != "":
		s.Title = session.Ptr(meta.Name)
	case h.Title != "":
		s.Title = session.Ptr(h.Title)
	}
	return s
}

func (a *Adapter) List(ctx context.Context, q session.ListQuery) ([]session.Session, *string, error) {
	live := a.live()
	var liveSessions []session.Session
	for _, r := range live {
		liveSessions = append(liveSessions, a.fromRecord(r))
	}
	sort.Slice(liveSessions, func(i, j int) bool { return later(liveSessions[i].UpdatedAt, liveSessions[j].UpdatedAt) })

	offset, _ := strconv.Atoi(q.Cursor)
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	var out []session.Session
	matched := 0
	// add returns true once the page is full and s would start the next one.
	add := func(s session.Session) (full bool) {
		if q.Cwd != "" && s.Cwd != q.Cwd {
			return false
		}
		if q.State != "" && s.State != q.State {
			return false
		}
		matched++
		if matched <= offset {
			return false
		}
		if len(out) == limit {
			return true
		}
		out = append(out, s)
		return false
	}
	next := session.Ptr(strconv.Itoa(offset + limit))
	for _, s := range liveSessions {
		if add(s) {
			return out, next, nil
		}
	}
	if q.All || q.State == session.Stopped || q.State == session.Archived {
		for _, t := range listTranscripts(a.ProjectsDir) {
			if _, ok := live[t.ID]; ok {
				continue
			}
			s := a.fromTranscript(t)
			if s.State == session.Archived && q.State != session.Archived {
				continue
			}
			if add(s) {
				return out, next, nil
			}
		}
	}
	return out, nil, nil
}

// IDs lists every session id (running, stopped and archived) from file names
// only, so that resolving an id prefix does not read every transcript.
func (a *Adapter) IDs(ctx context.Context) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for id := range a.live() {
		seen[id] = true
		out = append(out, id)
	}
	for _, t := range listTranscripts(a.ProjectsDir) {
		if !seen[t.ID] {
			seen[t.ID] = true
			out = append(out, t.ID)
		}
	}
	return out, nil
}

func later(x, y *time.Time) bool {
	switch {
	case x == nil:
		return false
	case y == nil:
		return true
	}
	return x.After(*y)
}

// rawOf is the "raw" of `sessions get` and the output of `raw claude record`.
type rawOf struct {
	Record     json.RawMessage `json:"record"`
	Mod        *ModFile        `json:"mod"`
	Meta       *MetaFile       `json:"meta"`
	Transcript *string         `json:"transcript"`
}

func (a *Adapter) raw(id string, r *Record) rawOf {
	var out rawOf
	if r != nil {
		out.Record = r.raw
	}
	if m, ok := a.store.mod(id); ok {
		out.Mod = m
	}
	var meta MetaFile
	if ok, err := readJSON(a.store.metaPath(id), &meta); ok && err == nil {
		out.Meta = &meta
	}
	if t, ok := findTranscript(a.ProjectsDir, id); ok {
		out.Transcript = session.Ptr(t.Path)
	}
	return out
}

func notFound(id string) error {
	return session.Errf(session.CodeNotFound, "no Claude session %s", id).
		WithHint("list sessions with: agentctl sessions list --all --provider claude")
}

func (a *Adapter) Get(ctx context.Context, id string) (session.Detail, error) {
	if r, ok := a.live()[id]; ok {
		return session.Detail{Session: a.fromRecord(r), Raw: a.raw(id, &r)}, nil
	}
	if t, ok := findTranscript(a.ProjectsDir, id); ok {
		return session.Detail{Session: a.fromTranscript(t), Raw: a.raw(id, nil)}, nil
	}
	return session.Detail{}, notFound(id)
}

// Record is `raw claude record`.
func (a *Adapter) Record(ctx context.Context, id string) (any, error) {
	if r, ok := a.live()[id]; ok {
		return a.raw(id, &r), nil
	}
	if _, ok := findTranscript(a.ProjectsDir, id); ok {
		return a.raw(id, nil), nil
	}
	return nil, notFound(id)
}

func (a *Adapter) Messages(ctx context.Context, id string, last int) ([]session.Message, error) {
	t, ok := findTranscript(a.ProjectsDir, id)
	if !ok {
		if _, live := a.live()[id]; live {
			return []session.Message{}, nil
		}
		return nil, notFound(id)
	}
	msgs, err := readMessages(t.Path, last)
	if err != nil {
		return nil, session.Errf(session.CodeProviderError, "cannot read transcript %s: %v", t.Path, err)
	}
	return msgs, nil
}

func shellQuote(s string) string {
	if s != "" && strings.IndexFunc(s, func(r rune) bool {
		return !(r == '/' || r == '.' || r == '-' || r == '_' || r == '~' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z')
	}) < 0 {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// startRequest is the user_action_required error asking the user to start Claude in dir.
func startRequest(dir string, isNew bool) error {
	next := "agentctl --json sessions create claude " + shellQuote(dir) + " --wait 600"
	if isNew {
		next += " --new"
	}
	e := session.Errf(session.CodeUserAction, "no running Claude session in %s; ask the user to start one", dir)
	e.Action = &session.Action{
		Kind: "start_claude", Dir: dir,
		Instructions: map[string]string{
			"desktop":  "Claude Desktop > Code > New session > choose the folder " + dir,
			"terminal": "cd " + shellQuote(dir) + " && claude",
			"vscode":   "Open " + dir + " in VS Code and start Claude Code",
		},
	}
	e.Next = []string{next}
	return e
}

// resumeRequest asks the user to bring a stopped session back.
func resumeRequest(s session.Session) error {
	title := s.ID
	if s.Title != nil {
		title = *s.Title
	}
	e := session.Errf(session.CodeUserAction, "Claude session %s is not running; ask the user to resume it", s.ID)
	e.Action = &session.Action{
		Kind: "resume_claude", Dir: s.Cwd, SessionID: session.Ptr(s.ID),
		Instructions: map[string]string{
			"desktop":  "Claude Desktop > Code > open \"" + title + "\" from the session history",
			"terminal": "cd " + shellQuote(s.Cwd) + " && claude --resume " + s.ID,
			"vscode":   "Open " + s.Cwd + " in VS Code and resume \"" + title + "\" in Claude Code",
		},
	}
	e.Next = []string{"agentctl --json sessions resume " + s.ID + " --wait 600"}
	return e
}

func (a *Adapter) Create(ctx context.Context, dir string, o session.CreateOptions) (session.Session, bool, error) {
	var best *Record
	for _, r := range a.live() {
		if r.Cwd != dir {
			continue
		}
		if o.New && r.StartedAt < o.After.UnixMilli() {
			continue
		}
		if best == nil || r.StartedAt > best.StartedAt {
			r := r
			best = &r
		}
	}
	if best == nil {
		return session.Session{}, false, startRequest(dir, o.New)
	}
	if o.Name != "" {
		m := a.store.meta(best.SessionID)
		m.Name, m.UpdatedAt = o.Name, a.Now().UnixMilli()
		if err := a.store.writeMeta(best.SessionID, m); err != nil {
			return session.Session{}, false, err
		}
	}
	return a.fromRecord(*best), !o.New, nil
}

func (a *Adapter) Resume(ctx context.Context, id string) (session.Session, error) {
	d, err := a.Get(ctx, id)
	if err != nil {
		return session.Session{}, err
	}
	if d.State.Live() {
		return d.Session, nil
	}
	return session.Session{}, resumeRequest(d.Session)
}

// running returns the live record of id, or the error to show when there is none.
func (a *Adapter) running(ctx context.Context, id string) (Record, error) {
	if r, ok := a.live()[id]; ok {
		return r, nil
	}
	d, err := a.Get(ctx, id)
	if err != nil {
		return Record{}, err
	}
	return Record{}, resumeRequest(d.Session)
}

func noMod(id string) error {
	return session.Errf(session.CodeUnsupported, "Claude session %s does not have the agentctl Mod loaded", id).
		WithHint("install plugins/agentctl, set CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1, and start the session again; agentctl doctor shows what is missing")
}

// post puts a message in the inbox and waits for its ack.
func (a *Adapter) post(ctx context.Context, id string, m InboxMessage) (*Ack, error) {
	a.store.cleanup(id)
	now := a.Now()
	m.ID = newMessageID(now.UnixMilli())
	m.CreatedAt = now.UnixMilli()
	if err := a.store.post(id, m); err != nil {
		return nil, session.Errf(session.CodeProviderError, "cannot write to the inbox: %v", err)
	}
	deadline := now.Add(a.AckTimeout)
	for {
		if ack, ok := a.store.ack(id, m.ID); ok {
			a.store.cleanup(id)
			return ack, nil
		}
		if !a.Now().Before(deadline) {
			_ = os.Remove(filepath.Join(a.store.inbox(id), m.ID+".json"))
			return nil, session.Errf(session.CodeTimeout, "the agentctl Mod in session %s did not answer within %s", id, a.AckTimeout).
				WithHint("the session may be waiting for a permission prompt or a dialog; check it in its app or terminal")
		}
		if err := a.Sleep(ctx, 100*time.Millisecond); err != nil {
			return nil, err
		}
	}
}

func (a *Adapter) Send(ctx context.Context, id, text string) (session.Delivery, error) {
	r, err := a.running(ctx, id)
	if err != nil {
		return "", err
	}
	if !a.modOK(r) {
		return "", noMod(id)
	}
	ack, err := a.post(ctx, id, InboxMessage{Kind: "prompt", Text: text})
	if err != nil {
		return "", err
	}
	switch ack.Status {
	case AckQueued:
		return session.Queued, nil
	case AckSubmitted:
		a.waitBusy(ctx, id)
		return session.Submitted, nil
	case AckDropped:
		return "", session.Errf(session.CodeProviderError, "Claude Code did not accept the message: %s", ack.Detail)
	default:
		return "", session.Errf(session.CodeProviderError, "the agentctl Mod could not submit the message: %s %s", ack.Status, ack.Detail)
	}
}

// waitBusy gives Claude Code up to 3 s to mark the new turn in its record, so
// that `sessions wait --until idle` right after `send` does not return early.
func (a *Adapter) waitBusy(ctx context.Context, id string) {
	deadline := a.Now().Add(3 * time.Second)
	for a.Now().Before(deadline) {
		if r, ok := a.live()[id]; !ok || r.Status != "idle" {
			return
		}
		if a.Sleep(ctx, 100*time.Millisecond) != nil {
			return
		}
	}
}

func (a *Adapter) Stop(ctx context.Context, id string, turnOnly bool) (session.StopResult, error) {
	var res session.StopResult
	r, ok := a.live()[id]
	if !ok {
		if _, err := a.Get(ctx, id); err != nil {
			return res, err
		}
		res.Hint = "the session is not running"
		return res, nil
	}
	mod := a.modOK(r)
	if r.Status != "idle" || r.WaitingFor != "" {
		if !mod {
			if turnOnly {
				return res, noMod(id)
			}
		} else {
			ack, err := a.post(ctx, id, InboxMessage{Kind: "interrupt"})
			if err != nil {
				return res, err
			}
			res.TurnInterrupted = ack.Status == AckAborted
		}
	}
	if turnOnly {
		return res, nil
	}
	if !a.terminable(r) {
		switch surfaceOf(r) {
		case "desktop", "vscode":
			res.Hint = "this session runs in Claude Desktop or VS Code; ask the user to close it there"
		default:
			res.Hint = "agentctl does not end Claude processes on Windows; ask the user to exit Claude Code (Ctrl+D twice)"
		}
		return res, nil
	}
	if !a.Alive(r.PID, r.ProcStart) {
		return res, nil
	}
	if err := a.Terminate(r.PID); err != nil {
		return res, session.Errf(session.CodeProviderError, "cannot stop process %d: %v", r.PID, err)
	}
	deadline := a.Now().Add(5 * time.Second)
	for a.Now().Before(deadline) {
		if !a.Alive(r.PID, r.ProcStart) {
			res.ProcessStopped = true
			return res, nil
		}
		if err := a.Sleep(ctx, 100*time.Millisecond); err != nil {
			return res, err
		}
	}
	res.Hint = "sent SIGTERM but the process is still running"
	return res, nil
}

// ensureStopped stops a running session before archive or delete.
func (a *Adapter) ensureStopped(ctx context.Context, id string) error {
	r, ok := a.live()[id]
	if !ok {
		return nil
	}
	res, err := a.Stop(ctx, id, false)
	if err != nil {
		return err
	}
	if res.ProcessStopped {
		return nil
	}
	s := a.fromRecord(r)
	e := session.Errf(session.CodeUserAction, "Claude session %s is still running; ask the user to close it first", id)
	e.Action = &session.Action{Kind: "close_claude", Dir: s.Cwd, SessionID: session.Ptr(id), Instructions: map[string]string{
		"desktop":  "Claude Desktop > Code > close the session",
		"terminal": "exit Claude Code (Ctrl+D twice) in the terminal running it",
		"vscode":   "close the Claude Code session in VS Code",
	}}
	return e
}

func (a *Adapter) Archive(ctx context.Context, id string) error {
	if _, err := a.Get(ctx, id); err != nil {
		return err
	}
	if err := a.ensureStopped(ctx, id); err != nil {
		return err
	}
	m := a.store.meta(id)
	m.Archived, m.UpdatedAt = true, a.Now().UnixMilli()
	return a.store.writeMeta(id, m)
}

func (a *Adapter) Delete(ctx context.Context, id string) error {
	if _, err := a.Get(ctx, id); err != nil {
		return err
	}
	if err := a.ensureStopped(ctx, id); err != nil {
		return err
	}
	paths, _ := filepath.Glob(filepath.Join(a.ProjectsDir, "*", id+".jsonl"))
	dirs, _ := filepath.Glob(filepath.Join(a.ProjectsDir, "*", id))
	for _, p := range append(paths, dirs...) {
		if err := os.RemoveAll(p); err != nil {
			return session.Errf(session.CodeProviderError, "cannot remove %s: %v", p, err)
		}
	}
	return os.RemoveAll(a.store.dir(id))
}

// Doctor reports what works on the Claude side.
func (a *Adapter) Doctor(ctx context.Context) any {
	out := map[string]any{"available": false}
	var problems []string
	if path, err := exec.LookPath("claude"); err != nil {
		problems = append(problems, "claude is not on PATH")
	} else {
		cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if b, err := exec.CommandContext(cctx, path, "--version").Output(); err == nil {
			out["version"] = strings.TrimSpace(string(b))
		}
	}
	if _, err := os.Stat(a.SessionsDir); err != nil {
		problems = append(problems, "cannot read "+a.SessionsDir+" (no Claude Code session has run yet?)")
	} else {
		out["available"] = true
		recs, unreadable := readRecords(a.SessionsDir)
		liveN, modN := 0, 0
		for _, r := range recs {
			if a.Alive(r.PID, r.ProcStart) {
				liveN++
				if a.modOK(r) {
					modN++
				}
			}
		}
		out["liveSessions"], out["modSessions"] = liveN, modN
		if unreadable > 0 {
			problems = append(problems, strconv.Itoa(unreadable)+" session records could not be read (Claude Code changed the format?)")
		}
		if liveN > modN {
			problems = append(problems, strconv.Itoa(liveN-modN)+" running sessions do not have the agentctl Mod; send and stop --turn will not work there (install plugins/agentctl and set CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1)")
		}
	}
	if problems == nil {
		problems = []string{}
	}
	out["problems"] = problems
	return out
}
