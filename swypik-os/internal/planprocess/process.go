// Package planprocess transports bounded JSONL to explicitly trusted children.
// It is a process adapter, not a sandbox or a process-tree resource account.
package planprocess

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"swypik-os/core/resource"
)

const (
	// MaxLineBytes is the backward-compatible default JSONL payload bound.
	// It excludes the LF/CRLF delimiter bytes.
	MaxLineBytes = 2 << 20
	// MaxJSONLBytes is the largest explicit per-process JSONL payload bound.
	// It matches the public continuation v1 message ceiling without making any
	// claim that a caller has opted its end-to-end protocol into that size.
	MaxJSONLBytes  = 9 << 20
	MaxStderrBytes = 8 << 10
)

var (
	ErrLineLimit   = errors.New("process JSONL line exceeds limit")
	ErrStderrLimit = errors.New("process stderr exceeds limit")
	ErrCPULimit    = errors.New("process activity CPU limit exceeded")
	ErrRSSLimit    = errors.New("process resident memory limit exceeded")
	ErrClosed      = errors.New("process adapter closed")
	ErrMonitorBusy = errors.New("process already has an active monitor")
	ErrJSONLLimit  = errors.New("invalid process JSONL payload limit")
	ErrJSONLFrame  = errors.New("process stdout JSONL frame requires LF or CRLF terminator")
)

type Config struct {
	Executable       string
	Args             []string
	Directory        string
	MaxThreads       int
	MemoryLimitBytes int64
	GCPercent        int
	// JSONLMaxBytes bounds the JSON payload bytes in each stdin/stdout frame.
	// Zero preserves MaxLineBytes. Explicit values may be 1..MaxJSONLBytes.
	// Delimiters are excluded: SendJSON appends LF; stdout accepts LF or CRLF.
	JSONLMaxBytes int
}

type lineResult struct {
	line []byte
}

type Process struct {
	cmd                *exec.Cmd
	stdin, stdout      *os.File
	stderr             *os.File
	lines              chan lineResult
	done, aborted      chan struct{}
	stderrDone         chan struct{}
	stdoutDone         chan struct{}
	sendLock, readLock chan struct{}
	abortOnce          sync.Once
	closeOnce          sync.Once
	mu                 sync.Mutex
	failure, waitErr   error
	stderrBytes        []byte
	sampler            *resource.ProcessSampler
	samplerErr         error
	usage              resource.ProcessUsage
	exited             bool
	monitorActive      bool
	jsonlMaxBytes      int
}

func resolveJSONLMaxBytes(config Config) (int, error) {
	if config.JSONLMaxBytes == 0 {
		return MaxLineBytes, nil
	}
	if config.JSONLMaxBytes < 0 || config.JSONLMaxBytes > MaxJSONLBytes {
		return 0, fmt.Errorf("%w: must be 0 or 1..%d bytes", ErrJSONLLimit, MaxJSONLBytes)
	}
	return config.JSONLMaxBytes, nil
}

func childEnvironment(config Config) []string {
	env := make([]string, 0, 8)
	for _, name := range []string{"SystemRoot", "SystemDrive", "TEMP", "TMP", "TMPDIR"} {
		if value, exists := os.LookupEnv(name); exists {
			env = append(env, name+"="+value)
		}
	}
	threads := strconv.Itoa(config.MaxThreads)
	// Native numeric runtimes (OpenMP, OpenBLAS, MKL) start one pool thread per CPU
	// unless capped. MaxThreads is the admitted thread budget of the child, and on
	// Linux every thread also counts against the delegated cgroup pids.max.
	return append(env, "GOMAXPROCS="+threads,
		"GOMEMLIMIT="+strconv.FormatInt(config.MemoryLimitBytes, 10), "GOGC="+strconv.Itoa(config.GCPercent),
		"OMP_NUM_THREADS="+threads, "OPENBLAS_NUM_THREADS="+threads, "MKL_NUM_THREADS="+threads)
}

func Start(ctx context.Context, config Config) (*Process, error) {
	return start(ctx, config, nil)
}

func start(ctx context.Context, config Config, group *platformGroup) (*Process, error) {
	if ctx == nil || !filepath.IsAbs(config.Executable) || config.MaxThreads < 1 || config.MemoryLimitBytes < 1 || config.GCPercent < 0 {
		return nil, fmt.Errorf("process requires context, absolute executable and explicit valid runtime limits")
	}
	jsonlMaxBytes, err := resolveJSONLMaxBytes(config)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Stat(config.Executable)
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("process executable must be a regular file")
	}
	if config.Directory != "" {
		info, err = os.Stat(config.Directory)
		if !filepath.IsAbs(config.Directory) || err != nil || !info.IsDir() {
			return nil, fmt.Errorf("process directory must be an absolute directory")
		}
	}
	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		_ = stdinRead.Close()
		_ = stdinWrite.Close()
		return nil, err
	}
	stderrRead, stderrWrite, err := os.Pipe()
	if err != nil {
		for _, file := range []*os.File{stdinRead, stdinWrite, stdoutRead, stdoutWrite} {
			_ = file.Close()
		}
		return nil, err
	}
	cmd := exec.Command(config.Executable, append([]string(nil), config.Args...)...)
	cmd.Dir, cmd.Env = config.Directory, childEnvironment(config)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinRead, stdoutWrite, stderrWrite
	configureChild(cmd, group)
	if err := cmd.Start(); err != nil {
		for _, file := range []*os.File{stdinRead, stdinWrite, stdoutRead, stdoutWrite, stderrRead, stderrWrite} {
			_ = file.Close()
		}
		return nil, err
	}
	if err := activateChild(group, cmd.Process.Pid); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		for _, file := range []*os.File{stdinRead, stdinWrite, stdoutRead, stdoutWrite, stderrRead, stderrWrite} {
			_ = file.Close()
		}
		return nil, fmt.Errorf("attach child to strict OS process group: %w", err)
	}
	// Cmd does not own the read ends: Wait cannot truncate unread output.
	_ = stdinRead.Close()
	_ = stdoutWrite.Close()
	_ = stderrWrite.Close()
	p := &Process{cmd: cmd, stdin: stdinWrite, stdout: stdoutRead, stderr: stderrRead,
		lines: make(chan lineResult, 1), done: make(chan struct{}), aborted: make(chan struct{}),
		stderrDone: make(chan struct{}), stdoutDone: make(chan struct{}),
		sendLock: make(chan struct{}, 1), readLock: make(chan struct{}, 1), jsonlMaxBytes: jsonlMaxBytes}
	p.sendLock <- struct{}{}
	p.readLock <- struct{}{}
	p.sampler, p.samplerErr = resource.NewProcessSampler(cmd.Process.Pid)
	go p.readStdout()
	go p.readStderr()
	go p.awaitExit()
	go func() {
		select {
		case <-ctx.Done():
			p.fail(ctx.Err())
		case <-p.done:
		}
	}()
	return p, nil
}

func (p *Process) failureError() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.failure
}

func (p *Process) fail(err error) {
	p.mu.Lock()
	if p.failure == nil {
		p.failure = err
	}
	p.mu.Unlock()
	p.abortOnce.Do(func() {
		close(p.aborted)
		select {
		case <-p.done:
		default:
			_ = killChild(p.cmd.Process)
		}
		_ = p.stdin.Close()
		_ = p.stdout.Close()
		_ = p.stderr.Close()
	})
}

func (p *Process) readStdout() {
	defer close(p.stdoutDone)
	defer close(p.lines)
	reader := bufio.NewReaderSize(p.stdout, 64<<10)
	for {
		line, err := readJSONLFrame(reader, p.jsonlMaxBytes)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return
			}
			if p.failureError() == nil {
				if errors.Is(err, ErrLineLimit) || errors.Is(err, ErrJSONLFrame) {
					p.fail(err)
				} else {
					p.fail(fmt.Errorf("process stdout: %w", err))
				}
			}
			return
		}
		select {
		case p.lines <- lineResult{line: line}:
		case <-p.aborted:
			return
		}
	}
}

func appendBounded(dst, src []byte, limit int) ([]byte, error) {
	if len(src) > limit-len(dst) {
		return nil, ErrLineLimit
	}
	need := len(dst) + len(src)
	if need > cap(dst) {
		capacity := cap(dst) * 2
		if capacity < 64<<10 {
			capacity = 64 << 10
		}
		if capacity < need {
			capacity = need
		}
		if capacity > limit {
			capacity = limit
		}
		next := make([]byte, len(dst), capacity)
		copy(next, dst)
		dst = next
	}
	return append(dst, src...), nil
}

// readJSONLFrame reads one strict JSONL transport frame. Payload is defined as
// all bytes before the delimiter. LF and CRLF are accepted; their 1/2 bytes do
// not count toward maxPayload. A CR not immediately followed by LF is payload.
// A non-empty EOF fragment is rejected rather than treated as an implicit line.
func readJSONLFrame(reader *bufio.Reader, maxPayload int) ([]byte, error) {
	var frame []byte
	for {
		fragment, err := reader.ReadSlice('\n')
		if err == nil {
			payload := fragment[:len(fragment)-1]
			if len(payload) != 0 && payload[len(payload)-1] == '\r' {
				payload = payload[:len(payload)-1]
			} else if len(payload) == 0 && len(frame) != 0 && frame[len(frame)-1] == '\r' {
				frame = frame[:len(frame)-1]
			}
			var appendErr error
			frame, appendErr = appendBounded(frame, payload, maxPayload)
			if appendErr != nil {
				return nil, appendErr
			}
			return frame, nil
		}

		if errors.Is(err, bufio.ErrBufferFull) {
			// One byte beyond the payload limit is temporarily permitted only so
			// a CR split from its LF delimiter at the reader-buffer boundary can
			// be recognized without widening the payload bound.
			var appendErr error
			frame, appendErr = appendBounded(frame, fragment, maxPayload+1)
			if appendErr != nil || len(frame) > maxPayload && frame[len(frame)-1] != '\r' {
				return nil, ErrLineLimit
			}
			continue
		}
		if errors.Is(err, io.EOF) {
			if len(frame) == 0 && len(fragment) == 0 {
				return nil, io.EOF
			}
			return nil, ErrJSONLFrame
		}
		return nil, err
	}
}

func (p *Process) readStderr() {
	defer close(p.stderrDone)
	buffer := make([]byte, 1024)
	for {
		n, err := p.stderr.Read(buffer)
		if n != 0 {
			p.mu.Lock()
			remaining := MaxStderrBytes - len(p.stderrBytes)
			keep := n
			if keep > remaining {
				keep = remaining
			}
			p.stderrBytes = append(p.stderrBytes, buffer[:keep]...)
			p.mu.Unlock()
			if n > remaining {
				p.fail(ErrStderrLimit)
				return
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) && p.failureError() == nil {
				p.fail(fmt.Errorf("process stderr: %w", err))
			}
			return
		}
	}
}

func (p *Process) awaitExit() {
	err := p.cmd.Wait()
	final := finalUsage(p.cmd.ProcessState)
	p.mu.Lock()
	p.waitErr, p.exited = err, true
	if final.CPUTime > p.usage.CPUTime {
		p.usage.CPUTime = final.CPUTime
	}
	if final.PeakRSSBytes > p.usage.PeakRSSBytes {
		p.usage.PeakRSSBytes = final.PeakRSSBytes
	}
	p.usage.RSSBytes = 0
	p.mu.Unlock()
	close(p.done)
}

func acquire(ctx context.Context, lock chan struct{}) error {
	if ctx == nil {
		return fmt.Errorf("process operation requires context")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-lock:
		return nil
	}
}

func (p *Process) SendJSON(ctx context.Context, value any) error {
	if err := acquire(ctx, p.sendLock); err != nil {
		p.fail(err)
		return err
	}
	defer func() { p.sendLock <- struct{}{} }()
	if err := p.failureError(); err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil || len(raw) > p.jsonlMaxBytes {
		if err == nil {
			err = ErrLineLimit
		}
		p.fail(err)
		return err
	}
	frame := make([]byte, len(raw)+1)
	copy(frame, raw)
	frame[len(raw)] = '\n'
	written := make(chan error, 1)
	go func() {
		for len(frame) > 0 {
			n, err := p.stdin.Write(frame)
			if err != nil {
				written <- err
				return
			}
			if n == 0 {
				written <- io.ErrNoProgress
				return
			}
			frame = frame[n:]
		}
		written <- nil
	}()
	select {
	case err := <-written:
		if contextErr := ctx.Err(); contextErr != nil {
			p.fail(contextErr)
			return contextErr
		}
		if failure := p.failureError(); failure != nil {
			return failure
		}
		if err != nil {
			p.fail(fmt.Errorf("process stdin: %w", err))
		}
		return err
	case <-ctx.Done():
		p.fail(ctx.Err())
		return ctx.Err()
	case <-p.aborted:
		return p.failureError()
	}
}

func (p *Process) ReadLine(ctx context.Context) ([]byte, error) {
	if err := acquire(ctx, p.readLock); err != nil {
		p.fail(err)
		return nil, err
	}
	defer func() { p.readLock <- struct{}{} }()
	if err := p.failureError(); err != nil {
		return nil, err
	}
	select {
	case result, ok := <-p.lines:
		if err := ctx.Err(); err != nil {
			p.fail(err)
			return nil, err
		}
		if err := p.failureError(); err != nil {
			return nil, err
		}
		if !ok {
			// Stdout can close before stderr is drained (or while the child
			// still owns it). Do not publish a clean EOF before its bounded
			// diagnostics have been validated. Waiting stays cancellable and
			// does not delay delivery of any queued stdout frames.
			select {
			case <-p.stderrDone:
			case <-ctx.Done():
				p.fail(ctx.Err())
				return nil, ctx.Err()
			case <-p.aborted:
				return nil, p.failureError()
			}
			if err := ctx.Err(); err != nil {
				p.fail(err)
				return nil, err
			}
			if err := p.failureError(); err != nil {
				return nil, err
			}
			return nil, io.EOF
		}
		return result.line, nil
	case <-ctx.Done():
		p.fail(ctx.Err())
		return nil, ctx.Err()
	case <-p.aborted:
		return nil, p.failureError()
	}
}

func (p *Process) Wait(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("process wait requires context")
	}
	if err := ctx.Err(); err != nil {
		p.fail(err)
		return err
	}
	for _, done := range []<-chan struct{}{p.done, p.stderrDone} {
		select {
		case <-done:
		case <-ctx.Done():
			p.fail(ctx.Err())
			return ctx.Err()
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	err := errors.Join(p.failure, p.waitErr)
	if err != nil && len(p.stderrBytes) != 0 {
		return fmt.Errorf("%w; stderr: %q", err, p.stderrBytes)
	}
	return err
}

// Close aborts remaining work and releases pipes/sampler. It is idempotent;
// callers should use Wait to assess a normal child exit before closing.
func (p *Process) Close() error {
	p.closeOnce.Do(func() {
		p.fail(ErrClosed)
		<-p.done
		<-p.stderrDone
		<-p.stdoutDone
		p.mu.Lock()
		if p.sampler != nil {
			_ = p.sampler.Close()
			p.sampler = nil
		}
		p.mu.Unlock()
	})
	return nil
}

func (p *Process) Usage() (resource.ProcessUsage, error) {
	p.mu.Lock()
	if p.exited {
		defer p.mu.Unlock()
		return p.usage, nil
	}
	if p.sampler == nil {
		defer p.mu.Unlock()
		return resource.ProcessUsage{}, p.samplerErr
	}
	usage, err := p.sampler.Sample()
	if err != nil {
		p.mu.Unlock()
		select {
		case <-p.done:
			p.mu.Lock()
			defer p.mu.Unlock()
			return p.usage, nil
		default:
		}
		// Linux can reap /proc before awaitExit stores ProcessState. Wait on
		// that exit event rather than treating a fast, normal exit as a failed
		// resource observation. Running-process errors still fail immediately.
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ESRCH) ||
			strings.Contains(err.Error(), "process stat") ||
			strings.Contains(err.Error(), "process status") ||
			strings.Contains(err.Error(), "no such process") {
			select {
			case <-p.done:
				p.mu.Lock()
				defer p.mu.Unlock()
				return p.usage, nil
			case <-p.aborted:
				return resource.ProcessUsage{}, err
			}
		}
		return resource.ProcessUsage{}, err
	}
	if usage.PeakRSSBytes < p.usage.PeakRSSBytes {
		usage.PeakRSSBytes = p.usage.PeakRSSBytes
	}
	p.usage = usage
	p.mu.Unlock()
	return usage, nil
}
