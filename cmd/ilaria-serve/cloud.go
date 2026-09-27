package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"net/http"
	"strings"
)

// cloudHandler protects an explicitly configured TLS endpoint. The inner
// inference API keeps its loopback contract and browser-origin restrictions.
func cloudHandler(next http.Handler, token string) (http.Handler, error) {
	if len(token) < 32 || strings.TrimSpace(token) != token {
		return nil, fmt.Errorf("ILARIA_API_TOKEN must contain at least 32 characters without surrounding whitespace")
	}
	expected := sha256.Sum256([]byte("Bearer " + token))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		actual := sha256.Sum256([]byte(r.Header.Get("Authorization")))
		if r.TLS == nil || subtle.ConstantTimeCompare(actual[:], expected[:]) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		forwarded := r.Clone(r.Context())
		forwarded.Host = "127.0.0.1"
		next.ServeHTTP(w, forwarded)
	}), nil
}
