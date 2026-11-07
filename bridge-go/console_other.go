//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

func setupConsole()            {}
func hideWindow(cmd *exec.Cmd) {}
func bindChild(cmd *exec.Cmd)  {}

func watchParent(pid int, onDead func()) {
	go func() {
		for {
			time.Sleep(2 * time.Second)
			p, err := os.FindProcess(pid)
			if err != nil || p.Signal(syscall.Signal(0)) != nil || os.Getppid() != pid {
				onDead()
				return
			}
		}
	}()
}
