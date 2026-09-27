package web

import (
	"net/url"
	"testing"
)

func FuzzIntegrationURL(f *testing.F) {
	for _, seed := range []string{"https://swypik.com", "http://127.0.0.1:8091", "javascript:alert(1)", "https://user:pass@site.example", "https://site.example/%2Fpath", "https://[::1]", "\x00"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, base string) {
		got, err := integrationURL(base, "/movies")
		if err != nil {
			return
		}
		u, err := url.Parse(got)
		if err != nil {
			t.Fatalf("accepted unparseable URL %q", got)
		}
		if u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Host == "" {
			t.Fatalf("unsafe application URL %q", got)
		}
		if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
			t.Fatalf("unexpected scheme/host %q", got)
		}
	})
}
