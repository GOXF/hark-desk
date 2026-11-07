//go:build windows

package main

import (
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var killJob windows.Handle

func setupConsole() {
	windows.SetConsoleOutputCP(65001)
	windows.SetConsoleCP(65001)
	k := syscall.NewLazyDLL("kernel32.dll")
	p, _ := syscall.UTF16PtrFromString("Hark 本地文件桥 - 保持此窗口打开")
	k.NewProc("SetConsoleTitleW").Call(uintptr(unsafe.Pointer(p)))
	// 本进程退出（包括被强制结束）时，自动结束它启动的所有子进程（cloudflared）
	if j, err := windows.CreateJobObject(nil, nil); err == nil {
		info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		if _, err := windows.SetInformationJobObject(j, windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err == nil {
			killJob = j
		}
	}
}

func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}

func bindChild(cmd *exec.Cmd) {
	if killJob == 0 || cmd.Process == nil {
		return
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		return
	}
	windows.AssignProcessToJobObject(killJob, h)
	windows.CloseHandle(h)
}

// watchParent 在父进程（Hark 桌面版）退出时调用 onDead
func watchParent(pid int, onDead func()) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		onDead()
		return
	}
	go func() {
		windows.WaitForSingleObject(h, windows.INFINITE)
		windows.CloseHandle(h)
		onDead()
	}()
}
