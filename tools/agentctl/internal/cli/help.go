package cli

import (
	"fmt"
	"sort"
	"strings"
)

const exitCodesText = "0 ok (also for empty results), 1 runtime failure, 2 bad arguments, 3 not found / ambiguous id,\n  4 provider unavailable / unsupported, 5 a human has to act (user_action_required)"

// usageLine is the one-line synopsis of a command.
func usageLine(c *Command) string {
	parts := []string{"agentctl", c.Name()}
	for _, a := range c.Args {
		parts = append(parts, "<"+a.Name+">")
	}
	if c.Synopsis != "" {
		parts = append(parts, c.Synopsis)
	}
	for _, f := range c.Flags {
		if c.Synopsis != "" && strings.Contains(c.Synopsis, "--"+f.Name) {
			continue
		}
		if f.Value == "" {
			parts = append(parts, "[--"+f.Name+"]")
		} else {
			parts = append(parts, "[--"+f.Name+" "+f.Value+"]")
		}
	}
	return strings.Join(parts, " ")
}

// helpText renders the help of a node: the top level, a group, or a command.
func helpText(n *node, root *node) string {
	switch {
	case n == root:
		return topHelp(root)
	case n.cmd == nil:
		return groupHelp(n)
	default:
		return commandHelp(n.cmd)
	}
}

func topHelp(root *node) string {
	var b strings.Builder
	b.WriteString("agentctl - list and drive running Claude Code and Codex sessions\n\n")
	b.WriteString("Usage: agentctl [--json] [--provider claude|codex] <command> [args]\n\n")
	b.WriteString("Start with:\n  agentctl --json doctor\n  agentctl --json sessions list\n")
	byGroup := map[string][]*Command{}
	for _, c := range commands() {
		byGroup[c.Group] = append(byGroup[c.Group], c)
	}
	for _, g := range groupOrder {
		b.WriteString("\n" + g + "\n")
		for _, c := range byGroup[g] {
			fmt.Fprintf(&b, "  %s\n      %s\n", usageLine(c), c.Summary)
		}
	}
	b.WriteString("\nGlobal flags\n")
	b.WriteString("  --json                print JSON only on stdout (diagnostics go to stderr)\n")
	b.WriteString("  --provider P          claude or codex: limit id resolution and lists to one provider\n")
	b.WriteString("  -h, --help            help for any command, e.g. agentctl sessions send --help\n")
	b.WriteString("  --version             print the agentctl version\n")
	b.WriteString("\nExit codes: " + exitCodesText + "\n")
	names := make([]string, 0, len(aliases))
	for k := range aliases {
		names = append(names, k)
	}
	sort.Strings(names)
	parts := make([]string, len(names))
	for i, k := range names {
		parts[i] = k + " = " + strings.Join(aliases[k], " ")
	}
	b.WriteString("\nAliases: " + strings.Join(parts, ", ") + "\n")
	return b.String()
}

func groupHelp(n *node) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Usage: agentctl %s <command> [args]\n\nCommands:\n", strings.Join(n.path, " "))
	var leaves []*Command
	var walk func(*node)
	walk = func(x *node) {
		if x.cmd != nil {
			leaves = append(leaves, x.cmd)
		}
		for _, k := range x.childNames() {
			walk(x.children[k])
		}
	}
	walk(n)
	for _, c := range leaves {
		fmt.Fprintf(&b, "  %s\n      %s\n", usageLine(c), c.Summary)
	}
	fmt.Fprintf(&b, "\nRun 'agentctl %s <command> --help' for details.\n", strings.Join(n.path, " "))
	return b.String()
}

func commandHelp(c *Command) string {
	var b strings.Builder
	b.WriteString("Usage: " + usageLine(c) + "\n\n")
	b.WriteString(capitalize(c.Summary) + ".\n")
	if c.Description != "" {
		b.WriteString(c.Description + "\n")
	}
	if c.Write {
		b.WriteString("This is a live write.\n")
	}
	if len(c.Args) > 0 {
		b.WriteString("\nArguments:\n")
		for _, a := range c.Args {
			fmt.Fprintf(&b, "  %-20s %s\n", "<"+a.Name+">", a.Help)
		}
	}
	b.WriteString("\nFlags:\n")
	for _, f := range c.Flags {
		left := "--" + f.Name
		if f.Value != "" {
			left += " " + f.Value
		}
		fmt.Fprintf(&b, "  %-20s %s\n", left, f.Help)
	}
	fmt.Fprintf(&b, "  %-20s %s\n", "--json", "print JSON only on stdout")
	fmt.Fprintf(&b, "  %-20s %s\n", "--provider P", "claude or codex")
	if len(c.Examples) > 0 {
		b.WriteString("\nExamples:\n")
		for _, e := range c.Examples {
			b.WriteString("  " + e + "\n")
		}
	}
	if c.Output != "" {
		b.WriteString("\nOutput (--json):\n  " + c.Output + "\n")
	}
	b.WriteString("\nExit codes: " + exitCodesText + "\n")
	return b.String()
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// helpJSON is `agentctl --json help <command>`.
type helpJSON struct {
	Command     string     `json:"command"`
	Usage       string     `json:"usage"`
	Description string     `json:"description"`
	Args        []argJSON  `json:"args"`
	Flags       []flagJSON `json:"flags"`
	Examples    []string   `json:"examples"`
	Output      string     `json:"output"`
	ExitCodes   string     `json:"exitCodes"`
	IsWrite     bool       `json:"isWrite"`
}

type argJSON struct {
	Name string `json:"name"`
	Help string `json:"help"`
}

type flagJSON struct {
	Name  string   `json:"name"`
	Value string   `json:"value,omitempty"`
	Help  string   `json:"help"`
	Enum  []string `json:"enum,omitempty"`
}

func helpAsJSON(n *node) any {
	if n.cmd == nil {
		var out []helpJSON
		var walk func(*node)
		walk = func(x *node) {
			if x.cmd != nil {
				out = append(out, commandJSON(x.cmd))
			}
			for _, k := range x.childNames() {
				walk(x.children[k])
			}
		}
		walk(n)
		return map[string]any{"commands": out}
	}
	return commandJSON(n.cmd)
}

func commandJSON(c *Command) helpJSON {
	h := helpJSON{
		Command: c.Name(), Usage: usageLine(c), Description: strings.TrimSpace(capitalize(c.Summary) + ". " + c.Description),
		Examples: c.Examples, Output: c.Output, ExitCodes: exitCodesText, IsWrite: c.Write,
		Args: []argJSON{}, Flags: []flagJSON{},
	}
	for _, a := range c.Args {
		h.Args = append(h.Args, argJSON{a.Name, a.Help})
	}
	for _, f := range c.Flags {
		h.Flags = append(h.Flags, flagJSON{f.Name, f.Value, f.Help, f.Enum})
	}
	return h
}
