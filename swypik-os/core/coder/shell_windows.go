package coder

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var (
	kernel32             = syscall.NewLazyDLL("kernel32.dll")
	createJob            = kernel32.NewProc("CreateJobObjectW")
	setJobInfo           = kernel32.NewProc("SetInformationJobObject")
	assignJob            = kernel32.NewProc("AssignProcessToJobObject")
	resumeThread         = kernel32.NewProc("ResumeThread")
	initializeAttributes = kernel32.NewProc("InitializeProcThreadAttributeList")
	updateAttributes     = kernel32.NewProc("UpdateProcThreadAttribute")
	deleteAttributes     = kernel32.NewProc("DeleteProcThreadAttributeList")
	// Serialize the short interval in which our pipe handles are inheritable.
	shellStartMu sync.Mutex
)

type shellStartupInfo struct {
	syscall.StartupInfo
	Attributes uintptr
}

// commandEnvironmentAllowlist is intentionally small and name-based. The
// process runner must never copy os.Environ wholesale: API tokens, provider
// credentials and arbitrary caller variables are not part of a command's
// ambient authority. These entries are limited to Windows/toolchain discovery,
// user cache/config locations and temporary directories needed by normal build
// commands. Adding a variable here is a security-sensitive compatibility change.
var commandEnvironmentAllowlist = []string{
	"APPDATA",
	"CommonProgramFiles",
	"CommonProgramFiles(x86)",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"PATH",
	"PATHEXT",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"SystemDrive",
	"SystemRoot",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"windir",
}

func commandEnvironment(shell string) ([]uint16, error) {
	entries := make([]string, 0, len(commandEnvironmentAllowlist)+1)
	entries = append(entries, "ComSpec="+shell)
	for _, name := range commandEnvironmentAllowlist {
		value, ok := os.LookupEnv(name)
		if !ok {
			continue
		}
		if strings.ContainsRune(value, 0) {
			return nil, fmt.Errorf("invalid %s environment value", name)
		}
		entries = append(entries, name+"="+value)
	}
	sort.Slice(entries, func(i, j int) bool {
		return strings.ToUpper(entries[i]) < strings.ToUpper(entries[j])
	})
	block := make([]uint16, 0, 256)
	for _, entry := range entries {
		wide, err := syscall.UTF16FromString(entry)
		if err != nil {
			return nil, fmt.Errorf("encode command environment: %w", err)
		}
		block = append(block, wide...)
	}
	// Each entry already ends in NUL. One additional NUL terminates the block.
	block = append(block, 0)
	return block, nil
}

// runShell owns a Windows job from before the shell's first instruction until
// completion. Closing the job kills ordinary descendants, including children
// left behind by a shell that exits successfully. This is lifecycle management,
// not a security sandbox: commands still run with the user's permissions.
func runShell(ctx context.Context, command, directory string, output io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	job, _, callErr := createJob.Call(0, 0)
	if job == 0 {
		return fmt.Errorf("create command job: %w", callErr)
	}
	jobHandle := syscall.Handle(job)
	defer func() {
		if jobHandle != 0 {
			syscall.CloseHandle(jobHandle)
		}
	}()
	// Native JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on Win64,
	// 112 on Win32. Flags follow two LARGE_INTEGER fields at offset 16.
	// Use its native layout rather than Go's different int64 alignment on 386.
	var limits [144]byte
	limitSize := uintptr(len(limits))
	if unsafe.Sizeof(uintptr(0)) == 4 {
		limitSize = 112
	}
	binary.LittleEndian.PutUint32(limits[16:20], 0x2000) // KILL_ON_JOB_CLOSE
	if ok, _, err := setJobInfo.Call(job, 9, uintptr(unsafe.Pointer(&limits[0])), limitSize); ok == 0 {
		return fmt.Errorf("configure command job: %w", err)
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		return err
	}
	defer reader.Close()
	defer writer.Close()
	stdin, err := os.Open(os.DevNull)
	if err != nil {
		return err
	}
	defer stdin.Close()

	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		return fmt.Errorf("SystemRoot is unavailable")
	}
	shell := filepath.Join(systemRoot, "System32", "cmd.exe")
	app, err := syscall.UTF16PtrFromString(shell)
	if err != nil {
		return err
	}
	environment, err := commandEnvironment(shell)
	if err != nil {
		return err
	}
	line, err := syscall.UTF16PtrFromString(syscall.EscapeArg(shell) + " /d /s /c \"" + command + "\"")
	if err != nil {
		return err
	}
	cwd, err := syscall.UTF16PtrFromString(directory)
	if err != nil {
		return err
	}
	si := shellStartupInfo{StartupInfo: syscall.StartupInfo{Flags: syscall.STARTF_USESTDHANDLES, StdInput: syscall.Handle(stdin.Fd()), StdOutput: syscall.Handle(writer.Fd()), StdErr: syscall.Handle(writer.Fd())}}
	si.Cb = uint32(unsafe.Sizeof(si))
	// Restrict inheritance to this command's stdin/output. Other host handles
	// must not become accessible to the command even if they are inheritable.
	var attributeSize uintptr
	initializeAttributes.Call(0, 1, 0, uintptr(unsafe.Pointer(&attributeSize)))
	if attributeSize == 0 {
		return fmt.Errorf("cannot size command handle attributes")
	}
	attributes := make([]byte, attributeSize)
	si.Attributes = uintptr(unsafe.Pointer(&attributes[0]))
	if ok, _, err := initializeAttributes.Call(si.Attributes, 1, 0, uintptr(unsafe.Pointer(&attributeSize))); ok == 0 {
		return fmt.Errorf("initialize command handle attributes: %w", err)
	}
	defer func() {
		deleteAttributes.Call(si.Attributes)
		runtime.KeepAlive(attributes)
	}()
	handles := []syscall.Handle{si.StdInput, si.StdOutput}
	if ok, _, err := updateAttributes.Call(si.Attributes, 0, 0x20002, uintptr(unsafe.Pointer(&handles[0])), uintptr(len(handles))*unsafe.Sizeof(handles[0]), 0, 0); ok == 0 {
		return fmt.Errorf("restrict command handles: %w", err)
	}
	var process syscall.ProcessInformation
	err = func() error {
		shellStartMu.Lock()
		defer shellStartMu.Unlock()
		for _, handle := range []syscall.Handle{si.StdInput, si.StdOutput} {
			if err := syscall.SetHandleInformation(handle, syscall.HANDLE_FLAG_INHERIT, syscall.HANDLE_FLAG_INHERIT); err != nil {
				return err
			}
			defer syscall.SetHandleInformation(handle, syscall.HANDLE_FLAG_INHERIT, 0)
		}
		// CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW |
		// EXTENDED_STARTUPINFO_PRESENT. The explicit environment block is the
		// secret-containment boundary for inherited parent environment variables.
		err := syscall.CreateProcess(app, line, nil, nil, true, 0x4|0x400|0x08000000|0x80000, &environment[0], cwd, &si.StartupInfo, &process)
		runtime.KeepAlive(environment)
		return err
	}()
	runtime.KeepAlive(attributes)
	runtime.KeepAlive(handles)
	if err != nil {
		return fmt.Errorf("start command: %w", err)
	}
	defer syscall.CloseHandle(process.Process)
	defer syscall.CloseHandle(process.Thread)
	if ok, _, err := assignJob.Call(job, uintptr(process.Process)); ok == 0 {
		syscall.TerminateProcess(process.Process, 1)
		syscall.WaitForSingleObject(process.Process, syscall.INFINITE)
		return fmt.Errorf("assign command job: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if previous, _, err := resumeThread.Call(uintptr(process.Thread)); uint32(previous) == 0xffffffff {
		return fmt.Errorf("resume command: %w", err)
	}
	writer.Close() // The job is now the only owner of the write end.
	stdin.Close()
	readDone := make(chan error, 1)
	go func() { _, err := io.Copy(output, reader); readDone <- err }()
	waitDone := make(chan error, 1)
	go func() { _, err := syscall.WaitForSingleObject(process.Process, syscall.INFINITE); waitDone <- err }()
	var waitErr error
	select {
	case waitErr = <-waitDone:
	case <-ctx.Done():
		syscall.CloseHandle(jobHandle)
		jobHandle = 0
		waitErr = <-waitDone
	}
	// Also reap descendants after a normal shell exit; never leave background work
	// alive after the UI reports the command finished.
	if jobHandle != 0 {
		syscall.CloseHandle(jobHandle)
		jobHandle = 0
	}
	readErr := <-readDone
	if err := ctx.Err(); err != nil {
		return err
	}
	if waitErr != nil {
		return waitErr
	}
	if readErr != nil {
		return readErr
	}
	var exitCode uint32
	if err := syscall.GetExitCodeProcess(process.Process, &exitCode); err != nil {
		return err
	}
	if exitCode != 0 {
		return fmt.Errorf("command exited with code %d", exitCode)
	}
	return nil
}

var multiByteToWideChar = kernel32.NewProc("MultiByteToWideChar")

// decodeConsole converts output written in the console's OEM code page (for
// example 852 on Romanian systems) to UTF-8.
func decodeConsole(b []byte) string {
	if len(b) == 0 {
		return ""
	}
	const cpOEM = 1
	n, _, _ := multiByteToWideChar.Call(cpOEM, 0, uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), 0, 0)
	if n == 0 {
		return strings.ToValidUTF8(string(b), "�")
	}
	wide := make([]uint16, n)
	multiByteToWideChar.Call(cpOEM, 0, uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), uintptr(unsafe.Pointer(&wide[0])), n)
	return syscall.UTF16ToString(wide)
}
