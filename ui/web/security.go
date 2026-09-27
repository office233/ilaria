package web

import (
	"encoding/binary"
	"math"
	"net"
	"net/http"
	"path/filepath"
	"strings"
)

func withinRoot(path, root string) bool {
	if root == "" {
		return false
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return false
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return false
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(resolved, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func (s *Server) protect(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		if host != s.cfg.BindHost && host != "127.0.0.1" && host != "localhost" && host != "::1" {
			http.Error(w, "Forbidden host", http.StatusForbidden)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if !s.setCORS(w, r) {
				return
			}
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" && r.Header.Get("Origin") == "" {
				http.Error(w, "Cross-site API access denied", http.StatusForbidden)
				return
			}
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			method := http.MethodGet
			if r.URL.Path == "/api/omnibar" || r.URL.Path == "/api/apps/launch" {
				method = http.MethodPost
			}
			if r.Method != method {
				w.Header().Set("Allow", method)
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeChime(w http.ResponseWriter, samples []float32, sampleRate int) {
	w.Header().Set("Content-Type", "audio/wav")
	header := make([]byte, 44)
	copy(header, "RIFF")
	binary.LittleEndian.PutUint32(header[4:], uint32(36+len(samples)*2))
	copy(header[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(header[16:], 16)
	binary.LittleEndian.PutUint16(header[20:], 1)
	binary.LittleEndian.PutUint16(header[22:], 1)
	binary.LittleEndian.PutUint32(header[24:], uint32(sampleRate))
	binary.LittleEndian.PutUint32(header[28:], uint32(sampleRate*2))
	binary.LittleEndian.PutUint16(header[32:], 2)
	binary.LittleEndian.PutUint16(header[34:], 16)
	copy(header[36:], "data")
	binary.LittleEndian.PutUint32(header[40:], uint32(len(samples)*2))
	pcm := make([]byte, len(samples)*2)
	for i, sample := range samples {
		binary.LittleEndian.PutUint16(pcm[i*2:], uint16(int16(math.Max(-1, math.Min(1, float64(sample)))*32767)))
	}
	_, _ = w.Write(append(header, pcm...))
}
