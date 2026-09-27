//go:build !windows

package claude

import (
	"errors"
	"runtime"
	"syscall"
)

// canTerminate says whether Stop may end a terminal session's process.
const canTerminate = true

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

// terminate asks the process to end (SIGTERM), as closing the terminal would.
func terminate(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }
