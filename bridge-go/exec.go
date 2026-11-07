package main

// 命令执行与截图：默认关闭。exec_mode = off | confirm | auto
// confirm：每条命令都要用户在电脑上点「允许」（桌面版弹窗 / 独立版控制台输入 y）。

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	execMode     string
	alwaysAllow  bool
	confirmMu    sync.Mutex // 一次只弹一个确认
	pendingMu    sync.Mutex
	pending      = map[string]chan string{}
	stdinStarted sync.Once
	stdinLines   = make(chan string, 16)
	jobsMu       sync.Mutex
	jobs         = map[string]*bgJob{}
	jobSeq       int
	execLogMu    sync.Mutex
)

type capBuf struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (c *capBuf) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buf = append(c.buf, p...)
	if len(c.buf) > c.max {
		c.buf = c.buf[len(c.buf)-c.max:]
	}
	return len(p), nil
}
func (c *capBuf) String() string { c.mu.Lock(); defer c.mu.Unlock(); return string(c.buf) }

type bgJob struct {
	ID      string
	Command string
	Cmd     *exec.Cmd
	Out     *capBuf
	Started time.Time
	Done    bool
	Exit    int
}

func initExec() {
	execMode = strings.ToLower(strings.TrimSpace(cfg.ExecMode))
	if v := os.Getenv("HARK_BRIDGE_EXEC_MODE"); v != "" {
		execMode = strings.ToLower(strings.TrimSpace(v))
	}
	if execMode != "confirm" && execMode != "auto" {
		execMode = "off"
	}
	stdinStarted.Do(func() {
		go func() {
			sc := bufio.NewScanner(os.Stdin)
			for sc.Scan() {
				line := strings.TrimSpace(sc.Text())
				if strings.HasPrefix(line, "CONFIRM ") {
					f := strings.Fields(line)
					if len(f) == 3 {
						pendingMu.Lock()
						ch := pending[f[1]]
						pendingMu.Unlock()
						if ch != nil {
							select {
							case ch <- f[2]:
							default:
							}
						}
					}
					continue
				}
				if strings.HasPrefix(line, "EXECMODE ") {
					m := strings.TrimSpace(strings.TrimPrefix(line, "EXECMODE "))
					if m == "off" || m == "confirm" || m == "auto" {
						execMode = m
						alwaysAllow = false
						logf("命令执行模式：%s", m)
					}
					continue
				}
				select {
				case stdinLines <- line:
				default:
				}
			}
		}()
	})
}

func execToolDefs() []map[string]any {
	if execMode == "off" {
		return nil
	}
	note := ""
	if execMode == "confirm" {
		note = " The user must approve each call on their computer; a denial returns an error."
	}
	return []map[string]any{
		{"name": "run_command", "description": "Run a command on the user's computer (Windows PowerShell by default) and return its exit code and output. For long-running programs use start_background." + note,
			"inputSchema": schema(map[string]any{
				"command":     str("The command line to run."),
				"shell":       str("powershell (default) or cmd."),
				"cwd":         str("Working directory: relative to the shared folder, or an absolute path. Default: the shared folder."),
				"timeout_sec": integer("Default 120, max 1800."),
			}, "command")},
		{"name": "start_background", "description": "Start a long-running command in the background (dev server, build, watcher). Returns a job id; read output with job_output." + note,
			"inputSchema": schema(map[string]any{"command": str("The command line."), "shell": str("powershell (default) or cmd."), "cwd": str("Working directory, as for run_command.")}, "command")},
		{"name": "job_output", "description": "Status, exit code and recent output of a background job.",
			"inputSchema": schema(map[string]any{"job_id": str("Job id."), "tail_chars": integer("Characters from the end, default 8000.")}, "job_id")},
		{"name": "job_stop", "description": "Stop a background job and its child processes.",
			"inputSchema": schema(map[string]any{"job_id": str("Job id.")}, "job_id")},
		{"name": "list_jobs", "description": "List background jobs started in this session.", "inputSchema": schema(map[string]any{})},
		{"name": "screenshot", "description": "Capture the user's screen to a PNG inside the shared folder (.scratch/screens/) and return its relative path; read it with read_file_base64." + note,
			"inputSchema": schema(map[string]any{})},
	}
}

func isExecTool(n string) bool {
	switch n {
	case "run_command", "start_background", "job_output", "job_stop", "list_jobs", "screenshot":
		return true
	}
	return false
}

func execLog(s string) {
	execLogMu.Lock()
	defer execLogMu.Unlock()
	f, err := os.OpenFile(filepath.Join(dataDir, "hark-bridge-commands.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err == nil {
		fmt.Fprintf(f, "[%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), s)
		f.Close()
	}
}

func approve(kind, command, cwd string) error {
	if execMode == "off" {
		return errors.New("command execution is turned off on this computer")
	}
	if execMode == "auto" || alwaysAllow {
		return nil
	}
	confirmMu.Lock()
	defer confirmMu.Unlock()
	if alwaysAllow {
		return nil
	}
	id := randHex(6)
	ans := ""
	if embedded {
		ch := make(chan string, 1)
		pendingMu.Lock()
		pending[id] = ch
		pendingMu.Unlock()
		payload, _ := json.Marshal(map[string]string{"kind": kind, "command": command, "cwd": cwd})
		logMu.Lock()
		fmt.Printf("HARK_BRIDGE_CONFIRM=%s %s\n", id, base64.StdEncoding.EncodeToString(payload))
		logMu.Unlock()
		select {
		case ans = <-ch:
		case <-time.After(120 * time.Second):
			ans = "timeout"
		}
		pendingMu.Lock()
		delete(pending, id)
		pendingMu.Unlock()
	} else {
		logMu.Lock()
		fmt.Printf("\n==== Hark 请求在本机执行命令 ====\n目录: %s\n命令: %s\n输入 y = 一直允许，其他 = 不允许（选择会被记住；120 秒超时）：", cwd, command)
		logMu.Unlock()
		select {
		case l := <-stdinLines:
			switch strings.ToLower(l) {
			case "y", "yes", "a", "always":
				ans = "always"
			default:
				ans = "deny"
			}
		case <-time.After(120 * time.Second):
			ans = "timeout"
			fmt.Println("\n超时，已拒绝。")
		}
	}
	switch ans {
	case "allow":
		return nil
	case "always":
		alwaysAllow = true
		if !embedded {
			execMode, cfg.ExecMode = "auto", "auto"
			saveConfig(cfgPath)
		}
		return nil
	case "timeout":
		execLog("超时未确认: " + command)
		return errors.New("the user did not approve within 120 seconds")
	default:
		if !embedded {
			execMode, cfg.ExecMode = "off", "off"
			saveConfig(cfgPath)
		}
		execLog("用户拒绝: " + command)
		return errors.New("the user denied this command")
	}
}

func resolveCwd(c string) (string, error) {
	if strings.TrimSpace(c) == "" {
		return rootDir, nil
	}
	if filepath.IsAbs(c) {
		if st, err := os.Stat(c); err != nil || !st.IsDir() {
			return "", fmt.Errorf("cwd not found: %s", c)
		}
		return c, nil
	}
	return resolve(c)
}

func buildCmd(command, shellName, cwd string) *exec.Cmd {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		if strings.EqualFold(shellName, "cmd") {
			cmd = exec.Command("cmd.exe", "/d", "/s", "/c", "chcp 65001>nul & "+command)
		} else {
			pre := "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';"
			cmd = exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", pre+command)
		}
	} else {
		cmd = exec.Command("/bin/sh", "-c", command)
	}
	cmd.Dir = cwd
	cmd.Stdin = nil
	hideWindow(cmd)
	return cmd
}

func killTreeProc(p *os.Process) {
	if p == nil {
		return
	}
	if runtime.GOOS == "windows" {
		k := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(p.Pid))
		hideWindow(k)
		k.Run()
	}
	p.Kill()
}

func runExecTool(name string, a map[string]any) (string, error) {
	switch name {
	case "run_command":
		command := argStr(a, "command")
		if strings.TrimSpace(command) == "" {
			return "", errors.New("command is required")
		}
		cwd, err := resolveCwd(argStr(a, "cwd"))
		if err != nil {
			return "", err
		}
		if err := approve("执行命令", command, cwd); err != nil {
			return "", err
		}
		to := argInt(a, "timeout_sec", 120)
		if to < 1 {
			to = 120
		}
		if to > 1800 {
			to = 1800
		}
		execLog("run: " + command + "  @ " + cwd)
		logf("执行命令: %s", command)
		cmd := buildCmd(command, argStr(a, "shell"), cwd)
		out := &capBuf{max: 200000}
		cmd.Stdout, cmd.Stderr = out, out
		start := time.Now()
		if err := cmd.Start(); err != nil {
			return "", err
		}
		bindChild(cmd)
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		timedOut := false
		select {
		case <-done:
		case <-time.After(time.Duration(to) * time.Second):
			timedOut = true
			killTreeProc(cmd.Process)
			<-done
		}
		code := -1
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		var b bytes.Buffer
		fmt.Fprintf(&b, "exit_code: %d\nduration: %.1fs\n", code, time.Since(start).Seconds())
		if timedOut {
			fmt.Fprintf(&b, "timed_out: true (killed after %ds)\n", to)
		}
		o := out.String()
		if len(o) >= 200000 {
			b.WriteString("(output truncated to last 200000 bytes)\n")
		}
		b.WriteString("--- output ---\n")
		b.WriteString(o)
		return b.String(), nil

	case "start_background":
		command := argStr(a, "command")
		if strings.TrimSpace(command) == "" {
			return "", errors.New("command is required")
		}
		cwd, err := resolveCwd(argStr(a, "cwd"))
		if err != nil {
			return "", err
		}
		if err := approve("后台运行", command, cwd); err != nil {
			return "", err
		}
		execLog("bg: " + command + "  @ " + cwd)
		logf("后台运行: %s", command)
		cmd := buildCmd(command, argStr(a, "shell"), cwd)
		out := &capBuf{max: 1 << 20}
		cmd.Stdout, cmd.Stderr = out, out
		if err := cmd.Start(); err != nil {
			return "", err
		}
		bindChild(cmd)
		jobsMu.Lock()
		jobSeq++
		j := &bgJob{ID: fmt.Sprintf("job%d", jobSeq), Command: command, Cmd: cmd, Out: out, Started: time.Now()}
		jobs[j.ID] = j
		jobsMu.Unlock()
		go func() {
			cmd.Wait()
			jobsMu.Lock()
			j.Done = true
			j.Exit = cmd.ProcessState.ExitCode()
			jobsMu.Unlock()
		}()
		return fmt.Sprintf("job_id: %s\npid: %d", j.ID, cmd.Process.Pid), nil

	case "job_output", "job_stop":
		jobsMu.Lock()
		j := jobs[argStr(a, "job_id")]
		jobsMu.Unlock()
		if j == nil {
			return "", errors.New("no such job")
		}
		if name == "job_stop" {
			killTreeProc(j.Cmd.Process)
			execLog("stop: " + j.ID)
			return "stopped " + j.ID, nil
		}
		tail := argInt(a, "tail_chars", 8000)
		o := j.Out.String()
		if tail > 0 && len(o) > tail {
			o = o[len(o)-tail:]
		}
		jobsMu.Lock()
		st := "running"
		if j.Done {
			st = fmt.Sprintf("exited (code %d)", j.Exit)
		}
		jobsMu.Unlock()
		return fmt.Sprintf("job: %s\nstatus: %s\ncommand: %s\n--- output (tail) ---\n%s", j.ID, st, j.Command, o), nil

	case "list_jobs":
		jobsMu.Lock()
		defer jobsMu.Unlock()
		if len(jobs) == 0 {
			return "(no jobs)", nil
		}
		var b strings.Builder
		for id, j := range jobs {
			st := "running"
			if j.Done {
				st = fmt.Sprintf("exited %d", j.Exit)
			}
			fmt.Fprintf(&b, "%s  %s  %s  %s\n", id, st, j.Started.Format("15:04:05"), j.Command)
		}
		return b.String(), nil

	case "screenshot":
		if runtime.GOOS != "windows" {
			return "", errors.New("screenshot is only supported on Windows")
		}
		if err := approve("截取屏幕", "screenshot", rootDir); err != nil {
			return "", err
		}
		rel := filepath.ToSlash(filepath.Join(".scratch", "screens", time.Now().Format("20060102-150405")+".png"))
		full := filepath.Join(rootDir, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(full), 0o755)
		ps := `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
			`Add-Type 'using System;using System.Runtime.InteropServices;public class D{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}';[D]::SetProcessDPIAware()|Out-Null;` +
			`$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;` +
			`$g=[System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);` +
			`$bmp.Save('` + strings.ReplaceAll(full, "'", "''") + `',[System.Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$bmp.Dispose()`
		cmd := buildCmd(ps, "powershell", rootDir)
		if out, err := cmd.CombinedOutput(); err != nil {
			return "", fmt.Errorf("screenshot failed: %v %s", err, string(out))
		}
		execLog("screenshot: " + rel)
		return rel, nil
	}
	return "", errors.New("unknown tool")
}
