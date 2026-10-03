// Package sourcefront contains syntax shared by every Swyp source family.
// Keeping the module/import preamble here is the first convergence point toward
// the Unified HIR: executable and declarative files must agree on namespace
// syntax before their declaration bodies are interpreted.
package sourcefront

import (
	"fmt"
	"strings"
	"text/scanner"
	"unicode"
)

const MaxUses = 256

type Preamble struct {
	Module string
	Uses   []string
}

type Error struct {
	Position scanner.Position
	Message  string
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%s: %s", e.Position, e.Message)
}

type token struct {
	text string
	pos  scanner.Position
}

// ParsePreamble accepts an optional `module a.b;` followed by zero or more
// `use x.y;` declarations. It returns a same-length source string whose
// preamble bytes are blanked (newlines preserved), so downstream parsers retain
// exact original line/column/offset locations without having to understand the
// preamble syntax themselves.
func ParsePreamble(filename, source string) (Preamble, string, error) {
	var s scanner.Scanner
	s.Init(strings.NewReader(source))
	s.Filename = filename
	s.Mode = scanner.ScanIdents | scanner.ScanComments | scanner.SkipComments
	var scanErr *Error
	s.Error = func(s *scanner.Scanner, message string) {
		if scanErr == nil {
			scanErr = &Error{Position: s.Position, Message: message}
		}
	}

	next := func() token {
		kind := s.Scan()
		if kind == scanner.EOF {
			return token{text: "<eof>", pos: s.Pos()}
		}
		return token{text: s.TokenText(), pos: s.Position}
	}

	current := next()
	preamble := Preamble{}
	seenUse := false
	end := 0
	uses := map[string]bool{}

	fail := func(t token, format string, args ...any) (Preamble, string, error) {
		return Preamble{}, "", &Error{Position: t.pos, Message: fmt.Sprintf(format, args...)}
	}
	advance := func() { current = next() }
	ident := func(kind string) (string, error) {
		if scanErr != nil {
			return "", scanErr
		}
		t := current
		if t.text == "<eof>" || !identifier(t.text) {
			return "", &Error{Position: t.pos, Message: fmt.Sprintf("expected identifier in %s path, got %q", kind, t.text)}
		}
		advance()
		return t.text, nil
	}
	path := func(kind string) (string, error) {
		first, err := ident(kind)
		if err != nil {
			return "", err
		}
		parts := []string{first}
		for current.text == "." {
			advance()
			part, err := ident(kind)
			if err != nil {
				return "", err
			}
			parts = append(parts, part)
		}
		return strings.Join(parts, "."), nil
	}

	for current.text == "module" || current.text == "use" {
		if scanErr != nil {
			return Preamble{}, "", scanErr
		}
		kindToken := current
		kind := current.text
		advance()
		if kind == "module" {
			if preamble.Module != "" {
				return fail(kindToken, "duplicate module declaration")
			}
			if seenUse {
				return fail(kindToken, "module declaration must precede use declarations")
			}
			name, err := path("module")
			if err != nil {
				return Preamble{}, "", err
			}
			preamble.Module = name
		} else {
			seenUse = true
			if len(preamble.Uses) >= MaxUses {
				return fail(kindToken, "use declaration limit exceeded (%d)", MaxUses)
			}
			name, err := path("use")
			if err != nil {
				return Preamble{}, "", err
			}
			if uses[name] {
				return fail(kindToken, "duplicate use declaration %q", name)
			}
			uses[name] = true
			preamble.Uses = append(preamble.Uses, name)
		}
		if current.text != ";" {
			if scanErr != nil {
				return Preamble{}, "", scanErr
			}
			return fail(current, "expected %q after %s declaration, got %q", ";", kind, current.text)
		}
		end = current.pos.Offset + len(current.text)
		advance()
	}
	if end == 0 {
		return preamble, source, nil
	}
	return preamble, blankPrefix(source, end), nil
}

// FirstBodyToken returns the first declaration token after the shared preamble
// without parsing the body. It is used only for deterministic frontend routing.
func FirstBodyToken(filename, source string) (string, error) {
	_, body, err := ParsePreamble(filename, source)
	if err != nil {
		return "", err
	}
	var s scanner.Scanner
	s.Init(strings.NewReader(body))
	s.Filename = filename
	s.Mode = scanner.ScanIdents | scanner.ScanComments | scanner.SkipComments
	var scanErr error
	s.Error = func(s *scanner.Scanner, message string) {
		if scanErr == nil {
			scanErr = &Error{Position: s.Position, Message: message}
		}
	}
	if kind := s.Scan(); kind != scanner.EOF {
		if scanErr != nil {
			return "", scanErr
		}
		return s.TokenText(), nil
	}
	if scanErr != nil {
		return "", scanErr
	}
	return "", nil
}

func identifier(text string) bool {
	if text == "" {
		return false
	}
	for i, r := range text {
		if r == '_' || unicode.IsLetter(r) || (i > 0 && unicode.IsDigit(r)) {
			continue
		}
		return false
	}
	return true
}

func blankPrefix(source string, end int) string {
	if end <= 0 {
		return source
	}
	if end > len(source) {
		end = len(source)
	}
	var b strings.Builder
	b.Grow(len(source))
	for i := 0; i < end; i++ {
		if source[i] == '\n' || source[i] == '\r' {
			b.WriteByte(source[i])
		} else {
			b.WriteByte(' ')
		}
	}
	b.WriteString(source[end:])
	return b.String()
}
