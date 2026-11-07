// Hark Local Bridge: a portable MCP (streamable HTTP) file server that shares ONE folder
// with Hark, protected by a bearer token, optionally exposed through a Cloudflare quick tunnel.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const version = "1.4.1"

type Config struct {
	SharedFolder string `json:"shared_folder"`
	Token        string `json:"token"`
	Port         int    `json:"port"`
	ReadOnly     bool   `json:"read_only"`
	Tunnel       string `json:"tunnel"`     // "cloudflare" (default) or "none"
	PublicURL    string `json:"public_url"` // set manually when tunnel = none and you use your own tunnel
	AllowDelete  bool   `json:"allow_delete"`
	CFProtocol   string `json:"cf_protocol"` // http2 (default, TCP) or quic or auto
	ExecMode     string `json:"exec_mode"`   // off (default) | confirm | auto
	NgrokAuthtoken string `json:"ngrok_authtoken,omitempty"` // tunnel = ngrok
	NgrokDomain    string `json:"ngrok_domain,omitempty"`    // e.g. xxx.ngrok-free.dev (fixed address)
}

var (
	cfg      Config
	rootDir  string
	exeDir   string
	dataDir  string
	embedded bool
	cfgPath  string
	logMu    sync.Mutex
)

func logf(format string, a ...any) {
	logMu.Lock()
	defer logMu.Unlock()
	fmt.Printf("[%s] %s\n", time.Now().Format("15:04:05"), fmt.Sprintf(format, a...))
}

func main() {
	setupConsole()
	exe, _ := os.Executable()
	exe, _ = filepath.EvalSymlinks(exe)
	exeDir = filepath.Dir(exe)
	dataDir = exeDir
	if h := os.Getenv("HARK_BRIDGE_HOME"); h != "" {
		os.MkdirAll(h, 0o755)
		dataDir = h
	}
	embedded = os.Getenv("HARK_BRIDGE_EMBEDDED") == "1"
	cfgPath = filepath.Join(dataDir, "hark-bridge-config.json")

	fmt.Println("==============================================")
	fmt.Println("  Hark 本地文件桥 (Hark Local Bridge) v" + version)
	fmt.Println("==============================================")

	loadConfig(cfgPath)
	if len(os.Args) > 1 && strings.TrimSpace(os.Args[1]) != "" {
		cfg.SharedFolder = cleanInputPath(os.Args[1])
	}
	if cfg.SharedFolder == "" {
		if embedded {
			fatal("no shared folder configured")
		}
		cfg.SharedFolder = askFolder()
	}
	abs, err := filepath.Abs(cfg.SharedFolder)
	if err == nil {
		cfg.SharedFolder = abs
	}
	if err := os.MkdirAll(cfg.SharedFolder, 0o755); err != nil {
		fatal("无法创建/访问共享文件夹: " + err.Error())
	}
	rootDir, err = filepath.EvalSymlinks(cfg.SharedFolder)
	if err != nil {
		fatal("共享文件夹无效: " + err.Error())
	}
	if cfg.Token == "" {
		b := make([]byte, 24)
		rand.Read(b)
		cfg.Token = "hark_" + hex.EncodeToString(b)
	}
	if cfg.Port == 0 {
		cfg.Port = 17890
	}
	if cfg.Tunnel == "" {
		cfg.Tunnel = "cloudflare"
	}
	saveConfig(cfgPath)
	// 内嵌模式由桌面端通过环境变量传入（不写进配置文件）
	if v := os.Getenv("HARK_BRIDGE_TUNNEL"); v != "" {
		cfg.Tunnel = v
	}
	if v := os.Getenv("HARK_BRIDGE_NGROK_AUTHTOKEN"); v != "" {
		cfg.NgrokAuthtoken = v
	}
	if v := os.Getenv("HARK_BRIDGE_NGROK_DOMAIN"); v != "" {
		cfg.NgrokDomain = v
	}
	if v := os.Getenv("HARK_BRIDGE_ALLOW_DELETE"); v != "" {
		cfg.AllowDelete = v == "1"
	}
	if v := os.Getenv("HARK_BRIDGE_READONLY"); v != "" {
		cfg.ReadOnly = v == "1"
	}
	if v := os.Getenv("HARK_BRIDGE_PORT"); v != "" {
		fmt.Sscan(v, &cfg.Port)
	}
	initExec()

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.Port))
	if err != nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fatal("无法监听本地端口: " + err.Error())
		}
	}
	port := ln.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", handleMCP)
	mux.HandleFunc("/mcp/", handleRoute) // v1.4：/mcp/<桥名> 转发到同机的其他文件桥
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, "Hark Local Bridge is running. MCP endpoint: /mcp")
	})
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 15 * time.Second}
	go srv.Serve(ln)

	fmt.Println()
	fmt.Println("共享文件夹 :", rootDir)
	if cfg.ReadOnly {
		fmt.Println("模式       : 只读")
	} else {
		fmt.Println("模式       : 可读写")
	}
	fmt.Printf("本地地址   : http://127.0.0.1:%d/mcp\n", port)
	fmt.Printf("HARK_BRIDGE_PORT=%d\n", port)
	fmt.Println("命令执行   :", map[string]string{"off": "关闭", "confirm": "每条命令需确认", "auto": "自动执行（不确认）"}[execMode])

	ctx, cancel := context.WithCancel(context.Background())
	var tunnelCmd *exec.Cmd
	publicURL := cfg.PublicURL
	fixedURL := false
	var ngrokCmd *exec.Cmd
	ngrokClose := func() {
		if ngrokCmd != nil && ngrokCmd.Process != nil {
			ngrokCmd.Process.Kill()
		}
	}
	if cfg.Tunnel == "ngrok" {
		fmt.Println("正在开启固定地址通道（ngrok）……")
		ngrokCmd, publicURL = startNgrok(ctx, port)
		if publicURL != "" {
			fixedURL = true
			fmt.Println("TUNNEL=ngrok")
		} else {
			fmt.Println("ngrok 未成功，改用 Cloudflare 临时通道（地址会变化）。")
			fmt.Println("TUNNEL=cloudflare-fallback")
			cfg.Tunnel = "cloudflare"
		}
	}
	if cfg.Tunnel == "cloudflare" {
		fmt.Println("正在开启加密通道（Cloudflare），通常需要 5-20 秒……")
		tunnelCmd, publicURL = startCloudflared(ctx, port)
	}
	printConnectionInfo(publicURL, fixedURL)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	if pp := os.Getenv("HARK_BRIDGE_PARENT_PID"); pp != "" {
		var ppid int
		if _, err := fmt.Sscan(pp, &ppid); err == nil && ppid > 0 {
			watchParent(ppid, func() {
				// 父进程已退出：先结束通道（此时 stdout 可能已断开，不再打印）
				if tunnelCmd != nil && tunnelCmd.Process != nil {
					tunnelCmd.Process.Kill()
				}
				ngrokClose()
				select {
				case sig <- os.Interrupt:
				default:
				}
			})
		}
	}
	<-sig
	fmt.Println("\n正在关闭……")
	cancel()
	ngrokClose()
	if tunnelCmd != nil && tunnelCmd.Process != nil {
		tunnelCmd.Process.Kill()
	}
	srv.Close()
}

func fatal(msg string) {
	fmt.Println("错误:", msg)
	if embedded {
		fmt.Println("HARK_BRIDGE_ERROR=" + msg)
		os.Exit(1)
	}
	fmt.Println("按回车键退出。")
	bufio.NewReader(os.Stdin).ReadString('\n')
	os.Exit(1)
}

func cleanInputPath(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "\"'")
	s = strings.ReplaceAll(s, "\\ ", " ") // macOS drag-and-drop escapes spaces
	if strings.HasPrefix(s, "~") {
		if h, err := os.UserHomeDir(); err == nil {
			s = filepath.Join(h, s[1:])
		}
	}
	return s
}

func askFolder() string {
	def := filepath.Join(dataDir, "shared")
	fmt.Println()
	fmt.Println("请选择要共享给 Hark 的文件夹（Hark 只能访问这个文件夹里的内容）。")
	fmt.Println("把文件夹拖进这个窗口，或粘贴路径，然后按回车。")
	fmt.Println("直接按回车则使用默认文件夹:", def)
	fmt.Print("> ")
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	line = cleanInputPath(line)
	if line == "" {
		return def
	}
	return line
}

func loadConfig(p string) {
	b, err := os.ReadFile(p)
	if err != nil {
		return
	}
	json.Unmarshal(b, &cfg)
}

func saveConfig(p string) {
	b, _ := json.MarshalIndent(cfg, "", "  ")
	os.WriteFile(p, b, 0o600)
}

var tryCF = regexp.MustCompile(`https://[a-zA-Z0-9-]+\.trycloudflare\.com`)

func startCloudflared(ctx context.Context, port int) (*exec.Cmd, string) {
	name := "cloudflared"
	if runtime.GOOS == "windows" {
		name = "cloudflared.exe"
	}
	bin := filepath.Join(exeDir, name)
	if _, err := os.Stat(bin); err != nil {
		if p, err2 := exec.LookPath(name); err2 == nil {
			bin = p
		} else {
			fmt.Println("未找到 cloudflared，跳过加密通道。请把 cloudflared 放在本程序同一目录。")
			return nil, ""
		}
	}
	proto := cfg.CFProtocol
	if proto == "" {
		proto = "http2"
	}
	cmd := exec.CommandContext(ctx, bin, "tunnel", "--no-autoupdate", "--protocol", proto, "--url", fmt.Sprintf("http://127.0.0.1:%d", port))
	hideWindow(cmd)
	stderr, _ := cmd.StderrPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		fmt.Println("cloudflared 启动失败:", err)
		return nil, ""
	}
	bindChild(cmd)
	found := make(chan string, 1)
	var logLines []string
	var llMu sync.Mutex
	scan := func(r io.Reader) {
		sc := bufio.NewScanner(r)
		for sc.Scan() {
			t := sc.Text()
			llMu.Lock()
			if len(logLines) < 200 {
				logLines = append(logLines, t)
			}
			llMu.Unlock()
			if m := tryCF.FindString(t); m != "" && !strings.Contains(m, "api.trycloudflare") {
				select {
				case found <- m:
				default:
				}
			}
		}
	}
	go scan(stderr)
	go scan(stdout)
	select {
	case u := <-found:
		// give the edge a moment to register the hostname
		time.Sleep(3 * time.Second)
		return cmd, u
	case <-time.After(60 * time.Second):
		fmt.Println("加密通道 60 秒内未就绪。可能是网络无法连接 Cloudflare。最后的日志:")
		llMu.Lock()
		start := 0
		if len(logLines) > 8 {
			start = len(logLines) - 8
		}
		for _, l := range logLines[start:] {
			fmt.Println("   ", l)
		}
		llMu.Unlock()
		return cmd, ""
	}
}

func printConnectionInfo(publicURL string, fixed bool) {
	var sb strings.Builder
	sb.WriteString("\n================ 连接信息 ================\n")
	if publicURL != "" {
		u := strings.TrimRight(publicURL, "/")
		if !strings.HasSuffix(u, "/mcp") {
			u += "/mcp"
		}
		sb.WriteString("① 地址（直接发给 Hark）:\n   " + u + "\n\n")
	} else {
		sb.WriteString("① 地址: 加密通道未开启，Hark 暂时无法连接。\n\n")
	}
	sb.WriteString("② 密钥（不要发在聊天里，用 Hark 弹出的安全表单填写）:\n   " + cfg.Token + "\n\n")
	sb.WriteString("保持此窗口开着，Hark 才能访问共享文件夹。关闭窗口即断开。\n")
	if fixed {
		sb.WriteString("这是固定地址（ngrok），重启后不变，只需告诉 Hark 一次。\n")
	} else {
		sb.WriteString("注意：每次重新启动，地址会变化，需要把新地址告诉 Hark；密钥不变。\n")
	}
	sb.WriteString("==========================================\n")
	fmt.Print(sb.String())
	if publicURL != "" {
		u := strings.TrimRight(publicURL, "/")
		if !strings.HasSuffix(u, "/mcp") {
			u += "/mcp"
		}
		fmt.Println("HARK_BRIDGE_URL=" + u)
	} else {
		fmt.Println("HARK_BRIDGE_URL=")
	}
	if fixed {
		fmt.Println("HARK_BRIDGE_FIXED=1")
	} else {
		fmt.Println("HARK_BRIDGE_FIXED=0")
	}
	fmt.Println("HARK_BRIDGE_TOKEN=" + cfg.Token)
	fmt.Println("HARK_BRIDGE_FOLDER=" + rootDir)
	os.WriteFile(filepath.Join(dataDir, "连接信息.txt"), []byte(sb.String()), 0o600)
}

// ---------------- MCP ----------------

type rpcReq struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcErr struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResp struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcErr         `json:"error,omitempty"`
}

func authorized(r *http.Request) bool {
	h := r.Header.Get("Authorization")
	tok := ""
	if strings.HasPrefix(strings.ToLower(h), "bearer ") {
		tok = strings.TrimSpace(h[7:])
	}
	if tok == "" {
		tok = r.Header.Get("X-Api-Key")
	}
	return tok != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(cfg.Token)) == 1
}

// paused：桌面端在数据目录放了 paused 文件（用这个桥的账号都关了文件桥）。每次请求都看，不用重启。
func paused() bool {
	_, err := os.Stat(filepath.Join(dataDir, "paused"))
	return err == nil
}

func handleMCP(w http.ResponseWriter, r *http.Request) {
	if !authorized(r) {
		logf("拒绝了一次未授权访问 (%s)", r.Header.Get("Cf-Connecting-Ip"))
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if paused() {
		logf("文件桥已在 Hark Hub 里关闭，拒绝了一次调用")
		http.Error(w, "file bridge is switched off in Hark Hub", http.StatusForbidden)
		return
	}
	switch r.Method {
	case http.MethodGet:
		http.Error(w, "SSE stream not supported", http.StatusMethodNotAllowed)
		return
	case http.MethodDelete:
		w.WriteHeader(http.StatusOK)
		return
	case http.MethodPost:
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		http.Error(w, "bad body", 400)
		return
	}
	body = []byte(strings.TrimSpace(string(body)))
	var reqs []rpcReq
	batch := len(body) > 0 && body[0] == '['
	if batch {
		if err := json.Unmarshal(body, &reqs); err != nil {
			writeJSON(w, rpcResp{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcErr{-32700, "parse error"}})
			return
		}
	} else {
		var one rpcReq
		if err := json.Unmarshal(body, &one); err != nil {
			writeJSON(w, rpcResp{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcErr{-32700, "parse error"}})
			return
		}
		reqs = []rpcReq{one}
	}
	var out []rpcResp
	for _, q := range reqs {
		if len(q.ID) == 0 || string(q.ID) == "null" {
			continue // notification or response
		}
		out = append(out, dispatch(q))
	}
	if len(out) == 0 {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	if r.Header.Get("Mcp-Session-Id") == "" {
		w.Header().Set("Mcp-Session-Id", randHex(16))
	} else {
		w.Header().Set("Mcp-Session-Id", r.Header.Get("Mcp-Session-Id"))
	}
	if batch {
		writeJSON(w, out)
	} else {
		writeJSON(w, out[0])
	}
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

var supportedVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

func dispatch(q rpcReq) rpcResp {
	resp := rpcResp{JSONRPC: "2.0", ID: q.ID}
	switch q.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(q.Params, &p)
		v := supportedVersions[0]
		for _, s := range supportedVersions {
			if s == p.ProtocolVersion {
				v = s
			}
		}
		resp.Result = map[string]any{
			"protocolVersion": v,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": "hark-local-bridge", "version": version},
			"instructions":    "Files live in the user's shared folder on their computer. All paths are relative to that folder.",
		}
		logf("Hark 已连接")
	case "ping":
		resp.Result = map[string]any{}
	case "tools/list":
		resp.Result = map[string]any{"tools": toolDefs()}
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(q.Params, &p); err != nil {
			resp.Error = &rpcErr{-32602, "invalid params"}
			return resp
		}
		text, isErr := callTool(p.Name, p.Arguments)
		resp.Result = map[string]any{
			"content": []map[string]any{{"type": "text", "text": text}},
			"isError": isErr,
		}
	default:
		resp.Error = &rpcErr{-32601, "method not found: " + q.Method}
	}
	return resp
}

func schema(props map[string]any, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
func boolean(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}
func integer(desc string) map[string]any {
	return map[string]any{"type": "integer", "description": desc}
}

func toolDefs() []map[string]any {
	rel := "Path relative to the shared folder ('.' is the folder itself)."
	tools := []map[string]any{
		{"name": "list_directory", "description": "List files and folders in a directory of the shared folder.",
			"inputSchema": schema(map[string]any{"path": str(rel), "recursive": boolean("List all nested entries."), "max_entries": integer("Default 500.")})},
		{"name": "read_text_file", "description": "Read a UTF-8 text file. Optionally a line range.",
			"inputSchema": schema(map[string]any{"path": str(rel), "start_line": integer("1-based first line, optional."), "max_lines": integer("Optional line limit.")}, "path")},
		{"name": "read_file_base64", "description": "Read any file (binary ok, up to 25 MB) as base64.",
			"inputSchema": schema(map[string]any{"path": str(rel)}, "path")},
		{"name": "file_info", "description": "Size, type and modified time of a path.",
			"inputSchema": schema(map[string]any{"path": str(rel)}, "path")},
		{"name": "search_files", "description": "Find files whose name matches a glob (e.g. *.md) and/or whose text contains a string.",
			"inputSchema": schema(map[string]any{"path": str("Directory to search, default '.'."), "name_glob": str("Glob on file name, optional."), "contains": str("Case-insensitive text to find inside files, optional."), "max_results": integer("Default 200.")})},
	}
	if !cfg.ReadOnly {
		tools = append(tools,
			map[string]any{"name": "write_text_file", "description": "Create or overwrite (or append to) a UTF-8 text file. Parent folders are created.",
				"inputSchema": schema(map[string]any{"path": str(rel), "content": str("Text to write."), "append": boolean("Append instead of overwrite.")}, "path", "content")},
			map[string]any{"name": "edit_text_file", "description": "Replace an exact string in a text file (must match exactly once unless replace_all).",
				"inputSchema": schema(map[string]any{"path": str(rel), "old_string": str("Exact text to find."), "new_string": str("Replacement."), "replace_all": boolean("Replace every match.")}, "path", "old_string", "new_string")},
			map[string]any{"name": "write_file_base64", "description": "Create or overwrite a binary file from base64 (e.g. PDF, docx, images).",
				"inputSchema": schema(map[string]any{"path": str(rel), "base64": str("Base64 file content.")}, "path", "base64")},
			map[string]any{"name": "create_directory", "description": "Create a folder (and parents).",
				"inputSchema": schema(map[string]any{"path": str(rel)}, "path")},
			map[string]any{"name": "move_path", "description": "Move or rename a file or folder inside the shared folder.",
				"inputSchema": schema(map[string]any{"source": str(rel), "destination": str(rel), "overwrite": boolean("Replace an existing destination file.")}, "source", "destination")},
		)
		if cfg.AllowDelete {
			tools = append(tools, map[string]any{"name": "delete_path", "description": "Delete a file, or a folder with recursive=true.",
				"inputSchema": schema(map[string]any{"path": str(rel), "recursive": boolean("Required to delete a non-empty folder.")}, "path")})
		}
	}
	tools = append(tools, execToolDefs()...)
	return tools
}

// resolve maps a user path into the shared folder and refuses anything outside it.
func resolve(p string) (string, error) {
	if p == "" {
		p = "."
	}
	p = filepath.FromSlash(strings.ReplaceAll(p, "\\", "/"))
	var full string
	if filepath.IsAbs(p) {
		full = filepath.Clean(p)
	} else {
		full = filepath.Join(rootDir, p)
	}
	// Evaluate symlinks on the deepest existing ancestor.
	existing := full
	rest := ""
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			break
		}
		rest = filepath.Join(filepath.Base(existing), rest)
		existing = parent
	}
	real, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return "", err
	}
	real = filepath.Join(real, rest)
	if !within(real, rootDir) {
		return "", errors.New("path is outside the shared folder")
	}
	return real, nil
}

func within(p, root string) bool {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		p, root = strings.ToLower(p), strings.ToLower(root)
	}
	if p == root {
		return true
	}
	return strings.HasPrefix(p, strings.TrimRight(root, string(filepath.Separator))+string(filepath.Separator))
}

func relOf(p string) string {
	r, err := filepath.Rel(rootDir, p)
	if err != nil {
		return p
	}
	return filepath.ToSlash(r)
}

func argStr(a map[string]any, k string) string {
	if v, ok := a[k].(string); ok {
		return v
	}
	return ""
}
func argBool(a map[string]any, k string) bool {
	v, _ := a[k].(bool)
	return v
}
func argInt(a map[string]any, k string, def int) int {
	switch v := a[k].(type) {
	case float64:
		return int(v)
	case string:
		var n int
		if _, err := fmt.Sscan(v, &n); err == nil {
			return n
		}
	}
	return def
}

func callTool(name string, a map[string]any) (string, bool) {
	if a == nil {
		a = map[string]any{}
	}
	res, err := runTool(name, a)
	if err != nil {
		logf("%s 失败: %v", name, err)
		return "Error: " + err.Error(), true
	}
	return res, false
}

func runTool(name string, a map[string]any) (string, error) {
	writeTools := map[string]bool{"write_text_file": true, "edit_text_file": true, "write_file_base64": true, "create_directory": true, "move_path": true, "delete_path": true}
	if writeTools[name] && cfg.ReadOnly {
		return "", errors.New("bridge is in read-only mode")
	}
	if isExecTool(name) {
		if execMode == "off" {
			return "", errors.New("command execution is turned off on this computer")
		}
		return runExecTool(name, a)
	}
	switch name {
	case "list_directory":
		dir, err := resolve(argStr(a, "path"))
		if err != nil {
			return "", err
		}
		max := argInt(a, "max_entries", 500)
		var lines []string
		if argBool(a, "recursive") {
			filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
				if err != nil || p == dir {
					return nil
				}
				if len(lines) >= max {
					return filepath.SkipAll
				}
				lines = append(lines, entryLine(p, d))
				return nil
			})
		} else {
			ents, err := os.ReadDir(dir)
			if err != nil {
				return "", err
			}
			for _, d := range ents {
				if len(lines) >= max {
					break
				}
				lines = append(lines, entryLine(filepath.Join(dir, d.Name()), d))
			}
		}
		logf("列出目录 %s", relOf(dir))
		if len(lines) == 0 {
			return "(empty)", nil
		}
		return strings.Join(lines, "\n"), nil
	case "read_text_file":
		p, err := resolve(argStr(a, "path"))
		if err != nil {
			return "", err
		}
		st, err := os.Stat(p)
		if err != nil {
			return "", err
		}
		if st.Size() > 20<<20 {
			return "", errors.New("file larger than 20 MB; use a line range or read_file_base64")
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return "", err
		}
		s := string(b)
		start := argInt(a, "start_line", 0)
		maxL := argInt(a, "max_lines", 0)
		if start > 0 || maxL > 0 {
			ls := strings.Split(s, "\n")
			if start < 1 {
				start = 1
			}
			if start > len(ls) {
				return "", fmt.Errorf("file has only %d lines", len(ls))
			}
			end := len(ls)
			if maxL > 0 && start-1+maxL < end {
				end = start - 1 + maxL
			}
			s = strings.Join(ls[start-1:end], "\n")
		}
		logf("读取 %s", relOf(p))
		return s, nil
	case "read_file_base64":
		p, err := resolve(argStr(a, "path"))
		if err != nil {
			return "", err
		}
		st, err := os.Stat(p)
		if err != nil {
			return "", err
		}
		if st.Size() > 25<<20 {
			return "", errors.New("file larger than 25 MB")
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return "", err
		}
		logf("读取(二进制) %s", relOf(p))
		return base64.StdEncoding.EncodeToString(b), nil
	case "file_info":
		p, err := resolve(argStr(a, "path"))
		if err != nil {
			return "", err
		}
		st, err := os.Stat(p)
		if err != nil {
			return "", err
		}
		kind := "file"
		if st.IsDir() {
			kind = "directory"
		}
		return fmt.Sprintf("path: %s\ntype: %s\nsize: %d bytes\nmodified: %s", relOf(p), kind, st.Size(), st.ModTime().Format(time.RFC3339)), nil
	case "search_files":
		dir, err := resolve(argStr(a, "path"))
		if err != nil {
			return "", err
		}
		glob := argStr(a, "name_glob")
		contains := strings.ToLower(argStr(a, "contains"))
		max := argInt(a, "max_results", 200)
		var hits []string
		filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if len(hits) >= max {
				return filepath.SkipAll
			}
			if glob != "" {
				if ok, _ := filepath.Match(strings.ToLower(glob), strings.ToLower(d.Name())); !ok {
					return nil
				}
			}
			if contains != "" {
				info, err := d.Info()
				if err != nil || info.Size() > 10<<20 {
					return nil
				}
				b, err := os.ReadFile(p)
				if err != nil || !strings.Contains(strings.ToLower(string(b)), contains) {
					return nil
				}
			}
			hits = append(hits, relOf(p))
			return nil
		})
		sort.Strings(hits)
		if len(hits) == 0 {
			return "(no matches)", nil
		}
		return strings.Join(hits, "\n"), nil
	case "write_text_file":
		p, err := resolve(argStr(a, "path"))
		if err != nil {
			return "", err
		}
		if p == rootDir {
			return "", errors.New("path must be a file")
		}
		os.MkdirAll(filepath.Dir(p), 0o755)
		content := argStr(a, "content")
		if argBool(a, "append") {
			f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
			if err != nil {
				return "", err
			}
			defer f.Close()
			if _, err := f.WriteString(content); err != nil {
				return "", err
			}
		} else if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			return "", err
		}
		logf("写入 %s", relOf(p))
		return fmt.Sprintf("wrote %d bytes to %s", len(content), relOf(p)), nil
	case "edit_text_file":
		p, err := resolve(argStr(a, "path"))
		if err != nil {
			return "", err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return "", err
		}
		s := string(b)
		old, nw := argStr(a, "old_string"), argStr(a, "new_string")
		if old == "" {
			return "", errors.New("old_string is empty")
		}
		n := strings.Count(s, old)
		if n == 0 {
			return "", errors.New("old_string not found")
		}
		if n > 1 && !argBool(a, "replace_all") {
			return "", fmt.Errorf("old_string matches %d times; add context or set replace_all", n)
		}
		s = strings.ReplaceAll(s, old, nw)
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			return "", err
		}
		logf("修改 %s", relOf(p))
		return fmt.Sprintf("replaced %d occurrence(s) in %s", n, relOf(p)), nil
	case "write_file_base64":
		p, err := resolve(argStr(a, "path"))
		if err != nil {
			return "", err
		}
		if p == rootDir {
			return "", errors.New("path must be a file")
		}
		b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(argStr(a, "base64")))
		if err != nil {
			return "", errors.New("invalid base64")
		}
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, b, 0o644); err != nil {
			return "", err
		}
		logf("写入(二进制) %s", relOf(p))
		return fmt.Sprintf("wrote %d bytes to %s", len(b), relOf(p)), nil
	case "create_directory":
		p, err := resolve(argStr(a, "path"))
		if err != nil {
			return "", err
		}
		if err := os.MkdirAll(p, 0o755); err != nil {
			return "", err
		}
		logf("新建文件夹 %s", relOf(p))
		return "created " + relOf(p), nil
	case "move_path":
		src, err := resolve(argStr(a, "source"))
		if err != nil {
			return "", err
		}
		dst, err := resolve(argStr(a, "destination"))
		if err != nil {
			return "", err
		}
		if src == rootDir || dst == rootDir {
			return "", errors.New("cannot move the shared folder itself")
		}
		if _, err := os.Stat(dst); err == nil && !argBool(a, "overwrite") {
			return "", errors.New("destination exists; set overwrite=true")
		}
		os.MkdirAll(filepath.Dir(dst), 0o755)
		if err := os.Rename(src, dst); err != nil {
			return "", err
		}
		logf("移动 %s -> %s", relOf(src), relOf(dst))
		return "moved to " + relOf(dst), nil
	case "delete_path":
		if !cfg.AllowDelete {
			return "", errors.New("delete is disabled")
		}
		p, err := resolve(argStr(a, "path"))
		if err != nil {
			return "", err
		}
		if p == rootDir {
			return "", errors.New("cannot delete the shared folder itself")
		}
		if argBool(a, "recursive") {
			err = os.RemoveAll(p)
		} else {
			err = os.Remove(p)
		}
		if err != nil {
			return "", err
		}
		logf("删除 %s", relOf(p))
		return "deleted " + relOf(p), nil
	}
	return "", errors.New("unknown tool: " + name)
}

func entryLine(p string, d fs.DirEntry) string {
	if d.IsDir() {
		return "[DIR]  " + relOf(p) + "/"
	}
	info, err := d.Info()
	size := int64(0)
	mod := ""
	if err == nil {
		size = info.Size()
		mod = info.ModTime().Format("2006-01-02 15:04")
	}
	return fmt.Sprintf("[FILE] %s  (%d bytes, %s)", relOf(p), size, mod)
}
