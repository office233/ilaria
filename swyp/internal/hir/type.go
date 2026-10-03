package hir

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ParseTypeRef parses the canonical HIR type grammar. The richer compound
// types are language/HIR contracts only; a backend may still reject a type
// until its layout/ownership semantics are implemented there.
func ParseTypeRef(text string) (TypeRef, error) {
	p := typeParser{text: text}
	t, err := p.parse(0)
	if err != nil {
		return TypeRef{}, err
	}
	p.skipSpace()
	if p.at != len(p.text) {
		return TypeRef{}, fmt.Errorf("unexpected trailing type syntax %q", p.text[p.at:])
	}
	if err := ValidateTypeRef(t); err != nil {
		return TypeRef{}, err
	}
	return t, nil
}

func (t TypeRef) String() string {
	if len(t.Args) == 0 {
		return t.Name
	}
	parts := make([]string, 0, len(t.Args)+1)
	for _, arg := range t.Args {
		parts = append(parts, arg.String())
	}
	if t.Name == "array" && t.Length != nil {
		return "array<" + parts[0] + "," + strconv.FormatUint(*t.Length, 10) + ">"
	}
	return t.Name + "<" + strings.Join(parts, ",") + ">"
}

func ValidateTypeRef(t TypeRef) error { return validateType(t, 0) }

type typeParser struct {
	text string
	at   int
}

func (p *typeParser) parse(depth int) (TypeRef, error) {
	if depth > 32 {
		return TypeRef{}, fmt.Errorf("type nesting exceeds 32")
	}
	p.skipSpace()
	name, err := p.path()
	if err != nil {
		return TypeRef{}, err
	}
	t := TypeRef{Name: name}
	p.skipSpace()
	if !p.take('<') {
		return t, nil
	}
	if name == "array" {
		elem, err := p.parse(depth + 1)
		if err != nil {
			return TypeRef{}, err
		}
		p.skipSpace()
		if !p.take(',') {
			return TypeRef{}, fmt.Errorf("array type requires element type and length")
		}
		p.skipSpace()
		start := p.at
		for p.at < len(p.text) && (unicode.IsDigit(rune(p.text[p.at])) || p.text[p.at] == '_') {
			p.at++
		}
		if start == p.at {
			return TypeRef{}, fmt.Errorf("array type requires an unsigned decimal length")
		}
		lengthText := strings.ReplaceAll(p.text[start:p.at], "_", "")
		length, err := strconv.ParseUint(lengthText, 10, 64)
		if err != nil {
			return TypeRef{}, fmt.Errorf("invalid array length %q", p.text[start:p.at])
		}
		p.skipSpace()
		if !p.take('>') {
			return TypeRef{}, fmt.Errorf("array type requires closing >")
		}
		t.Args = []TypeRef{elem}
		t.Length = &length
		return t, nil
	}
	for {
		arg, err := p.parse(depth + 1)
		if err != nil {
			return TypeRef{}, err
		}
		t.Args = append(t.Args, arg)
		p.skipSpace()
		if p.take('>') {
			break
		}
		if !p.take(',') {
			return TypeRef{}, fmt.Errorf("type %s requires ',' or '>'", name)
		}
	}
	return t, nil
}

func (p *typeParser) path() (string, error) {
	parts := []string{}
	for {
		p.skipSpace()
		start := p.at
		for p.at < len(p.text) {
			r, size := utf8.DecodeRuneInString(p.text[p.at:])
			if r == utf8.RuneError && size == 1 {
				return "", fmt.Errorf("invalid UTF-8 in type name at byte %d", p.at)
			}
			if r == '_' || unicode.IsLetter(r) || (p.at > start && unicode.IsDigit(r)) {
				p.at += size
				continue
			}
			break
		}
		if start == p.at {
			return "", fmt.Errorf("expected type identifier at byte %d", p.at)
		}
		parts = append(parts, p.text[start:p.at])
		p.skipSpace()
		if !p.take('.') {
			break
		}
	}
	return strings.Join(parts, "."), nil
}

func (p *typeParser) skipSpace() {
	for p.at < len(p.text) {
		r, size := utf8.DecodeRuneInString(p.text[p.at:])
		if !unicode.IsSpace(r) {
			break
		}
		p.at += size
	}
}

func (p *typeParser) take(ch byte) bool {
	if p.at < len(p.text) && p.text[p.at] == ch {
		p.at++
		return true
	}
	return false
}
