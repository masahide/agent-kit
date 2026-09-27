package codex

import (
	"bufio"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/masahide/agent-kit/tools/agentctl/internal/session"
)

// daemon is a fake Codex app-server: WebSocket on a Unix socket, JSON-RPC
// answered by handle. It records every call.
type daemon struct {
	socket string
	mu     sync.Mutex
	calls  []call
	handle func(method string, params map[string]any) (any, *RPCError)
}

type call struct {
	Method string
	Params map[string]any
}

func fakeDaemon(t *testing.T, handle func(string, map[string]any) (any, *RPCError)) *daemon {
	t.Helper()
	dir, err := os.MkdirTemp("", "cx")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	d := &daemon{socket: filepath.Join(dir, "s.sock"), handle: handle}
	l, err := net.Listen("unix", d.socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go d.serve(c)
		}
	}()
	return d
}

func (d *daemon) methods() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []string
	for _, c := range d.calls {
		if c.Method != "initialize" {
			out = append(out, c.Method)
		}
	}
	return out
}

func (d *daemon) serve(c net.Conn) {
	defer c.Close()
	r := bufio.NewReader(c)
	req, err := http.ReadRequest(r)
	if err != nil {
		return
	}
	sum := sha1.Sum([]byte(req.Header.Get("Sec-WebSocket-Key") + wsGUID))
	io.WriteString(c, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+
		base64.StdEncoding.EncodeToString(sum[:])+"\r\n\r\n")
	// The client wraps the conn with its own reader; frames from the client are masked.
	ws := &wsConn{c: c, r: r}
	send := func(v any) {
		b, _ := json.Marshal(v)
		// server frames are not masked
		hdr := []byte{0x81}
		switch n := len(b); {
		case n < 126:
			hdr = append(hdr, byte(n))
		case n < 1<<16:
			hdr = append(hdr, 126, byte(n>>8), byte(n))
		default:
			hdr = binary.BigEndian.AppendUint64(append(hdr, 127), uint64(n))
		}
		c.Write(append(hdr, b...))
	}
	// A notification first, like the real daemon, to check the client skips it.
	send(map[string]any{"method": "remoteControl/status/changed", "params": map[string]any{}})
	for {
		msg, err := ws.readMessage()
		if err != nil {
			return
		}
		var m struct {
			ID     *int           `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if json.Unmarshal(msg, &m) != nil || m.ID == nil {
			continue
		}
		d.mu.Lock()
		d.calls = append(d.calls, call{m.Method, m.Params})
		d.mu.Unlock()
		if m.Method == "initialize" {
			send(map[string]any{"id": *m.ID, "result": map[string]any{"userAgent": "fake"}})
			continue
		}
		res, rerr := d.handle(m.Method, m.Params)
		if rerr != nil {
			send(map[string]any{"id": *m.ID, "error": rerr})
		} else {
			send(map[string]any{"id": *m.ID, "result": res})
		}
	}
}

func th(id, status string, flags ...string) map[string]any {
	st := map[string]any{"type": status}
	if status == "active" {
		if flags == nil {
			flags = []string{}
		}
		st["activeFlags"] = flags
	}
	return map[string]any{"id": id, "cwd": "/w/api", "preview": "fix the flaky test", "name": nil,
		"createdAt": 1790497226, "updatedAt": 1790497230, "status": st}
}

const tid = "01a0e1f3-7eb0-7c91-8567-fa0b88d63c82"

func TestListReadsLoadedThreads(t *testing.T) {
	d := fakeDaemon(t, func(m string, p map[string]any) (any, *RPCError) {
		switch m {
		case "thread/loaded/list":
			return map[string]any{"data": []string{tid}, "nextCursor": nil}, nil
		case "thread/read":
			return map[string]any{"thread": th(tid, "active", "waitingOnApproval")}, nil
		case "thread/list":
			return map[string]any{"data": []any{th(tid, "notLoaded"), th("other", "notLoaded")}, "nextCursor": "c2"}, nil
		}
		return nil, &RPCError{Code: -32601, Message: "unknown"}
	})
	a := &Adapter{Socket: d.socket}
	items, next, err := a.List(context.Background(), session.ListQuery{})
	if err != nil || next != nil || len(items) != 1 {
		t.Fatalf("%v %v %+v", err, next, items)
	}
	s := items[0]
	if s.State != session.Waiting || *s.WaitingFor != "waitingOnApproval" || *s.Title != "fix the flaky test" || s.Cwd != "/w/api" {
		t.Errorf("unexpected %+v", s)
	}
	items, next, _ = a.List(context.Background(), session.ListQuery{All: true, Limit: 2})
	if len(items) != 2 || items[1].ID != "other" || items[1].State != session.Stopped || next == nil || *next != "c2" {
		t.Fatalf("--all: %+v %v", items, next)
	}
}

func TestSendStartsOrSteers(t *testing.T) {
	status := "idle"
	d := fakeDaemon(t, func(m string, p map[string]any) (any, *RPCError) {
		switch m {
		case "thread/read", "thread/resume":
			return map[string]any{"thread": th(tid, status)}, nil
		case "thread/turns/list":
			return map[string]any{"data": []any{map[string]any{"id": "turn-9", "status": "inProgress"}}}, nil
		case "turn/start", "turn/steer":
			return map[string]any{}, nil
		}
		return nil, &RPCError{Code: -32601, Message: "unknown"}
	})
	a := &Adapter{Socket: d.socket}
	ctx := context.Background()
	startWait = 0 // the fake daemon never turns active by itself here
	defer func() { startWait = 3 * time.Second }()
	if got, err := a.Send(ctx, tid, "hi"); err != nil || got != session.TurnStarted {
		t.Fatalf("idle: %v %v", got, err)
	}
	status = "active"
	if got, err := a.Send(ctx, tid, "more"); err != nil || got != session.Steered {
		t.Fatalf("active: %v %v", got, err)
	}
	d.mu.Lock()
	last := d.calls[len(d.calls)-1]
	d.mu.Unlock()
	if last.Method != "turn/steer" || last.Params["expectedTurnId"] != "turn-9" {
		t.Errorf("steer call: %+v", last)
	}
	status = "notLoaded"
	if _, err := a.Send(ctx, tid, "back"); err != nil {
		t.Fatal(err)
	}
	m := d.methods()
	if m[len(m)-2] != "thread/resume" || m[len(m)-1] != "turn/start" {
		t.Errorf("a stopped thread is resumed first: %v", m)
	}
}

func TestStopInterruptsTheRunningTurn(t *testing.T) {
	d := fakeDaemon(t, func(m string, p map[string]any) (any, *RPCError) {
		switch m {
		case "thread/read":
			return map[string]any{"thread": th(tid, "active")}, nil
		case "thread/turns/list":
			return map[string]any{"data": []any{map[string]any{"id": "turn-9", "status": "inProgress"}}}, nil
		case "turn/interrupt":
			return map[string]any{}, nil
		}
		return nil, &RPCError{Code: -32601, Message: "unknown"}
	})
	a := &Adapter{Socket: d.socket}
	r, err := a.Stop(context.Background(), tid, true)
	if err != nil || !r.TurnInterrupted || r.ProcessStopped {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestMessagesOldestFirst(t *testing.T) {
	d := fakeDaemon(t, func(m string, p map[string]any) (any, *RPCError) {
		if m != "thread/items/list" || p["sortDirection"] != "desc" {
			return nil, &RPCError{Code: -32601, Message: "unknown"}
		}
		return map[string]any{"data": []any{
			map[string]any{"item": map[string]any{"type": "agentMessage", "id": "i3", "text": "done"}, "startedAtMs": 3000},
			map[string]any{"item": map[string]any{"type": "commandExecution", "id": "i2"}},
			map[string]any{"item": map[string]any{"type": "userMessage", "id": "i1", "content": []any{map[string]any{"type": "text", "text": "go"}}}},
		}, "nextCursor": nil}, nil
	})
	a := &Adapter{Socket: d.socket}
	msgs, err := a.Messages(context.Background(), tid, 10)
	if err != nil || len(msgs) != 2 || msgs[0].Text != "go" || msgs[1].Role != "assistant" {
		t.Fatalf("%+v %v", msgs, err)
	}
}

func TestErrors(t *testing.T) {
	d := fakeDaemon(t, func(m string, p map[string]any) (any, *RPCError) {
		return nil, &RPCError{Code: -32600, Message: "thread not found: x"}
	})
	a := &Adapter{Socket: d.socket}
	var se *session.Error
	if _, err := a.Get(context.Background(), "x"); !errors.As(err, &se) || se.Code != session.CodeNotFound {
		t.Fatalf("not found: %v", err)
	}
	if _, err := a.Raw(context.Background(), "thread/archive", json.RawMessage(`{}`)); !errors.As(err, &se) || se.Code != session.CodeProviderError || len(se.Detail) == 0 {
		t.Fatalf("rpc error: %v", err)
	}
	gone := &Adapter{Socket: filepath.Join(t.TempDir(), "none.sock")}
	if _, _, err := gone.List(context.Background(), session.ListQuery{}); !errors.As(err, &se) || se.Code != session.CodeProviderUnavailable {
		t.Fatalf("no daemon: %v", err)
	}
}

func TestLoadedThreadThatCannotBeReadIsRunning(t *testing.T) {
	d := fakeDaemon(t, func(m string, p map[string]any) (any, *RPCError) {
		switch m {
		case "thread/loaded/list":
			return map[string]any{"data": []string{tid}}, nil
		case "thread/read":
			return nil, &RPCError{Code: -32603, Message: "rollout is being written"}
		}
		return nil, &RPCError{Code: -32601, Message: "unknown"}
	})
	a := &Adapter{Socket: d.socket}
	items, _, err := a.List(context.Background(), session.ListQuery{})
	if err != nil || len(items) != 1 || items[0].State != session.Running {
		t.Fatalf("list: %+v %v", items, err)
	}
	got, err := a.Get(context.Background(), tid)
	if err != nil || got.State != session.Running {
		t.Fatalf("get: %+v %v", got, err)
	}
	if raw, _ := json.Marshal(got.Raw); !strings.Contains(string(raw), "rollout is being written") {
		t.Errorf("the read error is kept in raw: %s", raw)
	}
	var se *session.Error
	if _, err := a.Get(context.Background(), "not-loaded"); !errors.As(err, &se) {
		t.Fatalf("a thread that is not loaded still fails: %v", err)
	}
}

func TestSendWaitsUntilTheTurnIsActive(t *testing.T) {
	var mu sync.Mutex
	reads := 0
	d := fakeDaemon(t, func(m string, p map[string]any) (any, *RPCError) {
		mu.Lock()
		defer mu.Unlock()
		switch m {
		case "thread/read":
			reads++
			if reads <= 3 { // before the send, and twice while the daemon has not marked the turn
				return map[string]any{"thread": th(tid, "idle")}, nil
			}
			return map[string]any{"thread": th(tid, "active")}, nil
		case "turn/start":
			return map[string]any{"turn": map[string]any{"id": "turn-1", "status": "inProgress"}}, nil
		case "thread/turns/list":
			return map[string]any{"data": []any{map[string]any{"id": "turn-1", "status": "inProgress"}}}, nil
		}
		return nil, &RPCError{Code: -32601, Message: "unknown"}
	})
	a := &Adapter{Socket: d.socket}
	if got, err := a.Send(context.Background(), tid, "count"); err != nil || got != session.TurnStarted {
		t.Fatalf("%v %v", got, err)
	}
	mu.Lock()
	defer mu.Unlock()
	if reads != 4 {
		t.Errorf("send returns once the thread is active: %d reads", reads)
	}
}
