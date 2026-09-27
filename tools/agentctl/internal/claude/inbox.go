package claude

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// store is the shared directory ~/.agentctl/claude.
type store struct {
	base string
}

func (s store) dir(id string) string          { return filepath.Join(s.base, id) }
func (s store) inbox(id string) string        { return filepath.Join(s.dir(id), "inbox") }
func (s store) acks(id string) string         { return filepath.Join(s.dir(id), "acks") }
func (s store) modPath(id string) string      { return filepath.Join(s.dir(id), "mod.json") }
func (s store) metaPath(id string) string     { return filepath.Join(s.dir(id), "meta.json") }
func (s store) ackPath(id, msg string) string { return filepath.Join(s.acks(id), msg+".json") }

func readJSON(path string, v any) (bool, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(b, v)
}

// writeAtomic writes path through a temporary file and a rename, so the Mod
// never reads half a file.
func writeAtomic(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s store) mod(id string) (*ModFile, bool) {
	var m ModFile
	ok, err := readJSON(s.modPath(id), &m)
	if !ok || err != nil || m.V != ProtocolVersion {
		return nil, false
	}
	return &m, true
}

func (s store) meta(id string) MetaFile {
	var m MetaFile
	if ok, err := readJSON(s.metaPath(id), &m); !ok || err != nil || m.V != ProtocolVersion {
		return MetaFile{V: ProtocolVersion}
	}
	return m
}

func (s store) writeMeta(id string, m MetaFile) error {
	m.V = ProtocolVersion
	return writeAtomic(s.metaPath(id), m)
}

// newMessageID is sortable by time: <epoch ms>-<random>.
func newMessageID(nowMs int64) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%013d-%s", nowMs, hex.EncodeToString(b[:]))
}

func (s store) post(id string, m InboxMessage) error {
	m.V = ProtocolVersion
	return writeAtomic(filepath.Join(s.inbox(id), m.ID+".json"), m)
}

func (s store) ack(id, msg string) (*Ack, bool) {
	var a Ack
	ok, err := readJSON(s.ackPath(id, msg), &a)
	if !ok || err != nil || a.V != ProtocolVersion {
		return nil, false
	}
	return &a, true
}

// cleanup removes messages whose ack is final. Queued ones stay until the Mod
// rewrites their ack.
func (s store) cleanup(id string) {
	paths, _ := filepath.Glob(filepath.Join(s.acks(id), "*.json"))
	for _, p := range paths {
		msg := strings.TrimSuffix(filepath.Base(p), ".json")
		if a, ok := s.ack(id, msg); ok && a.Status != AckQueued {
			_ = os.Remove(filepath.Join(s.inbox(id), msg+".json"))
			_ = os.Remove(p)
		}
	}
}
