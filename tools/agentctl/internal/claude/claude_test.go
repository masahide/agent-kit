package claude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/masahide/agent-kit/tools/agentctl/internal/session"
)

const fixtures = "../../../../plugins/agentctl/tests/fixtures"

// TestProtocolFixtures checks that the Go types read and write the shared
// samples exactly, and that the Mod's TS mirror (tests/fixtures/protocol.ts)
// holds the same samples.
func TestProtocolFixtures(t *testing.T) {
	samples := map[string]any{
		"mod.json":             &ModFile{},
		"meta.json":            &MetaFile{},
		"inbox-prompt.json":    &InboxMessage{},
		"inbox-interrupt.json": &InboxMessage{},
		"ack-queued.json":      &Ack{},
		"ack-dropped.json":     &Ack{},
	}
	ts, err := os.ReadFile(filepath.Join(fixtures, "protocol.ts"))
	if err != nil {
		t.Fatal(err)
	}
	mirror := map[string]string{}
	for _, m := range regexp.MustCompile(`(?m)^export const (\w+) = (\{.*\})$`).FindAllStringSubmatch(string(ts), -1) {
		mirror[m[1]] = m[2]
	}
	for name, v := range samples {
		b, err := os.ReadFile(filepath.Join(fixtures, "protocol", name))
		if err != nil {
			t.Fatal(err)
		}
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.DisallowUnknownFields()
		if err := dec.Decode(v); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		out, _ := json.Marshal(v)
		if !jsonEqual(t, out, b) {
			t.Errorf("%s: Go writes %s, sample is %s", name, out, b)
		}
		camel := regexp.MustCompile(`-(\w)`).ReplaceAllStringFunc(strings.TrimSuffix(name, ".json"), func(s string) string { return strings.ToUpper(s[1:]) })
		if got, ok := mirror[camel]; !ok || !jsonEqual(t, []byte(got), b) {
			t.Errorf("protocol.ts %s differs from protocol/%s", camel, name)
		}
	}
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &y); err != nil {
		t.Fatal(err)
	}
	xa, _ := json.Marshal(x)
	ya, _ := json.Marshal(y)
	return string(xa) == string(ya)
}

func TestModWithoutPid(t *testing.T) {
	e := newEnv(t)
	r := Record{PID: 1, SessionID: idA, Cwd: "/w/a", Status: "idle", StartedAt: 1000}
	e.record(r)
	e.write(e.a.store.modPath(idA), ModFile{V: 1, SessionID: idA, PID: 0, StartedAt: 1500})
	if !e.a.modOK(r) {
		t.Error("pid 0 (no sh, as on Windows) with a mod.json written after the process started counts")
	}
	e.write(e.a.store.modPath(idA), ModFile{V: 1, SessionID: idA, PID: 0, StartedAt: 500})
	if e.a.modOK(r) {
		t.Error("a mod.json from before the process started is stale")
	}
}

func TestStopDoesNotEndTheProcessWhereItCannot(t *testing.T) {
	e := newEnv(t)
	e.a.CanTerminate = false
	e.record(Record{PID: 1, SessionID: idA, Cwd: "/w/a", Status: "idle"})
	r, err := e.a.Stop(context.Background(), idA, false)
	if err != nil || r.ProcessStopped || len(e.kills) != 0 || !strings.Contains(r.Hint, "Windows") {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestLinuxStartTimeMatchesOwnProcess(t *testing.T) {
	st, ok := linuxStartTime(os.Getpid())
	if !ok {
		t.Skip("no /proc")
	}
	if !processAlive(os.Getpid(), st) {
		t.Error("own process with its own start time should be alive")
	}
	if processAlive(os.Getpid(), st+"0") {
		t.Error("a different start time means the pid was reused")
	}
}

func TestSurfaceOf(t *testing.T) {
	for _, c := range []struct {
		r    Record
		want string
	}{
		{Record{Entrypoint: "claude-desktop"}, "desktop"},
		{Record{Entrypoint: "local-agent"}, "desktop"},
		{Record{Entrypoint: "claude-vscode"}, "vscode"},
		{Record{Entrypoint: "cli", Tmux: "/tmp/tmux-0/default,1,0"}, "tmux"},
		{Record{Entrypoint: "cli"}, "terminal"},
	} {
		if got := surfaceOf(c.r); got != c.want {
			t.Errorf("%+v: got %s want %s", c.r, got, c.want)
		}
	}
}

// env is a fake ~/.claude and ~/.agentctl with processes that live while alive[pid] is true.
type env struct {
	t     *testing.T
	a     *Adapter
	alive map[int]bool
	kills []int
	now   time.Time
}

func newEnv(t *testing.T) *env {
	home := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("AGENTCTL_HOME", "")
	e := &env{t: t, alive: map[int]bool{}, now: time.UnixMilli(1790498000000)}
	a := New(home)
	a.Alive = func(pid int, _ string) bool { return e.alive[pid] }
	a.CanTerminate = true
	a.Terminate = func(pid int) error {
		e.kills = append(e.kills, pid)
		e.alive[pid] = false
		return nil
	}
	a.Now = func() time.Time { return e.now }
	a.Sleep = func(ctx context.Context, d time.Duration) error {
		e.now = e.now.Add(d)
		return nil
	}
	e.a = a
	return e
}

func (e *env) write(path string, v any) {
	e.t.Helper()
	b, ok := v.([]byte)
	if !ok {
		var err error
		if b, err = json.Marshal(v); err != nil {
			e.t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) record(r Record) {
	e.alive[r.PID] = true
	e.write(filepath.Join(e.a.SessionsDir, "x"+string(rune('0'+r.PID%10))+".json"), r)
}

func (e *env) transcript(id, cwd string, lines ...string) {
	head := `{"type":"user","uuid":"u0","cwd":"` + cwd + `","timestamp":"2026-09-27T08:00:00Z","message":{"role":"user","content":"start"}}`
	e.write(filepath.Join(e.a.ProjectsDir, "-p", id+".jsonl"), []byte(strings.Join(append([]string{head}, lines...), "\n")+"\n"))
}

func (e *env) mod(id string, pid int) {
	e.write(e.a.store.modPath(id), ModFile{V: 1, SessionID: id, PID: pid, ModVersion: "0.1.0"})
}

const (
	idA = "aaaaaaaa-0000-4000-8000-000000000001"
	idB = "bbbbbbbb-0000-4000-8000-000000000002"
)

func TestListLiveThenStopped(t *testing.T) {
	e := newEnv(t)
	e.record(Record{PID: 1, SessionID: idA, Cwd: "/w/a", Status: "busy", Entrypoint: "claude-desktop", StartedAt: 1})
	e.mod(idA, 1)
	e.transcript(idA, "/w/a", `{"type":"ai-title","aiTitle":"Fix login"}`)
	e.transcript(idB, "/w/b")
	ctx := context.Background()

	items, next, err := e.a.List(ctx, session.ListQuery{})
	if err != nil || next != nil || len(items) != 1 {
		t.Fatalf("live only: %v %v %+v", err, next, items)
	}
	s := items[0]
	if s.State != session.Running || *s.Surface != "desktop" || !s.Capabilities.Send || s.Capabilities.Stop != true || *s.Title != "Fix login" {
		t.Errorf("unexpected live session %+v", s)
	}

	items, _, _ = e.a.List(ctx, session.ListQuery{All: true})
	if len(items) != 2 || items[1].ID != idB || items[1].State != session.Stopped || items[1].Cwd != "/w/b" {
		t.Fatalf("all: %+v", items)
	}

	items, next, _ = e.a.List(ctx, session.ListQuery{All: true, Limit: 1})
	if len(items) != 1 || next == nil || *next != "1" {
		t.Fatalf("first page: %+v %v", items, next)
	}
	items, next, _ = e.a.List(ctx, session.ListQuery{All: true, Limit: 1, Cursor: "1"})
	if len(items) != 1 || items[0].ID != idB || next != nil {
		t.Fatalf("second page: %+v %v", items, next)
	}
}

func TestArchivedOnlyWithStateArchived(t *testing.T) {
	e := newEnv(t)
	e.transcript(idB, "/w/b")
	ctx := context.Background()
	if err := e.a.Archive(ctx, idB); err != nil {
		t.Fatal(err)
	}
	items, _, _ := e.a.List(ctx, session.ListQuery{All: true})
	if len(items) != 0 {
		t.Fatalf("archived sessions are hidden from --all: %+v", items)
	}
	items, _, _ = e.a.List(ctx, session.ListQuery{State: session.Archived})
	if len(items) != 1 || items[0].State != session.Archived {
		t.Fatalf("--state archived: %+v", items)
	}
}

func TestCrashedRecordIsNotLive(t *testing.T) {
	e := newEnv(t)
	e.record(Record{PID: 3, SessionID: idA, Cwd: "/w/a", Status: "idle"})
	e.alive[3] = false
	items, _, _ := e.a.List(context.Background(), session.ListQuery{})
	if len(items) != 0 {
		t.Fatalf("a record whose process is gone is not live: %+v", items)
	}
}

func TestMessagesJoinsAssistantLinesAndSkipsTools(t *testing.T) {
	e := newEnv(t)
	e.transcript(idA, "/w/a",
		`{"type":"assistant","uuid":"x1","timestamp":"2026-09-27T08:00:01Z","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Looking."}]}}`,
		`{"type":"assistant","uuid":"x2","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","name":"Bash"}]}}`,
		`{"type":"user","uuid":"x3","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}`,
		`{"type":"assistant","uuid":"x4","message":{"id":"m1","role":"assistant","content":[{"type":"text","text":"Done."}]}}`,
		`{"type":"user","uuid":"x5","isSidechain":true,"message":{"role":"user","content":"subagent"}}`,
		`{"type":"assistant","uuid":"x6","message":{"id":"m2","role":"assistant","content":[{"type":"text","text":"`+strings.Repeat("あ", 2100)+`"}]}}`,
	)
	msgs, err := e.a.Messages(context.Background(), idA, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 || msgs[0].Text != "Looking.\nDone." || msgs[0].Role != "assistant" {
		t.Fatalf("got %+v", msgs)
	}
	if !msgs[1].Truncated || len([]rune(msgs[1].Text)) != 2000 {
		t.Errorf("long text should be cut at 2000 characters")
	}
}

// fakeMod answers the inbox like the Mod would.
func fakeMod(e *env, id string, status string) {
	inbox := e.a.store.inbox(id)
	orig := e.a.Sleep
	e.a.Sleep = func(ctx context.Context, d time.Duration) error {
		paths, _ := filepath.Glob(filepath.Join(inbox, "*.json"))
		for _, p := range paths {
			var m InboxMessage
			b, _ := os.ReadFile(p)
			_ = json.Unmarshal(b, &m)
			if _, ok := e.a.store.ack(id, m.ID); !ok {
				e.write(e.a.store.ackPath(id, m.ID), Ack{V: 1, ID: m.ID, Status: status})
			}
		}
		return orig(ctx, d)
	}
}

func TestSend(t *testing.T) {
	ctx := context.Background()
	for status, want := range map[string]session.Delivery{AckSubmitted: session.Submitted, AckQueued: session.Queued} {
		e := newEnv(t)
		e.record(Record{PID: 1, SessionID: idA, Cwd: "/w/a", Status: "busy"})
		e.mod(idA, 1)
		fakeMod(e, idA, status)
		got, err := e.a.Send(ctx, idA, "hello")
		if err != nil || got != want {
			t.Fatalf("%s: got %v %v", status, got, err)
		}
		left, _ := filepath.Glob(filepath.Join(e.a.store.inbox(idA), "*"))
		if status == AckSubmitted && len(left) != 0 {
			t.Errorf("a final ack removes the message: %v", left)
		}
	}
}

func TestSendErrors(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	e.record(Record{PID: 1, SessionID: idA, Cwd: "/w/a", Status: "idle"})
	e.mod(idA, 99) // written by an earlier process
	var se *session.Error
	if _, err := e.a.Send(ctx, idA, "x"); !errors.As(err, &se) || se.Code != session.CodeUnsupported {
		t.Fatalf("no Mod in this process: %v", err)
	}

	e.mod(idA, 1)
	if _, err := e.a.Send(ctx, idA, "x"); !errors.As(err, &se) || se.Code != session.CodeTimeout {
		t.Fatalf("Mod does not answer: %v", err)
	}

	e.transcript(idB, "/w/b")
	if _, err := e.a.Send(ctx, idB, "x"); !errors.As(err, &se) || se.Code != session.CodeUserAction || se.Action.Kind != "resume_claude" {
		t.Fatalf("stopped session: %v", err)
	}
	if !strings.Contains(se.Action.Instructions["terminal"], "claude --resume "+idB) {
		t.Errorf("terminal instruction: %q", se.Action.Instructions["terminal"])
	}
}

func TestCreateReusesOrAsksTheUser(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	var se *session.Error
	_, _, err := e.a.Create(ctx, "/w/a", session.CreateOptions{})
	if !errors.As(err, &se) || se.Code != session.CodeUserAction || se.Action.Instructions["terminal"] != "cd /w/a && claude" {
		t.Fatalf("no session: %v", err)
	}

	e.record(Record{PID: 1, SessionID: idA, Cwd: "/w/a", Status: "idle", StartedAt: e.now.UnixMilli() - 1000})
	s, reused, err := e.a.Create(ctx, "/w/a", session.CreateOptions{Name: "api"})
	if err != nil || !reused || s.ID != idA || *s.Title != "api" {
		t.Fatalf("reuse: %+v %v %v", s, reused, err)
	}
	if _, _, err := e.a.Create(ctx, "/w/a", session.CreateOptions{New: true, After: e.now}); !errors.As(err, &se) || se.Code != session.CodeUserAction {
		t.Fatalf("--new ignores sessions started before: %v", err)
	}
}

func TestStop(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	e.record(Record{PID: 1, SessionID: idA, Cwd: "/w/a", Status: "busy"})
	e.mod(idA, 1)
	fakeMod(e, idA, AckAborted)
	r, err := e.a.Stop(ctx, idA, false)
	if err != nil || !r.TurnInterrupted || !r.ProcessStopped || len(e.kills) != 1 {
		t.Fatalf("terminal: %+v %v kills=%v", r, err, e.kills)
	}

	e = newEnv(t)
	e.record(Record{PID: 2, SessionID: idB, Cwd: "/w/b", Status: "idle", Entrypoint: "claude-desktop"})
	r, err = e.a.Stop(ctx, idB, false)
	if err != nil || r.ProcessStopped || len(e.kills) != 0 || r.Hint == "" {
		t.Fatalf("desktop keeps its process: %+v %v", r, err)
	}
	var se *session.Error
	if err := e.a.Delete(ctx, idB); !errors.As(err, &se) || se.Code != session.CodeUserAction {
		t.Fatalf("delete of a running desktop session asks the user: %v", err)
	}
}

func TestDeleteRemovesTranscriptAndSharedDir(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	e.transcript(idB, "/w/b")
	e.mod(idB, 7)
	if err := e.a.Delete(ctx, idB); err != nil {
		t.Fatal(err)
	}
	if _, ok := findTranscript(e.a.ProjectsDir, idB); ok {
		t.Error("transcript still there")
	}
	if _, err := os.Stat(e.a.store.dir(idB)); !os.IsNotExist(err) {
		t.Error("shared dir still there")
	}
	var se *session.Error
	if _, err := e.a.Get(ctx, idB); !errors.As(err, &se) || se.Code != session.CodeNotFound {
		t.Fatalf("get after delete: %v", err)
	}
}
