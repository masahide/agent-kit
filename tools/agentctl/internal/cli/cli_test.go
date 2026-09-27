package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/masahide/agent-kit/tools/agentctl/internal/session"
)

// fake is an in-memory adapter.
type fake struct {
	p        session.Provider
	sessions []session.Session
	sent     []string
	states   []session.State // Get returns these one by one (then the last)
	create   func(dir string, o session.CreateOptions) (session.Session, bool, error)
	err      error
}

func (f *fake) Provider() session.Provider { return f.p }
func (f *fake) List(ctx context.Context, q session.ListQuery) ([]session.Session, *string, error) {
	if f.err != nil {
		return nil, nil, f.err
	}
	var out []session.Session
	for _, s := range f.sessions {
		if q.State == session.Archived {
			if s.State == session.Archived {
				out = append(out, s)
			}
			continue
		}
		if s.State != session.Archived && (q.All || s.State.Live()) {
			out = append(out, s)
		}
	}
	return out, nil, nil
}
func (f *fake) Get(ctx context.Context, id string) (session.Detail, error) {
	for _, s := range f.sessions {
		if s.ID == id {
			if len(f.states) > 0 {
				s.State = f.states[0]
				if len(f.states) > 1 {
					f.states = f.states[1:]
				}
			}
			return session.Detail{Session: s}, nil
		}
	}
	return session.Detail{}, session.Errf(session.CodeNotFound, "no %s", id)
}
func (f *fake) Messages(ctx context.Context, id string, last int) ([]session.Message, error) {
	return nil, nil
}
func (f *fake) Create(ctx context.Context, dir string, o session.CreateOptions) (session.Session, bool, error) {
	return f.create(dir, o)
}
func (f *fake) Resume(ctx context.Context, id string) (session.Session, error) {
	return session.Session{}, nil
}
func (f *fake) Send(ctx context.Context, id, text string) (session.Delivery, error) {
	f.sent = append(f.sent, id+":"+text)
	return session.TurnStarted, nil
}
func (f *fake) Stop(ctx context.Context, id string, turnOnly bool) (session.StopResult, error) {
	return session.StopResult{}, nil
}
func (f *fake) Archive(ctx context.Context, id string) error { return nil }
func (f *fake) Delete(ctx context.Context, id string) error  { return nil }

func sess(p session.Provider, id string, st session.State) session.Session {
	return session.Session{ID: id, Provider: p, State: st, Cwd: "/w", Capabilities: session.Capabilities{Send: true}}
}

type result struct {
	code           int
	stdout, stderr string
}

func run(t *testing.T, adapters []session.Adapter, stdin string, args ...string) result {
	t.Helper()
	var out, errb bytes.Buffer
	now := time.Unix(1790498000, 0)
	deps := Deps{
		Adapters: adapters,
		Now:      func() time.Time { return now },
		Sleep: func(ctx context.Context, d time.Duration) error {
			now = now.Add(d)
			return nil
		},
	}
	code := RunWith(context.Background(), args, deps, strings.NewReader(stdin), &out, &errb)
	return result{code, out.String(), errb.String()}
}

func defaultAdapters() (*fake, *fake) {
	cl := &fake{p: session.Claude, sessions: []session.Session{
		sess(session.Claude, "3f746262-1811-5237-9497-992c2b8dd58a", session.Running),
		sess(session.Claude, "3f7aaaaa-0000-4000-8000-000000000000", session.Stopped),
	}}
	cx := &fake{p: session.Codex, sessions: []session.Session{
		sess(session.Codex, "01a0e1f3-7eb0-7c91-8567-fa0b88d63c82", session.Idle),
		sess(session.Codex, "01a0ffff-0000-7000-8000-000000000000", session.Archived),
	}}
	return cl, cx
}

func TestHelpIsTheSameEverywhere(t *testing.T) {
	cl, cx := defaultAdapters()
	ad := []session.Adapter{cl, cx}
	for _, c := range commands() {
		if c.Name() == "help" {
			continue // `help --help` is the top help
		}
		base := run(t, ad, "", append(append([]string{}, c.Path...), "--help")...)
		if base.code != 0 || !strings.HasPrefix(base.stdout, "Usage: agentctl "+c.Name()) {
			t.Fatalf("%s --help: %d %q", c.Name(), base.code, base.stdout)
		}
		for _, args := range [][]string{
			append(append([]string{}, c.Path...), "-h"),
			append([]string{"help"}, c.Path...),
		} {
			if r := run(t, ad, "", args...); r.code != 0 || r.stdout != base.stdout {
				t.Errorf("%v differs from %s --help", args, c.Name())
			}
		}
		if c.Write && !strings.Contains(base.stdout, "This is a live write.") {
			t.Errorf("%s: write commands say so", c.Name())
		}
	}
	top := run(t, ad, "")
	if top.code != 0 || !strings.Contains(top.stdout, "Start with:") || top.stdout != run(t, ad, "", "--help").stdout {
		t.Errorf("bare agentctl shows the top help")
	}
	if g := run(t, ad, "", "sessions"); g.code != 0 || !strings.Contains(g.stdout, "agentctl sessions send") {
		t.Errorf("bare group shows its commands: %q", g.stdout)
	}
	var h helpJSON
	r := run(t, ad, "", "--json", "help", "sessions", "send")
	if err := json.Unmarshal([]byte(r.stdout), &h); err != nil || h.Command != "sessions send" || !h.IsWrite {
		t.Errorf("help --json: %v %+v", err, h)
	}
}

func TestArgumentErrorsShowHelp(t *testing.T) {
	cl, cx := defaultAdapters()
	ad := []session.Adapter{cl, cx}
	cases := []struct {
		args       []string
		usage      string // the help that is shown
		suggestion string
	}{
		{[]string{"sesions", "list"}, "agentctl - list and drive", "sessions"},
		{[]string{"sessions", "lsit"}, "Usage: agentctl sessions <command>", "sessions list"},
		{[]string{"sessions", "send", "3f74", "--txt", "hi"}, "Usage: agentctl sessions send", "--text"},
		{[]string{"sessions", "send", "3f74"}, "Usage: agentctl sessions send", ""},
		{[]string{"sessions", "get"}, "Usage: agentctl sessions get", ""},
		{[]string{"sessions", "wait", "3f74", "--until", "done"}, "Usage: agentctl sessions wait", "idle"},
		{[]string{"sessions", "list", "--limit", "abc"}, "Usage: agentctl sessions list", ""},
		{[]string{"sessions", "list", "--cursor", "x"}, "Usage: agentctl sessions list", ""},
		{[]string{"sessions", "delete", "3f74"}, "Usage: agentctl sessions delete", ""},
	}
	for _, c := range cases {
		r := run(t, ad, "", c.args...)
		if r.code != 2 || r.stdout != "" || !strings.HasPrefix(r.stderr, "error: ") || !strings.Contains(r.stderr, c.usage) {
			t.Errorf("%v: code=%d stdout=%q stderr=%q", c.args, r.code, r.stdout, r.stderr)
		}
		if c.suggestion != "" && !strings.Contains(r.stderr, "did you mean: "+c.suggestion) {
			t.Errorf("%v: no suggestion %q in %q", c.args, c.suggestion, r.stderr)
		}

		j := run(t, ad, "", append([]string{"--json"}, c.args...)...)
		var out struct {
			Error session.Error `json:"error"`
		}
		if err := json.Unmarshal([]byte(j.stdout), &out); err != nil || j.code != 2 {
			t.Errorf("%v --json: stdout must be JSON only: %v %q", c.args, err, j.stdout)
			continue
		}
		if !strings.Contains(out.Error.Usage, c.usage) || out.Error.Help == "" || !strings.Contains(j.stderr, c.usage) {
			t.Errorf("%v --json: usage missing: %+v", c.args, out.Error)
		}
	}
}

func TestResolve(t *testing.T) {
	cl, cx := defaultAdapters()
	ad := []session.Adapter{cl, cx}

	r := run(t, ad, "", "--json", "sessions", "get", "3f7")
	var out struct {
		Error session.Error `json:"error"`
	}
	_ = json.Unmarshal([]byte(r.stdout), &out)
	if r.code != 3 || out.Error.Code != session.CodeAmbiguousID || len(out.Error.Candidates) != 2 {
		t.Fatalf("ambiguous: %d %s", r.code, r.stdout)
	}
	if r := run(t, ad, "", "--json", "sessions", "get", "3f74"); r.code != 0 || !strings.Contains(r.stdout, `"id": "3f746262-1811-5237-9497-992c2b8dd58a"`) {
		t.Fatalf("unique prefix: %d %s", r.code, r.stdout)
	}
	if r := run(t, ad, "", "--json", "sessions", "get", "01a0ff"); r.code != 0 {
		t.Fatalf("archived sessions resolve too: %d %s", r.code, r.stdout)
	}
	if r := run(t, ad, "", "--json", "sessions", "get", "codex:3f74"); r.code != 3 {
		t.Fatalf("provider prefix limits the search: %d", r.code)
	}
	if r := run(t, ad, "", "--json", "sessions", "get", "zzz"); r.code != 3 || !strings.Contains(r.stdout, session.CodeNotFound) {
		t.Fatalf("not found: %d %s", r.code, r.stdout)
	}
}

func TestListReportsAnUnavailableProvider(t *testing.T) {
	cl, cx := defaultAdapters()
	cx.err = session.Errf(session.CodeProviderUnavailable, "no daemon")
	r := run(t, []session.Adapter{cl, cx}, "", "--json", "sessions", "list")
	var out listResult
	if err := json.Unmarshal([]byte(r.stdout), &out); err != nil || r.code != 0 {
		t.Fatalf("%v %d", err, r.code)
	}
	if len(out.Items) != 1 || out.Unavailable["codex"] != "no daemon" {
		t.Errorf("%+v", out)
	}
	if r := run(t, []session.Adapter{cl, cx}, "", "--json", "--provider", "codex", "sessions", "list"); r.code != 4 {
		t.Errorf("asking for the unavailable provider fails: %d", r.code)
	}
}

func TestSendReadsStdinAndWaitEnds(t *testing.T) {
	cl, cx := defaultAdapters()
	ad := []session.Adapter{cl, cx}
	r := run(t, ad, "from stdin\n", "--json", "send", "01a0e1", "--text-file", "-")
	if r.code != 0 || cx.sent[0] != "01a0e1f3-7eb0-7c91-8567-fa0b88d63c82:from stdin\n" || !strings.Contains(r.stdout, `"next"`) {
		t.Fatalf("%d %s %v", r.code, r.stdout, cx.sent)
	}

	cx.states = []session.State{session.Running, session.Running, session.Idle}
	r = run(t, ad, "", "--json", "sessions", "wait", "01a0e1")
	if r.code != 0 || !strings.Contains(r.stdout, `"reached": true`) {
		t.Fatalf("wait: %d %s", r.code, r.stdout)
	}
	cx.states = []session.State{session.Running}
	r = run(t, ad, "", "--json", "sessions", "wait", "01a0e1", "--timeout", "3")
	if r.code != 1 || !strings.Contains(r.stdout, session.CodeTimeout) {
		t.Fatalf("timeout: %d %s", r.code, r.stdout)
	}
}

func TestCreateWaitsForTheUser(t *testing.T) {
	cl, cx := defaultAdapters()
	tries := 0
	cl.create = func(dir string, o session.CreateOptions) (session.Session, bool, error) {
		tries++
		if tries < 3 {
			e := session.Errf(session.CodeUserAction, "start claude in %s", dir)
			e.Action = &session.Action{Kind: "start_claude", Instructions: map[string]string{"terminal": "cd " + dir + " && claude"}}
			return session.Session{}, false, e
		}
		s := sess(session.Claude, "3f746262-1811-5237-9497-992c2b8dd58a", session.Idle)
		return s, false, nil
	}
	dir := t.TempDir()
	r := run(t, []session.Adapter{cl, cx}, "", "--json", "sessions", "create", "claude", dir)
	if r.code != 5 || !strings.Contains(r.stdout, "user_action_required") {
		t.Fatalf("without --wait: %d %s", r.code, r.stdout)
	}
	tries = 0
	r = run(t, []session.Adapter{cl, cx}, "", "--json", "sessions", "create", "claude", dir, "--wait", "10", "--prompt", "go")
	if r.code != 0 || !strings.Contains(r.stderr, "cd "+dir+" && claude") || cl.sent[0] != "3f746262-1811-5237-9497-992c2b8dd58a:go" {
		t.Fatalf("with --wait: %d %s %s %v", r.code, r.stdout, r.stderr, cl.sent)
	}
}

func TestVersion(t *testing.T) {
	r := run(t, nil, "", "--version")
	if r.code != 0 || r.stdout != "agentctl dev\n" {
		t.Fatalf("%d %q", r.code, r.stdout)
	}
	r = run(t, nil, "", "--json", "--version")
	if r.code != 0 || !strings.Contains(r.stdout, `"version": "dev"`) {
		t.Fatalf("%d %q", r.code, r.stdout)
	}
}
