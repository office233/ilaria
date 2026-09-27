package web

import (
	"context"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func publicIP(ip net.IP) bool {
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsLinkLocalMulticast() && !sharedNetwork(ip)
}

// Resolve and validate at dial time, then connect to the validated IP to avoid DNS rebinding.
func proxyDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("no addresses for host")
	}
	for _, ip := range ips {
		if !publicIP(ip.IP) {
			return nil, fmt.Errorf("private network destination blocked")
		}
	}
	dialer := net.Dialer{Timeout: 5 * time.Second}
	var lastErr error
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func (s *Server) handleProxy(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	target := r.URL.Query().Get("url")
	if target == "" {
		target = s.cfg.DefaultURL
	}
	if !strings.Contains(target, "://") {
		target = "https://" + target
	}
	u, err := url.Parse(target)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		http.Error(w, "Invalid HTTP URL", http.StatusBadRequest)
		return
	}
	if !s.allowLocalProxy {
		ip := net.ParseIP(u.Hostname())
		if strings.EqualFold(u.Hostname(), "localhost") || (ip != nil && !publicIP(ip)) {
			http.Error(w, "Private network destination blocked", http.StatusForbidden)
			return
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	if !s.allowLocalProxy {
		transport.DialContext = proxyDial
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Timeout: 10 * time.Second, Transport: transport}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}
	req.Header.Set("User-Agent", "SwypikOS/2026")
	resp, err := client.Do(req)
	if err != nil {
		http.Error(w, "Unable to reach website", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	const limit = 10 * 1024 * 1024
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		http.Error(w, "Unable to read website", http.StatusBadGateway)
		return
	}
	if len(body) > limit {
		http.Error(w, "Website response exceeds 10 MB", http.StatusBadGateway)
		return
	}
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = http.DetectContentType(body)
	}
	w.Header().Set("Content-Type", contentType)
	if strings.Contains(strings.ToLower(contentType), "text/html") {
		page := string(body)
		base := `<base href="` + html.EscapeString(resp.Request.URL.String()) + `">`
		lower := strings.ToLower(page)
		if start := strings.Index(lower, "<head"); start >= 0 {
			if end := strings.Index(page[start:], ">"); end >= 0 {
				pos := start + end + 1
				page = page[:pos] + base + page[pos:]
			} else {
				page = base + page
			}
		} else {
			page = base + page
		}
		body = []byte(page)
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(body)
}

func sharedNetwork(ip net.IP) bool {
	_, subnet, _ := net.ParseCIDR("100.64.0.0/10")
	return subnet.Contains(ip)
}
