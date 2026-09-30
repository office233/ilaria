package search

import (
	"io"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// page is the indexable content of one HTML document.
type page struct {
	Title    string
	Text     string
	Links    []string // absolute, resolved against <base href> when present
	NoIndex  bool
	NoFollow bool
}

const maxLinksPerPage = 256

// Content inside these elements is never indexed.
var skipped = map[atom.Atom]bool{atom.Script: true, atom.Style: true, atom.Noscript: true, atom.Template: true, atom.Svg: true, atom.Iframe: true, atom.Object: true, atom.Head: true, atom.Select: true}

// Elements that separate words even without whitespace in the markup.
var blocks = map[atom.Atom]bool{atom.P: true, atom.Div: true, atom.Br: true, atom.Li: true, atom.Td: true, atom.Th: true, atom.Tr: true, atom.H1: true, atom.H2: true, atom.H3: true, atom.H4: true, atom.H5: true, atom.H6: true, atom.Section: true, atom.Article: true, atom.Header: true, atom.Footer: true, atom.Nav: true, atom.Blockquote: true, atom.Pre: true, atom.Hr: true, atom.Title: true, atom.Option: true, atom.Dt: true, atom.Dd: true}

func robotsDirectives(content string) (noindex, nofollow bool) {
	for _, d := range strings.Split(strings.ToLower(content), ",") {
		switch strings.TrimSpace(d) {
		case "noindex":
			noindex = true
		case "nofollow":
			nofollow = true
		case "none":
			noindex, nofollow = true, true
		}
	}
	return
}

func extract(r io.Reader, pageURL *url.URL) page {
	return extractLimit(r, pageURL, MaxTextBytes)
}

// extractLimit is the resource-aware HTML extractor. Input must already be
// decoded to UTF-8.
func extractLimit(r io.Reader, pageURL *url.URL, textLimit int) page {
	if textLimit <= 0 || textLimit > MaxTextBytes {
		textLimit = MaxTextBytes
	}
	z := html.NewTokenizer(io.LimitReader(r, 4<<20))
	var p page
	var text, title strings.Builder
	base := pageURL
	baseSet := false
	depth := map[atom.Atom]int{}
	inTitle := false
	skipping := func() bool {
		for a := range skipped {
			if depth[a] > 0 {
				return true
			}
		}
		return false
	}
	for text.Len() < 4*textLimit {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			goto done
		case html.TextToken:
			s := string(z.Text())
			if inTitle {
				title.WriteString(s)
			} else if !skipping() {
				text.WriteString(s)
			}
		case html.StartTagToken, html.SelfClosingTagToken, html.EndTagToken:
			name, hasAttr := z.TagName()
			a := atom.Lookup(name)
			attrs := map[string]string{}
			for hasAttr {
				var k, v []byte
				k, v, hasAttr = z.TagAttr()
				attrs[string(k)] = string(v)
			}
			if blocks[a] {
				text.WriteByte(' ')
			}
			if tt == html.EndTagToken {
				if a == atom.Title {
					inTitle = false
				}
				if skipped[a] && depth[a] > 0 {
					depth[a]--
				}
				continue
			}
			switch a {
			case atom.Title:
				inTitle = tt == html.StartTagToken && title.Len() == 0
			case atom.Base:
				if href := attrs["href"]; href != "" && !baseSet {
					if u, err := pageURL.Parse(href); err == nil {
						base, baseSet = u, true
					}
				}
			case atom.Meta:
				if n := strings.ToLower(attrs["name"]); n == "robots" || n == "swypikbot" {
					ni, nf := robotsDirectives(attrs["content"])
					p.NoIndex = p.NoIndex || ni
					p.NoFollow = p.NoFollow || nf
				}
			case atom.A:
				href := strings.TrimSpace(attrs["href"])
				if href == "" || len(p.Links) >= maxLinksPerPage || strings.Contains(strings.ToLower(attrs["rel"]), "nofollow") {
					break
				}
				if u, err := base.Parse(href); err == nil {
					p.Links = append(p.Links, u.String())
				}
			}
			if skipped[a] && tt == html.StartTagToken {
				depth[a]++
			}
			// </head> is optional in HTML; <body> always ends the head.
			if a == atom.Body {
				depth[atom.Head] = 0
			}
		}
	}
done:
	p.Title = compactStringText(title.String(), 512)
	p.Text = compactStringText(text.String(), textLimit)
	return p
}

func compactStringText(s string, limit int) string {
	if limit <= 0 || s == "" {
		return ""
	}
	var b strings.Builder
	if len(s) < limit {
		b.Grow(len(s))
	} else {
		b.Grow(limit)
	}
	pendingSpace := false
	started := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if started {
				pendingSpace = true
			}
			continue
		}
		needed := utf8.RuneLen(r)
		if pendingSpace {
			needed++
		}
		if b.Len()+needed > limit {
			break
		}
		if pendingSpace {
			b.WriteByte(' ')
		}
		pendingSpace = false
		b.WriteRune(r)
		started = true
	}
	return b.String()
}
