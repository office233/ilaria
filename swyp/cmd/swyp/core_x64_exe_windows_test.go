//go:build windows && amd64

package main

import (
	"bytes"
	"debug/pe"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"swyp-lang/internal/coreir"
)

func TestCoreX64ExeRunsWithoutExternalLinker(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "answer.swyp")
	exePath := filepath.Join(dir, "answer.exe")
	if err := os.WriteFile(source, []byte("fn answer()->i64{return 42;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "answer", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exePath)
	err := cmd.Run()
	if cmd.ProcessState == nil {
		t.Fatalf("process did not start: %v", err)
	}
	if got := cmd.ProcessState.ExitCode(); got != 42 {
		t.Fatalf("exit code=%d err=%v want=42", got, err)
	}
}

func TestCoreX64ExeBoolResultBecomesExitCode(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "truth.swyp")
	exePath := filepath.Join(dir, "truth.exe")
	if err := os.WriteFile(source, []byte("fn truth()->bool{return true;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "truth", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exePath)
	err := cmd.Run()
	if cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != 1 {
		t.Fatalf("state=%v err=%v", cmd.ProcessState, err)
	}
}

func TestCoreX64ExeParsesIntegerArguments(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "add.swyp")
	exePath := filepath.Join(dir, "add.exe")
	if err := os.WriteFile(source, []byte("fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "add", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath, "20", "22"); got != 42 {
		t.Fatalf("exit code=%d want=42", got)
	}
}

func TestCoreX64ExeParsesSignedAndUnsignedArguments(t *testing.T) {
	dir := t.TempDir()
	absSource := filepath.Join(dir, "abs.swyp")
	absExe := filepath.Join(dir, "abs.exe")
	if err := os.WriteFile(absSource, []byte("fn abs(x:i64)->i64{if x<0{return -x;}return x;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "abs", "-o", absExe, absSource}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, absExe, "-7"); got != 7 {
		t.Fatalf("signed exit code=%d want=7", got)
	}

	uSource := filepath.Join(dir, "u.swyp")
	uExe := filepath.Join(dir, "u.exe")
	if err := os.WriteFile(uSource, []byte("fn idu(x:u64)->u64{return x;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := coreX64ExeCommand([]string{"-entry", "idu", "-o", uExe, uSource}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, uExe, "42"); got != 42 {
		t.Fatalf("unsigned exit code=%d want=42", got)
	}
}

func TestCoreX64ExeParsesIntegerBoundaryValues(t *testing.T) {
	dir := t.TempDir()
	var out bytes.Buffer

	iSource := filepath.Join(dir, "eqi.swyp")
	iExe := filepath.Join(dir, "eqi.exe")
	if err := os.WriteFile(iSource, []byte("fn eqi(x:i64,y:i64)->bool{return x==y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := coreX64ExeCommand([]string{"-entry", "eqi", "-o", iExe, iSource}, &out); err != nil {
		t.Fatal(err)
	}
	minI64 := "-9223372036854775808"
	if got := runDirectExeExitCode(t, iExe, minI64, minI64); got != 1 {
		t.Fatalf("INT64_MIN equality exit=%d want=1", got)
	}

	uSource := filepath.Join(dir, "equ.swyp")
	uExe := filepath.Join(dir, "equ.exe")
	if err := os.WriteFile(uSource, []byte("fn equ(x:u64,y:u64)->bool{return x==y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := coreX64ExeCommand([]string{"-entry", "equ", "-o", uExe, uSource}, &out); err != nil {
		t.Fatal(err)
	}
	maxU64 := "18446744073709551615"
	if got := runDirectExeExitCode(t, uExe, maxU64, maxU64); got != 1 {
		t.Fatalf("UINT64_MAX equality exit=%d want=1", got)
	}
}

func TestCoreX64ExeHandlesQuotedExecutablePath(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "directory with spaces")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "add.swyp")
	exePath := filepath.Join(dir, "add with spaces.exe")
	if err := os.WriteFile(source, []byte("fn add(x:i64,y:i64)->i64{return x+y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "add", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath, "19", "23"); got != 42 {
		t.Fatalf("quoted path exit=%d want=42", got)
	}
}

func TestCoreX64ExeParsesBoolArguments(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "choose.swyp")
	exePath := filepath.Join(dir, "choose.exe")
	program := "fn choose(c:bool,x:i64,y:i64)->i64{if c{return x;}return y;} fn main(){}"
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "choose", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		value string
		want  int
	}{{"true", 7}, {"false", 9}, {"1", 7}, {"0", 9}} {
		if got := runDirectExeExitCode(t, exePath, tc.value, "7", "9"); got != tc.want {
			t.Fatalf("bool=%s exit code=%d want=%d", tc.value, got, tc.want)
		}
	}
}

func TestCoreX64ExeRejectsInvalidRuntimeArguments(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "id.swyp")
	exePath := filepath.Join(dir, "id.exe")
	if err := os.WriteFile(source, []byte("fn id(x:i64)->i64{return x;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "id", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{},
		{"abc"},
		{"9223372036854775808"},
		{"-9223372036854775809"},
		{"1", "2"},
	} {
		if got := runDirectExeExitCode(t, exePath, args...); got != 2 {
			t.Fatalf("args=%v exit code=%d want=2", args, got)
		}
	}
}

func TestCoreX64ExeParsesIEEE64Arguments(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "cmp.swyp")
	exePath := filepath.Join(dir, "cmp.exe")
	if err := os.WriteFile(source, []byte("fn cmp(x:ieee64,y:ieee64)->bool{return x>y;} fn main(){}"), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "cmp", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		a, b string
		want int
	}{
		{"3.25", "2.5", 1},
		{"-1.25", "0.5", 0},
		{".5", "0.25", 1},
		{"1.", "0.5", 1},
		{"1e2", "99.5", 1},
		{"1E-2", "0.02", 0},
		{"1e400", "0", 1},
	} {
		if got := runDirectExeExitCode(t, exePath, tc.a, tc.b); got != tc.want {
			t.Fatalf("args=%q,%q exit=%d want=%d", tc.a, tc.b, got, tc.want)
		}
	}
	for _, bad := range []string{".", "1e", "--1", "1.2.3"} {
		if got := runDirectExeExitCode(t, exePath, bad, "0"); got != 2 {
			t.Fatalf("bad=%q exit=%d want=2", bad, got)
		}
	}
}

func TestCoreX64ExeBytesLenLiteral(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "bytes-len.swyp")
	exePath := filepath.Join(dir, "bytes-len.exe")
	if err := os.WriteFile(source, []byte(`fn length()->u64{return bytes_len("hello");} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "length", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath); got != 5 {
		t.Fatalf("exit code=%d want=5", got)
	}
}

func TestCoreX64ExeBytesGetLiteral(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "bytes-get.swyp")
	exePath := filepath.Join(dir, "bytes-get.exe")
	if err := os.WriteFile(source, []byte(`fn first()->u64{return bytes_get("abc",0);} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "first", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath); got != int('a') {
		t.Fatalf("exit code=%d want=%d", got, int('a'))
	}
}

func TestCoreX64ExeWriteFileEffect(t *testing.T) {
	dir := t.TempDir()
	target := filepath.ToSlash(filepath.Join(dir, "written-by-swyp.txt"))
	source := filepath.Join(dir, "write.swyp")
	exePath := filepath.Join(dir, "write.exe")
	program := fmt.Sprintf(`fn save()->i64{write_file(%q,"hello-from-swyp");return 7;} fn main(){}`, target)
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-allow-fs-write", "-entry", "save", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath); got != 7 {
		t.Fatalf("exit code=%d want=7", got)
	}
	data, err := os.ReadFile(filepath.FromSlash(target))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello-from-swyp" {
		t.Fatalf("file=%q", data)
	}
	pf, err := pe.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer pf.Close()
	rdata := pf.Section(".rdata")
	if rdata == nil || rdata.Characteristics&0x40000000 == 0 || rdata.Characteristics&0x20000000 != 0 || rdata.Characteristics&0x80000000 != 0 {
		t.Fatalf("rdata=%v", rdata)
	}
}

func TestCoreX64ExeReadFileEffect(t *testing.T) {
	dir := t.TempDir()
	inputPath := filepath.Join(dir, "input.txt")
	if err := os.WriteFile(inputPath, []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "read.swyp")
	exePath := filepath.Join(dir, "read.exe")
	program := fmt.Sprintf(`fn load()->u64{let b:bytes=read_file(%s);return bytes_get(b,0)+bytes_len(b);} fn main(){}`, strconv.Quote(inputPath))
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-allow-fs-read", "-entry", "load", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath); got != int('h')+5 {
		t.Fatalf("exit=%d want=%d", got, int('h')+5)
	}
}

func TestCoreX64ExeReadFileArenaIsMonotonic(t *testing.T) {
	dir := t.TempDir()
	firstPath := filepath.Join(dir, "first.txt")
	secondPath := filepath.Join(dir, "second.txt")
	if err := os.WriteFile(firstPath, []byte("A"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(secondPath, []byte("B"), 0600); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "multi-read.swyp")
	exePath := filepath.Join(dir, "multi-read.exe")
	program := fmt.Sprintf(`fn load()->u64{let a:bytes=read_file(%s);let b:bytes=read_file(%s);return bytes_get(a,0)+bytes_get(b,0);} fn main(){}`, strconv.Quote(firstPath), strconv.Quote(secondPath))
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-allow-fs-read", "-entry", "load", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath); got != int('A')+int('B') {
		t.Fatalf("exit=%d want=%d", got, int('A')+int('B'))
	}
}

func TestCoreX64ExeReadFileRejectsOversizedInput(t *testing.T) {
	dir := t.TempDir()
	inputPath := filepath.Join(dir, "large.bin")
	if err := os.WriteFile(inputPath, make([]byte, coreir.DefaultProcessRuntimeArenaBytes), 0600); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(dir, "read-large.swyp")
	exePath := filepath.Join(dir, "read-large.exe")
	program := fmt.Sprintf(`fn load()->u64{let b:bytes=read_file(%s);return bytes_len(b);} fn main(){}`, strconv.Quote(inputPath))
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-allow-fs-read", "-entry", "load", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath); got != 1 {
		t.Fatalf("oversized read exit=%d want=1", got)
	}
}

func TestCoreX64ExeTCPConnectLoopback(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	accepted := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			_ = conn.Close()
		}
		accepted <- err
	}()

	dir := t.TempDir()
	source := filepath.Join(dir, "connect.swyp")
	exePath := filepath.Join(dir, "connect.exe")
	program := fmt.Sprintf(`fn ping()->bool{return tcp_connect("127.0.0.1",%d);} fn main(){}`, port)
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-allow-net-connect", "-entry", "ping", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath); got != 1 {
		t.Fatalf("connected exit=%d want=1", got)
	}
	if err := <-accepted; err != nil {
		t.Fatalf("listener accept: %v", err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath); got != 0 {
		t.Fatalf("refused exit=%d want=0", got)
	}

	pf, err := pe.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer pf.Close()
	imports, err := pf.ImportedSymbols()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"WSAStartup:WS2_32.dll":  false,
		"socket:WS2_32.dll":      false,
		"inet_pton:WS2_32.dll":   false,
		"connect:WS2_32.dll":     false,
		"closesocket:WS2_32.dll": false,
		"WSACleanup:WS2_32.dll":  false,
	}
	for _, name := range imports {
		if _, ok := want[name]; ok {
			want[name] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Fatalf("missing import %s in %v", name, imports)
		}
	}
}

func TestCoreX64ExeTCPConnectRejectsInvalidEndpoint(t *testing.T) {
	dir := t.TempDir()
	for _, tc := range []struct {
		name string
		host string
		port uint64
	}{
		{name: "bad-ipv4", host: "localhost", port: 80},
		{name: "zero-port", host: "127.0.0.1", port: 0},
		{name: "high-port", host: "127.0.0.1", port: 65536},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := filepath.Join(dir, tc.name+".swyp")
			exePath := filepath.Join(dir, tc.name+".exe")
			program := fmt.Sprintf(`fn ping()->bool{return tcp_connect(%q,%d);} fn main(){}`, tc.host, tc.port)
			if err := os.WriteFile(source, []byte(program), 0600); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			if err := coreX64ExeCommand([]string{"-allow-net-connect", "-entry", "ping", "-o", exePath, source}, &out); err != nil {
				t.Fatal(err)
			}
			if got := runDirectExeExitCode(t, exePath); got != 1 {
				t.Fatalf("host=%q port=%d exit=%d want=1 backend failure", tc.host, tc.port, got)
			}
		})
	}
}

func TestCoreX64ExeHTTPFetchLoopback(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	response := "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK"
	serverDone := make(chan error, 1)
	requestSeen := make(chan string, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		defer conn.Close()
		buf := make([]byte, 4096)
		n := 0
		for n < len(buf) {
			read, readErr := conn.Read(buf[n:])
			n += read
			if bytes.Contains(buf[:n], []byte("\r\n\r\n")) {
				break
			}
			if readErr != nil {
				serverDone <- readErr
				return
			}
		}
		requestSeen <- string(buf[:n])
		_, err = conn.Write([]byte(response))
		serverDone <- err
	}()

	dir := t.TempDir()
	source := filepath.Join(dir, "fetch.swyp")
	exePath := filepath.Join(dir, "fetch.exe")
	program := fmt.Sprintf("fn load()->u64{let b:bytes=http_fetch(\"127.0.0.1\",%d,\"/health\");return bytes_len(b);} fn main(){}", port)
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-allow-net-fetch", "-entry", "load", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath); got != len(response) {
		t.Fatalf("fetch exit=%d want response length=%d", got, len(response))
	}
	if err := <-serverDone; err != nil {
		t.Fatalf("loopback server: %v", err)
	}
	request := <-requestSeen
	if !strings.HasPrefix(request, "GET /health HTTP/1.1\r\n") {
		t.Fatalf("request=%q", request)
	}
	if !strings.Contains(request, "\r\nHost: 127.0.0.1\r\n") || !strings.Contains(request, "\r\nConnection: close\r\n\r\n") {
		t.Fatalf("request headers=%q", request)
	}

	pf, err := pe.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer pf.Close()
	imports, err := pf.ImportedSymbols()
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"WSAStartup:WS2_32.dll":      false,
		"socket:WS2_32.dll":          false,
		"setsockopt:WS2_32.dll":      false,
		"htons:WS2_32.dll":           false,
		"inet_pton:WS2_32.dll":       false,
		"ioctlsocket:WS2_32.dll":     false,
		"connect:WS2_32.dll":         false,
		"WSAGetLastError:WS2_32.dll": false,
		"select:WS2_32.dll":          false,
		"getsockopt:WS2_32.dll":      false,
		"send:WS2_32.dll":            false,
		"recv:WS2_32.dll":            false,
		"closesocket:WS2_32.dll":     false,
		"WSACleanup:WS2_32.dll":      false,
	}
	for _, name := range imports {
		if _, ok := want[name]; ok {
			want[name] = true
		}
	}
	for name, found := range want {
		if !found {
			t.Fatalf("missing import %s in %v", name, imports)
		}
	}
}

func TestCoreX64ExeHTTPFetchRejectsInvalidPolicyInputs(t *testing.T) {
	dir := t.TempDir()
	for _, tc := range []struct {
		name string
		host string
		port uint64
		path string
	}{
		{name: "hostname", host: "localhost", port: 80, path: "/"},
		{name: "zero-port", host: "127.0.0.1", port: 0, path: "/"},
		{name: "high-port", host: "127.0.0.1", port: 65536, path: "/"},
		{name: "relative-path", host: "127.0.0.1", port: 80, path: "health"},
		{name: "space-in-path", host: "127.0.0.1", port: 80, path: "/bad path"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := filepath.Join(dir, tc.name+".swyp")
			exePath := filepath.Join(dir, tc.name+".exe")
			program := fmt.Sprintf("fn load()->u64{let b:bytes=http_fetch(%q,%d,%q);return bytes_len(b);} fn main(){}", tc.host, tc.port, tc.path)
			if err := os.WriteFile(source, []byte(program), 0600); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			if err := coreX64ExeCommand([]string{"-allow-net-fetch", "-entry", "load", "-o", exePath, source}, &out); err != nil {
				t.Fatal(err)
			}
			if got := runDirectExeExitCode(t, exePath); got != 1 {
				t.Fatalf("host=%q port=%d path=%q exit=%d want=1 backend failure", tc.host, tc.port, tc.path, got)
			}
		})
	}
}

func TestCoreX64ExeHTTPFetchRejectsOversizedResponse(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	serverDone := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			serverDone <- err
			return
		}
		defer conn.Close()
		buf := make([]byte, 4096)
		n := 0
		for n < len(buf) {
			read, readErr := conn.Read(buf[n:])
			n += read
			if bytes.Contains(buf[:n], []byte("\r\n\r\n")) {
				break
			}
			if readErr != nil {
				serverDone <- readErr
				return
			}
		}
		payload := bytes.Repeat([]byte{'x'}, coreir.DefaultProcessRuntimeArenaBytes+1024)
		_, err = conn.Write(payload)
		serverDone <- err
	}()

	dir := t.TempDir()
	source := filepath.Join(dir, "oversized-fetch.swyp")
	exePath := filepath.Join(dir, "oversized-fetch.exe")
	program := fmt.Sprintf("fn load()->u64{let b:bytes=http_fetch(\"127.0.0.1\",%d,\"/\");return bytes_len(b);} fn main(){}", port)
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-allow-net-fetch", "-entry", "load", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath); got != 1 {
		t.Fatalf("oversized fetch exit=%d want=1 backend failure", got)
	}
	if err := <-serverDone; err != nil {
		// A reset/broken pipe is acceptable after the bounded client has
		// observed overflow and closed its side of the socket.
		if !strings.Contains(strings.ToLower(err.Error()), "reset") && !strings.Contains(strings.ToLower(err.Error()), "broken pipe") {
			t.Fatalf("loopback server: %v", err)
		}
	}
}

func TestCoreX64ExePrintsScalarStdout(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "print.swyp")
	exePath := filepath.Join(dir, "print.exe")
	program := `
fn emit(x:i64)->i64 { print(x); return x; }
fn answer(x:i64)->i64 { return emit(x); }
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "answer", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exePath, "42")
	output, _ := cmd.CombinedOutput()
	if cmd.ProcessState == nil || cmd.ProcessState.ExitCode() != 42 {
		t.Fatalf("state=%v output=%q", cmd.ProcessState, output)
	}
	if string(output) != "42\n" {
		t.Fatalf("stdout=%q want=%q", output, "42\n")
	}
}

func TestCoreX64ExePrintsBoolStdout(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "bool-print.swyp")
	exePath := filepath.Join(dir, "bool-print.exe")
	program := `fn show(x:bool)->i64{print(x);return 0;} fn main(){}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "show", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"true", "false"} {
		cmd := exec.Command(exePath, value)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("value=%s err=%v output=%q", value, err, output)
		}
		if string(output) != value+"\n" {
			t.Fatalf("value=%s stdout=%q", value, output)
		}
	}
}

func TestCoreX64ExeSeparatesStdoutAndStderr(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "streams.swyp")
	exePath := filepath.Join(dir, "streams.exe")
	program := `fn show(x:i64)->i64{print(x);eprint(x);return 0;} fn main(){}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "show", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exePath, "42")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("run: %v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
	}
	if stdout.String() != "42\n" || stderr.String() != "42\n" {
		t.Fatalf("stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestCoreX64ExePrintsIEEE64CanonicalHex(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fp-print.swyp")
	exePath := filepath.Join(dir, "show.exe")
	if err := os.WriteFile(source, []byte(`fn show(x:ieee64)->i64{print(x);return 0;} fn main(){}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "show", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		arg  string
		want string
	}{
		{"1.5", "0x1.8000000000000p+0\n"},
		{"-2.25", "-0x1.2000000000000p+1\n"},
		{"0", "0x0p+0\n"},
		{"-0", "-0x0p+0\n"},
		{"100", "0x1.9000000000000p+6\n"},
	} {
		cmd := exec.Command(exePath, tc.arg)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("arg=%s run: %v output=%q", tc.arg, err, output)
		}
		if string(output) != tc.want {
			t.Fatalf("arg=%s output=%q want=%q", tc.arg, output, tc.want)
		}
	}
}

func TestCoreX64ExePrintsIEEE64SpecialValues(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fp-special.swyp")
	program := `
fn tiny()->i64{let x:ieee64=5e-324;print(x);return 0;}
fn pinf()->i64{let one:ieee64=1;let zero:ieee64=0;print(one/zero);return 0;}
fn ninf()->i64{let one:ieee64=-1;let zero:ieee64=0;print(one/zero);return 0;}
fn qnan()->i64{let zero:ieee64=0;print(zero/zero);return 0;}
fn main(){}
`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		entry string
		want  string
	}{
		{"tiny", "0x0.0000000000001p-1022\n"},
		{"pinf", "inf\n"},
		{"ninf", "-inf\n"},
		{"qnan", "nan\n"},
	} {
		exePath := filepath.Join(dir, tc.entry+".exe")
		var out bytes.Buffer
		if err := coreX64ExeCommand([]string{"-entry", tc.entry, "-o", exePath, source}, &out); err != nil {
			t.Fatalf("entry=%s build: %v", tc.entry, err)
		}
		cmd := exec.Command(exePath)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("entry=%s run: %v output=%q", tc.entry, err, output)
		}
		if string(output) != tc.want {
			t.Fatalf("entry=%s output=%q want=%q", tc.entry, output, tc.want)
		}
	}
}

func TestCoreX64ExeSeparatesIEEE64StdoutAndStderr(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "fp-streams.swyp")
	exePath := filepath.Join(dir, "fp-streams.exe")
	program := `fn show(x:ieee64)->i64{print(x);eprint(x);return 0;} fn main(){}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "show", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exePath, "1.5")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("run: %v stdout=%q stderr=%q", err, stdout.String(), stderr.String())
	}
	want := "0x1.8000000000000p+0\n"
	if stdout.String() != want || stderr.String() != want {
		t.Fatalf("stdout=%q stderr=%q want=%q", stdout.String(), stderr.String(), want)
	}
}

func TestCoreX64ExeClockRuntimeAndStdout(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "clock.swyp")
	exePath := filepath.Join(dir, "clock.exe")
	program := `fn now()->u64{let t:u64=clock();print(t);return 0;} fn main(){}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "now", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("run: %v output=%q", err, output)
	}
	value, err := strconv.ParseUint(strings.TrimSpace(string(output)), 10, 64)
	if err != nil || value == 0 {
		t.Fatalf("clock output=%q value=%d err=%v", output, value, err)
	}
}

func TestCoreX64ExeClockIsMonotonic(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "clock-monotonic.swyp")
	exePath := filepath.Join(dir, "clock-monotonic.exe")
	program := `fn check()->bool{let a:u64=clock();let b:u64=clock();return b>=a;} fn main(){}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "check", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	if got := runDirectExeExitCode(t, exePath); got != 1 {
		t.Fatalf("monotonic clock exit=%d want=1", got)
	}
}

func TestCoreX64ExeRandomRuntimeAndBcryptImport(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "rng.swyp")
	exePath := filepath.Join(dir, "rng.exe")
	program := `fn sample()->u64{let x:u64=random();print(x);return 0;} fn main(){}`
	if err := os.WriteFile(source, []byte(program), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := coreX64ExeCommand([]string{"-entry", "sample", "-o", exePath, source}, &out); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("run: %v output=%q", err, output)
	}
	if _, err := strconv.ParseUint(strings.TrimSpace(string(output)), 10, 64); err != nil {
		t.Fatalf("rng output=%q parse=%v", output, err)
	}
	pf, err := pe.Open(exePath)
	if err != nil {
		t.Fatal(err)
	}
	defer pf.Close()
	imports, err := pf.ImportedSymbols()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, name := range imports {
		if name == "BCryptGenRandom:BCRYPT.dll" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("imports=%v", imports)
	}
}

func runDirectExeExitCode(t *testing.T, exePath string, args ...string) int {
	t.Helper()
	cmd := exec.Command(exePath, args...)
	_ = cmd.Run()
	if cmd.ProcessState == nil {
		t.Fatal("process did not start")
	}
	return cmd.ProcessState.ExitCode()
}
