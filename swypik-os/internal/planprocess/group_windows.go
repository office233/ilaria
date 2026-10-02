//go:build windows

package planprocess

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	createNoWindow         = 0x08000000
	createSuspended        = 0x00000004
	jobObjectCPURateEnable = 0x00000001
	jobObjectCPUHardCap    = 0x00000004
)

type platformGroup struct {
	job windows.Handle
}

type jobObjectCPURateControlInformation struct {
	ControlFlags uint32
	CPURate      uint32
}

var ntResumeProcess = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtResumeProcess")

func openPlatformGroup(limits Limits) (*platformGroup, string, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, "", err
	}
	closeOnFailure := true
	defer func() {
		if closeOnFailure {
			_ = windows.CloseHandle(job)
		}
	}()
	extended := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	extended.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
		windows.JOB_OBJECT_LIMIT_JOB_MEMORY | windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS
	extended.BasicLimitInformation.ActiveProcessLimit = limits.MaxProcesses
	extended.JobMemoryLimit = uintptr(limits.MemoryBytes)
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&extended)), uint32(unsafe.Sizeof(extended))); err != nil {
		return nil, "", err
	}
	cpu := jobObjectCPURateControlInformation{ControlFlags: jobObjectCPURateEnable | jobObjectCPUHardCap, CPURate: limits.CPUPercent * 100}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectCpuRateControlInformation,
		uintptr(unsafe.Pointer(&cpu)), uint32(unsafe.Sizeof(cpu))); err != nil {
		return nil, "", err
	}
	closeOnFailure = false
	return &platformGroup{job: job}, "windows_job_object", nil
}

func configureChild(cmd *exec.Cmd, group *platformGroup) {
	flags := uint32(createNoWindow)
	if group != nil {
		// Assignment happens before any guest/verifier instruction can run.
		flags |= createSuspended
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
}

func activateChild(group *platformGroup, pid int) error {
	if group == nil {
		return nil
	}
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.PROCESS_SUSPEND_RESUME, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	if err := windows.AssignProcessToJobObject(group.job, handle); err != nil {
		return err
	}
	status, _, callErr := ntResumeProcess.Call(uintptr(handle))
	if status != 0 {
		if callErr != nil && !errors.Is(callErr, syscall.Errno(0)) {
			return callErr
		}
		return fmt.Errorf("NtResumeProcess status 0x%x", status)
	}
	return nil
}

func closePlatformGroup(group *platformGroup) error {
	if group == nil || group.job == 0 {
		return nil
	}
	// KILL_ON_JOB_CLOSE is the final guarantee. Explicit termination makes
	// shutdown deterministic even when trusted descendants outlive their root.
	terminateErr := windows.TerminateJobObject(group.job, 1)
	closeErr := windows.CloseHandle(group.job)
	group.job = 0
	return errors.Join(terminateErr, closeErr)
}
