//go:build windows

package claude

import (
	"errors"
	"os"
)

// canTerminate is false on Windows: there is no SIGTERM, and TerminateProcess
// would end Claude Code without letting it save. Stop only interrupts the turn.
const canTerminate = false

// processAlive reports whether pid runs. os.FindProcess opens the process on
// Windows and fails when it is gone. procStart is not checked on Windows.
func processAlive(pid int, _ string) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	_ = p.Release()
	return true
}

func terminate(pid int) error { return errors.New("not supported on Windows") }
