package claude

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/masahide/agent-kit/tools/agentctl/internal/session"
)

var uuidRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// transcript is one ~/.claude/projects/<dir>/<sessionId>.jsonl.
type transcript struct {
	ID      string
	Path    string
	ModTime time.Time
}

// listTranscripts returns every transcript, newest first. Only files named
// after a session id count; a session id that appears in several project
// directories keeps its newest file.
func listTranscripts(projectsDir string) []transcript {
	paths, _ := filepath.Glob(filepath.Join(projectsDir, "*", "*.jsonl"))
	byID := map[string]transcript{}
	for _, p := range paths {
		id := strings.TrimSuffix(filepath.Base(p), ".jsonl")
		if !uuidRe.MatchString(id) {
			continue
		}
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		t := transcript{ID: id, Path: p, ModTime: st.ModTime()}
		if old, ok := byID[id]; !ok || t.ModTime.After(old.ModTime) {
			byID[id] = t
		}
	}
	out := make([]transcript, 0, len(byID))
	for _, t := range byID {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ModTime.After(out[j].ModTime) })
	return out
}

func findTranscript(projectsDir, id string) (transcript, bool) {
	paths, _ := filepath.Glob(filepath.Join(projectsDir, "*", id+".jsonl"))
	var best transcript
	found := false
	for _, p := range paths {
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		if !found || st.ModTime().After(best.ModTime) {
			best = transcript{ID: id, Path: p, ModTime: st.ModTime()}
			found = true
		}
	}
	return best, found
}

// entry is the part of a transcript line agentctl reads.
type entry struct {
	Type        string          `json:"type"`
	UUID        string          `json:"uuid"`
	Timestamp   *time.Time      `json:"timestamp"`
	Cwd         string          `json:"cwd"`
	IsSidechain bool            `json:"isSidechain"`
	IsMeta      bool            `json:"isMeta"`
	AITitle     string          `json:"aiTitle"`
	Message     json.RawMessage `json:"message"`
}

// head is what `sessions list` needs from a transcript without reading all of it.
type head struct {
	Cwd       string
	Title     string
	CreatedAt *time.Time
}

// headLimit bounds how much of a transcript is read for its head.
const headLimit = 256 << 10

func readHead(path string) head {
	var h head
	f, err := os.Open(path)
	if err != nil {
		return h
	}
	defer f.Close()
	r := bufio.NewReader(io.LimitReader(f, headLimit))
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 {
			var e entry
			if json.Unmarshal(line, &e) == nil {
				if h.Cwd == "" && e.Cwd != "" {
					h.Cwd = e.Cwd
				}
				if h.CreatedAt == nil && e.Timestamp != nil {
					h.CreatedAt = e.Timestamp
				}
				if e.Type == "ai-title" && e.AITitle != "" {
					h.Title = e.AITitle
				}
			}
		}
		if err != nil {
			return h
		}
	}
}

// maxText is where message texts are cut.
const maxText = 2000

type messageBody struct {
	ID      string          `json:"id"`
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type block struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// textOf returns the text blocks of a message content (a string or a list of blocks).
func textOf(content json.RawMessage) string {
	var s string
	if json.Unmarshal(content, &s) == nil {
		return s
	}
	var blocks []block
	if json.Unmarshal(content, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// readMessages returns the last n user and assistant messages of a transcript.
// Tool calls and tool results are left out; assistant lines of one API
// message are joined.
func readMessages(path string, n int) ([]session.Message, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var all []session.Message
	r := bufio.NewReader(f)
	for {
		line, rerr := r.ReadBytes('\n')
		if len(line) > 0 {
			var e entry
			if json.Unmarshal(line, &e) == nil && (e.Type == "user" || e.Type == "assistant") && !e.IsSidechain && !e.IsMeta {
				var m messageBody
				if json.Unmarshal(e.Message, &m) == nil {
					text := strings.TrimSpace(textOf(m.Content))
					if text != "" {
						id := e.UUID
						if e.Type == "assistant" && m.ID != "" {
							id = m.ID
						}
						if last := len(all) - 1; last >= 0 && all[last].ID == id {
							all[last].Text += "\n" + text
						} else {
							all = append(all, session.Message{ID: id, Role: e.Type, Text: text, At: e.Timestamp})
						}
					}
				}
			}
		}
		if rerr != nil {
			break
		}
	}
	if n >= 0 && len(all) > n {
		all = all[len(all)-n:]
	}
	for i := range all {
		if r := []rune(all[i].Text); len(r) > maxText {
			all[i].Text = string(r[:maxText])
			all[i].Truncated = true
		}
	}
	return all, nil
}
