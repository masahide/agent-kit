// Command agentctl lists and drives running Claude Code and Codex sessions.
package main

import (
	"os"

	"github.com/masahide/agent-kit/tools/agentctl/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}
