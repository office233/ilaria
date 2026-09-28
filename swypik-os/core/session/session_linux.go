//go:build linux && amd64

package session

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"swypik-os/core/agent"
	"swypik-os/core/network"
	"syscall"
	"time"
)

type Status struct {
	OS      string         `json:"os"`
	UID     int            `json:"uid"`
	Network network.Status `json:"network"`
	Indexed int            `json:"indexed"`
	Run     *agent.Run     `json:"run"`
}
type Client struct{ http *http.Client }

func NewClient(socket string) *Client {
	return &Client{http: &http.Client{Timeout: 135 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}}}
}
func (c *Client) Request(ctx context.Context, path string, body interface{}, target interface{}) error {
	method := "GET"
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
		method = "POST"
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://swypik"+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("native service unavailable")
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 256*1024+1))
	if err != nil {
		return err
	}
	if len(b) > 256*1024 {
		return fmt.Errorf("IPC response too large")
	}
	if res.StatusCode != 200 {
		return fmt.Errorf("%s", strings.TrimSpace(string(b)))
	}
	if target == nil {
		return nil
	}
	return json.Unmarshal(b, target)
}

type key struct {
	code   uint16
	shift  bool
	repeat bool // kernel auto-repeat; never accepted as consent
}

func readKeys(ctx context.Context, out chan<- key) {
	paths, _ := filepath.Glob("/dev/input/event*")
	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		go func(f *os.File) {
			defer f.Close()
			var data [24]byte
			shift := false
			for {
				if _, err := io.ReadFull(f, data[:]); err != nil {
					return
				}
				kind, code, value := binary.LittleEndian.Uint16(data[16:18]), binary.LittleEndian.Uint16(data[18:20]), binary.LittleEndian.Uint32(data[20:24])
				if kind != 1 {
					continue
				}
				if code == 42 || code == 54 {
					shift = value != 0
					continue
				}
				if value != 1 && value != 2 {
					continue
				}
				select {
				case out <- key{code, shift, value == 2}:
				case <-ctx.Done():
					return
				}
			}
		}(f)
	}
}
func keyText(k key) string {
	rows := []struct {
		start          uint16
		plain, shifted string
	}{{2, "1234567890-=", "!@#$%^&*()_+"}, {16, "qwertyuiop[]", "QWERTYUIOP{}"}, {30, "asdfghjkl;'", "ASDFGHJKL:\""}, {44, "zxcvbnm,./", "ZXCVBNM<>?"}}
	if k.code == 57 {
		return " "
	}
	if k.code == 43 {
		if k.shift {
			return "|"
		}
		return "\\"
	}
	for _, row := range rows {
		i := int(k.code) - int(row.start)
		if i >= 0 && i < len(row.plain) {
			if k.shift {
				return row.shifted[i : i+1]
			}
			return row.plain[i : i+1]
		}
	}
	return ""
}

type update struct {
	status    *Status
	output    string
	err       error
	operation bool
}

func Run(ctx context.Context, socket, fbPath string) error {
	fb, err := OpenFramebuffer(fbPath)
	if err != nil {
		return err
	}
	defer fb.Close()
	if tty, err := os.OpenFile("/dev/tty0", os.O_RDWR, 0); err == nil {
		_, _, _ = syscall.Syscall(syscall.SYS_IOCTL, tty.Fd(), 0x4B3A, 1)
		defer func() { _, _, _ = syscall.Syscall(syscall.SYS_IOCTL, tty.Fd(), 0x4B3A, 0); tty.Close() }()
	}
	client := NewClient(socket)
	keys := make(chan key, 64)
	readKeys(ctx, keys)
	updates := make(chan update, 8)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	poll := func() {
		go func() {
			ticker := time.NewTicker(time.Second)
			defer ticker.Stop()
			for {
				var status Status
				probe, cancel := context.WithTimeout(ctx, 2*time.Second)
				err := client.Request(probe, "/v1/status", nil, &status)
				cancel()
				select {
				case updates <- update{status: &status, err: err}:
				case <-ctx.Done():
					return
				}
				select {
				case <-ticker.C:
				case <-ctx.Done():
					return
				}
			}
		}()
	}
	poll()
	page, input, output, pending := "HOME", "", "", ""
	// pendingValue freezes exactly what the confirmation text displayed. Later
	// edits to input can never change what F8 sends.
	pendingValue := ""
	var state Status
	busy := false
	resumeID := ""
	// An approval must be rendered for a minimum time before F8 can accept it,
	// so a key pressed for a previous prompt cannot approve an unseen tool.
	shownApproval, shownAt := "", time.Time{}
	const approvalDwell = 500 * time.Millisecond
	clearPending := func() {
		pending, pendingValue, resumeID = "", "", ""
	}
	request := func(path string, body interface{}) {
		busy = true
		go func() {
			var raw json.RawMessage
			err := client.Request(ctx, path, body, &raw)
			var formatted bytes.Buffer
			if err == nil {
				_ = json.Indent(&formatted, raw, "", "  ")
			}
			select {
			case updates <- update{output: formatted.String(), err: err, operation: true}:
			case <-ctx.Done():
			}
		}()
	}
	draw := func() {
		im := fb.Image
		w, h := im.Rect.Dx(), im.Rect.Dy()
		rect(im, 0, 0, w, h, background)
		rect(im, 0, 0, w, 84, panel)
		text(im, 28, 24, 4, "SWYPIK OS", white)
		text(im, w-312, 28, 2, "NATIVE / PRE-ALPHA", accent)
		labels := []string{"HOME", "SEARCH", "AGENT", "NETWORK", "FILES"}
		for i, label := range labels {
			c := panel
			if page == label {
				c = accent
			}
			rect(im, 24, 112+i*62, 178, 46, c)
			fg := white
			if page == label {
				fg = background
			}
			text(im, 38, 128+i*62, 2, fmt.Sprintf("F%d %s", i+1, label), fg)
		}
		x, top, width := 230, 116, w-258
		text(im, x, top, 3, page, white)
		y := top + 46
		lines := (h - y - 142) / 24
		body := ""
		switch page {
		case "HOME":
			body = "BOOTED LINUX. NO WINDOWS HOST.\nNO ELECTRON. NO BROWSER RUNTIME.\n\nF2: OWN SEARCH INDEX + CRAWLER\nF3: ILARIA AGENT + TOOL APPROVALS\nF4: NETWORK ADAPTERS AND ADDRESSES\nF5: WORKSPACE FILES\n\nLIVE RAM SESSION: CHANGES ARE TEMPORARY.\nNO MODEL WEIGHTS ARE BUNDLED.\nCONFIGURE ILARIA TO ENABLE AI."
		case "NETWORK":
			body = fmt.Sprintf("DRIVERS: %s\nINTERNET: %s\n", state.Network.DriverOwner, state.Network.Internet)
			for _, n := range state.Network.Interfaces {
				body += fmt.Sprintf("\n%s UP=%v\n%s\n", n.Name, n.Up, strings.Join(n.Addresses, ", "))
			}
		case "SEARCH":
			body = fmt.Sprintf("%d DOCUMENTS IN YOUR OWN INDEX\nTYPE WORDS AND ENTER TO SEARCH.\nTYPE CRAWL HTTPS://SITE/ TO INDEX A SITE.\n\n", state.Indexed) + output
		case "FILES":
			body = "WORKSPACE METADATA ONLY\n\n" + output
		case "AGENT":
			body = "GOAL AND APPROVED RESULTS GO TO ILARIA.\nNO ROOT, SHELL OR AUTOMATIC FILE WRITES.\nTYPE A GOAL AND PRESS ENTER.\n\n"
			if state.Run != nil {
				r := state.Run
				body += "STATUS: " + r.Status + "\n"
				if r.Status == "interrupted" && r.Recovery == "replan" {
					body += "F6 REQUEST RESUME / F9 CANCEL\n"
				}
				if r.Approval != nil {
					body += "TOOL: " + r.Approval.Tool + "\nARGS: " + string(r.Approval.Arguments) + "\nF8 APPROVE ONCE / F9 DENY\n"
				}
				body += r.Summary + r.Error + "\n"
				for _, e := range r.Events {
					body += e.Kind + ": " + e.Message + "\n"
				}
			}
			if output != "" {
				body += "\n" + output
			}
		}
		if page == "AGENT" && state.Run != nil && state.Run.Approval != nil {
			if shownApproval != state.Run.Approval.ID {
				shownApproval, shownAt = state.Run.Approval.ID, time.Now()
			}
		} else {
			shownApproval = ""
		}
		paragraph(im, x, y, width, lines, body, muted)
		if pending != "" {
			rect(im, x, h-206, width, 114, panel)
			paragraph(im, x+12, h-193, width-24, 4, "CONFIRM: "+pending+"\nF8 CONFIRM / F9 CANCEL", warning)
		}
		rect(im, x, h-82, width, 42, panel)
		shown := input
		if len(shown) > width/12-4 {
			shown = shown[len(shown)-(width/12-4):]
		}
		text(im, x+12, h-68, 2, "> "+shown+"_", white)
		footer := fmt.Sprintf("UID %d | IPC UNIX | KERNEL %s | %d INDEXED", state.UID, state.OS, state.Indexed)
		if busy {
			footer += " | WORKING"
		}
		text(im, 24, h-22, 1, footer, accent)
		fb.Present()
	}
	draw()
	fmt.Printf("SWYPIK_NATIVE_READY uid=%d framebuffer=%dx%d\n", os.Getuid(), fb.Image.Rect.Dx(), fb.Image.Rect.Dy())
	for {
		select {
		case <-ctx.Done():
			return nil
		case u := <-updates:
			if u.operation {
				busy = false
				if u.err != nil {
					output = u.err.Error()
				} else {
					output = u.output
				}
			} else if u.err == nil {
				state = *u.status
			}
			draw()
		case k := <-keys:
			if k.code >= 59 && k.code <= 63 {
				page = []string{"HOME", "SEARCH", "AGENT", "NETWORK", "FILES"}[k.code-59]
				input = ""
				output = ""
				clearPending()
				if page == "FILES" && !busy {
					request("/v1/files", nil)
				}
				draw()
				continue
			}
			switch k.code {
			case 1:
				clearPending()
				input = ""
			case 14:
				if pending == "" && len(input) > 0 {
					input = input[:len(input)-1]
				}
			case 28:
				if pending != "" || busy || strings.TrimSpace(input) == "" {
					break
				}
				if page == "SEARCH" {
					if strings.HasPrefix(input, "crawl ") {
						pendingValue = strings.TrimSpace(input[len("crawl "):])
						pending = "CRAWL VISITS THE SITE, UP TO 8 PAGES: " + pendingValue
					} else {
						request("/v1/search?q="+url.QueryEscape(input), nil)
						input = ""
					}
				}
				if page == "AGENT" {
					pendingValue = input
					pending = "SEND GOAL AND APPROVED METADATA TO CONFIGURED ILARIA: " + pendingValue
				}
			case 64:
				if !busy && page == "AGENT" && state.Run != nil && state.Run.Status == "interrupted" && state.Run.Recovery == "replan" {
					resumeID = state.Run.ID
					pending = "RESUME SENDS RECORDED GOAL AND EVIDENCE TO ILARIA; NEW TOOL APPROVALS REQUIRED."
				}
			case 66:
				if busy || k.repeat {
					break
				}
				if pending != "" {
					if page == "SEARCH" {
						request("/v1/crawl", map[string]interface{}{"url": pendingValue, "pages": 8, "consent": true})
					}
					if page == "AGENT" {
						if resumeID != "" {
							request("/v1/resume", map[string]interface{}{"run_id": resumeID, "consent": true})
						} else {
							request("/v1/run", map[string]interface{}{"goal": pendingValue, "consent": true})
						}
					}
					clearPending()
					input = ""
				} else if page == "AGENT" && state.Run != nil && state.Run.Approval != nil &&
					state.Run.Approval.ID == shownApproval && time.Since(shownAt) >= approvalDwell {
					request("/v1/decision", map[string]interface{}{"run_id": state.Run.ID, "approval_id": state.Run.Approval.ID, "approve": true})
				}
			case 67:
				if k.repeat {
					break
				}
				if pending != "" {
					clearPending()
					input = ""
				} else if page == "AGENT" && state.Run != nil && !busy {
					request("/v1/cancel", map[string]string{"run_id": state.Run.ID})
				}
			default:
				if pending == "" && len(input) < 1024 {
					input += keyText(k)
				}
			}
			draw()
		}
	}
}
