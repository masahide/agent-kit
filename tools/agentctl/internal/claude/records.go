package claude

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// Record is Claude Code's own ~/.claude/sessions/<pid>.json. It is not a
// public format, so only pid, sessionId and cwd are required.
type Record struct {
	PID             int    `json:"pid"`
	SessionID       string `json:"sessionId"`
	Cwd             string `json:"cwd"`
	StartedAt       int64  `json:"startedAt"`
	ProcStart       string `json:"procStart"`
	Version         string `json:"version"`
	Kind            string `json:"kind"`
	Entrypoint      string `json:"entrypoint"`
	Name            string `json:"name"`
	NameSource      string `json:"nameSource"`
	Status          string `json:"status"`
	WaitingFor      string `json:"waitingFor"`
	Tmux            string `json:"tmux"`
	UpdatedAt       int64  `json:"updatedAt"`
	StatusUpdatedAt int64  `json:"statusUpdatedAt"`

	raw json.RawMessage
}

// readRecords reads every record in dir. Records that cannot be read are counted, not returned.
func readRecords(dir string) (recs []Record, unreadable int) {
	paths, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			unreadable++
			continue
		}
		var r Record
		if err := json.Unmarshal(b, &r); err != nil || r.PID <= 0 || r.SessionID == "" || r.Cwd == "" {
			unreadable++
			continue
		}
		r.raw = b
		recs = append(recs, r)
	}
	return recs, unreadable
}

// processAlive reports whether pid runs and, where the platform lets us
// check, is the same process that wrote the record (procStart is the start
// time from /proc/<pid>/stat on Linux). A record left by a crash fails this.
func processAlive(pid int, procStart string) bool {
	err := syscall.Kill(pid, 0)
	if err != nil && !errors.Is(err, syscall.EPERM) {
		return false
	}
	if runtime.GOOS != "linux" || procStart == "" {
		return true
	}
	got, ok := linuxStartTime(pid)
	return !ok || got == procStart
}

// linuxStartTime returns field 22 of /proc/<pid>/stat.
func linuxStartTime(pid int) (string, bool) {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return "", false
	}
	s := string(b)
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return "", false
	}
	fields := strings.Fields(s[i+1:])
	// fields[0] is field 3 (state), so field 22 is fields[19].
	if len(fields) < 20 {
		return "", false
	}
	return fields[19], true
}

// surfaceOf classifies where a session runs, the way Claude Code itself does.
func surfaceOf(r Record) string {
	switch r.Entrypoint {
	case "claude-desktop", "claude-desktop-3p", "local-agent", "local_agent":
		return "desktop"
	case "claude-vscode":
		return "vscode"
	}
	if r.Tmux != "" {
		return "tmux"
	}
	return "terminal"
}
