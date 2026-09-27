package cli

import (
	"sort"
	"strconv"
	"strings"

	"github.com/masahide/agent-kit/tools/agentctl/internal/session"
)

// Input is a parsed command line.
type Input struct {
	Args  map[string]string
	Flags map[string]string // string and int flags
	Bools map[string]bool
	Rest  []string // positionals of `help`
	// Provider is the global --provider, if given.
	Provider session.Provider
}

// Globals are the flags every command accepts.
type Globals struct {
	JSON     bool
	Provider session.Provider
	Help     bool
}

// node is one level of the command tree ("sessions", "raw claude", ...).
type node struct {
	name     string
	path     []string
	children map[string]*node
	cmd      *Command
}

func buildTree(cmds []*Command) *node {
	root := &node{children: map[string]*node{}}
	for _, c := range cmds {
		n := root
		for i, p := range c.Path {
			child, ok := n.children[p]
			if !ok {
				child = &node{name: p, path: c.Path[:i+1], children: map[string]*node{}}
				n.children[p] = child
			}
			n = child
		}
		n.cmd = c
	}
	return root
}

func (n *node) childNames() []string {
	names := make([]string, 0, len(n.children))
	for k := range n.children {
		names = append(names, k)
	}
	sort.Strings(names)
	return names
}

// parsed is the result of parse: either a command to run, or help to show.
type parsed struct {
	globals Globals
	node    *node // the command or group that was reached
	input   *Input
}

// usageError is an argument error: it carries the node whose help to print.
type usageError struct {
	err  *session.Error
	node *node
}

func (u *usageError) Error() string { return u.err.Message }

func invalid(n *node, format string, args ...any) *usageError {
	return &usageError{err: session.Errf(session.CodeInvalidArgument, format, args...), node: n}
}

// splitGlobals takes the global flags out of args, wherever they appear.
func splitGlobals(args []string, root *node) (Globals, []string, *usageError) {
	var g Globals
	rest := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--json":
			g.JSON = true
		case a == "-h" || a == "--help":
			g.Help = true
		case a == "--provider" || strings.HasPrefix(a, "--provider="):
			v, ok := strings.CutPrefix(a, "--provider=")
			if !ok {
				if i+1 >= len(args) {
					return g, nil, invalid(root, "flag --provider needs a value (claude or codex)")
				}
				i++
				v = args[i]
			}
			if v != string(session.Claude) && v != string(session.Codex) {
				u := invalid(root, "invalid value %q for --provider (allowed: claude, codex)", v)
				u.err.Suggestions = providerEnum
				return g, nil, u
			}
			g.Provider = session.Provider(v)
		default:
			rest = append(rest, a)
		}
	}
	return g, rest, nil
}

// parse turns the command line into a command and its input.
func parse(args []string, root *node) (*parsed, *usageError) {
	g, rest, uerr := splitGlobals(args, root)
	if uerr != nil {
		return nil, uerr
	}
	p := &parsed{globals: g, node: root}

	// `help a b` is the same as `a b --help`.
	if len(rest) > 0 && rest[0] == "help" {
		p.globals.Help = true
		rest = rest[1:]
	}
	if len(rest) > 0 {
		if target, ok := aliases[rest[0]]; ok {
			rest = append(append([]string{}, target...), rest[1:]...)
		}
	}

	n := root
	i := 0
	for n.cmd == nil {
		if i >= len(rest) {
			// A bare group shows its help.
			p.node = n
			p.globals.Help = true
			return p, nil
		}
		tok := rest[i]
		child, ok := n.children[tok]
		if !ok {
			if strings.HasPrefix(tok, "-") {
				return nil, invalid(n, "unknown flag %s before a command", tok)
			}
			u := invalid(n, "unknown command %q", strings.TrimSpace(strings.Join(append(append([]string{}, n.path...), tok), " ")))
			for _, s := range closest(tok, n.childNames()) {
				u.err.Suggestions = append(u.err.Suggestions, strings.TrimSpace(strings.Join(append(append([]string{}, n.path...), s), " ")))
			}
			return nil, u
		}
		n = child
		i++
	}
	p.node = n
	if p.globals.Help {
		return p, nil
	}
	in, uerr := parseInput(n, rest[i:], p.globals)
	if uerr != nil {
		return nil, uerr
	}
	p.input = in
	return p, nil
}

func parseInput(n *node, toks []string, g Globals) (*Input, *usageError) {
	c := n.cmd
	in := &Input{Args: map[string]string{}, Flags: map[string]string{}, Bools: map[string]bool{}, Provider: g.Provider}
	flags := map[string]Flag{}
	names := []string{}
	for _, f := range c.Flags {
		flags[f.Name] = f
		names = append(names, "--"+f.Name)
	}
	var pos []string
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t == "--" {
			pos = append(pos, toks[i+1:]...)
			break
		}
		if !strings.HasPrefix(t, "--") || t == "-" {
			if strings.HasPrefix(t, "-") && t != "-" {
				return nil, invalid(n, "unknown flag %s", t)
			}
			pos = append(pos, t)
			continue
		}
		name, val, hasVal := strings.Cut(t[2:], "=")
		f, ok := flags[name]
		if !ok {
			u := invalid(n, "unknown flag --%s", name)
			u.err.Suggestions = closest("--"+name, names)
			return nil, u
		}
		if f.Value == "" {
			if hasVal {
				return nil, invalid(n, "flag --%s takes no value", name)
			}
			in.Bools[name] = true
			continue
		}
		if !hasVal {
			if i+1 >= len(toks) {
				return nil, invalid(n, "flag --%s needs a value (%s)", name, f.Value)
			}
			i++
			val = toks[i]
		}
		if f.Int {
			v, err := strconv.Atoi(val)
			if err != nil || v < 0 {
				return nil, invalid(n, "invalid value %q for --%s (a non-negative integer)", val, name)
			}
		}
		if len(f.Enum) > 0 && !contains(f.Enum, val) {
			u := invalid(n, "invalid value %q for --%s (allowed: %s)", val, name, strings.Join(f.Enum, ", "))
			u.err.Suggestions = f.Enum
			return nil, u
		}
		in.Flags[name] = val
	}
	if c.Name() == "help" {
		in.Rest = pos
		return in, nil
	}
	if len(pos) < len(c.Args) {
		missing := make([]string, 0)
		for _, a := range c.Args[len(pos):] {
			missing = append(missing, "<"+a.Name+">")
		}
		return nil, invalid(n, "missing argument %s", strings.Join(missing, " "))
	}
	if len(pos) > len(c.Args) {
		return nil, invalid(n, "unexpected argument %q", pos[len(c.Args)])
	}
	for i, a := range c.Args {
		in.Args[a.Name] = pos[i]
	}
	if c.Check != nil {
		if err := c.Check(in); err != nil {
			return nil, &usageError{err: err, node: n}
		}
	}
	return in, nil
}

func (in *Input) Int(name string, def int) int {
	v, ok := in.Flags[name]
	if !ok {
		return def
	}
	n, _ := strconv.Atoi(v)
	return n
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// closest returns the candidates within edit distance 2 of s, nearest first.
func closest(s string, candidates []string) []string {
	type scored struct {
		s string
		d int
	}
	var out []scored
	for _, c := range candidates {
		if d := distance(s, c); d <= 2 {
			out = append(out, scored{c, d})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].d < out[j].d })
	res := make([]string, len(out))
	for i, o := range out {
		res[i] = o.s
	}
	return res
}

// distance is the Levenshtein distance with adjacent transpositions counted as one edit.
func distance(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	d := make([][]int, len(ra)+1)
	for i := range d {
		d[i] = make([]int, len(rb)+1)
		d[i][0] = i
	}
	for j := range d[0] {
		d[0][j] = j
	}
	for i := 1; i <= len(ra); i++ {
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			d[i][j] = min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+cost)
			if i > 1 && j > 1 && ra[i-1] == rb[j-2] && ra[i-2] == rb[j-1] {
				d[i][j] = min(d[i][j], d[i-2][j-2]+1)
			}
		}
	}
	return d[len(ra)][len(rb)]
}

// Checks shared by several commands.

func checkList(in *Input) *session.Error {
	if in.Flags["cursor"] != "" && in.Provider == "" {
		return session.Errf(session.CodeInvalidArgument, "--cursor needs --provider (cursors are per provider)")
	}
	return nil
}

func checkCreate(in *Input) *session.Error {
	if p := in.Args["provider"]; !contains(providerEnum, p) {
		e := session.Errf(session.CodeInvalidArgument, "invalid provider %q (allowed: claude, codex)", p)
		e.Suggestions = closest(p, providerEnum)
		return e
	}
	if in.Flags["prompt"] != "" && in.Flags["prompt-file"] != "" {
		return session.Errf(session.CodeInvalidArgument, "use either --prompt or --prompt-file, not both")
	}
	return nil
}

func checkSend(in *Input) *session.Error {
	_, text := in.Flags["text"]
	_, file := in.Flags["text-file"]
	switch {
	case text && file:
		return session.Errf(session.CodeInvalidArgument, "use either --text or --text-file, not both")
	case !text && !file:
		return session.Errf(session.CodeInvalidArgument, "missing message: give --text TEXT or --text-file F")
	}
	return nil
}

func checkDelete(in *Input) *session.Error {
	if !in.Bools["yes"] {
		return session.Errf(session.CodeConfirmationRequired, "delete needs --yes; it removes the conversation for good").
			WithHint("ask the user, then run: agentctl sessions delete %s --yes", in.Args["id"])
	}
	return nil
}
