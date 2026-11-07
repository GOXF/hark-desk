package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// startNgrok runs the official ngrok agent (ngrok.exe) to expose the local bridge on a fixed domain.
// The embedded ngrok-go SDK registered sessions that ngrok's edge reported as offline (ERR_NGROK_3200),
// while the official agent works, so we drive the agent binary like cloudflared.
// Note: the free plan forbids running the agent through an explicit http/s proxy (ERR_NGROK_9009),
// so proxy variables are removed from the agent's environment.
func startNgrok(ctx context.Context, port int) (*exec.Cmd, string) {
	tok := strings.TrimSpace(cfg.NgrokAuthtoken)
	if tok == "" {
		fmt.Println("ngrok：未设置 authtoken，改用 Cloudflare 临时通道。")
		return nil, ""
	}
	dom := strings.TrimSpace(cfg.NgrokDomain)
	dom = strings.TrimPrefix(strings.TrimPrefix(dom, "https://"), "http://")
	dom = strings.TrimRight(strings.TrimSuffix(strings.TrimRight(dom, "/"), "/mcp"), "/")

	bin, err := findOrDownloadNgrok()
	if err != nil {
		fmt.Println("ngrok：找不到 ngrok 程序，且下载失败：", err)
		return nil, ""
	}
	ngDir := filepath.Join(dataDir, "ngrok")
	os.MkdirAll(ngDir, 0o755)
	conf := filepath.Join(ngDir, "ngrok.yml")
	os.WriteFile(conf, []byte("version: \"3\"\n"), 0o600)

	args := []string{"http", fmt.Sprintf("127.0.0.1:%d", port), "--config", conf, "--log", "stdout", "--log-format", "json"}
	if dom != "" {
		args = append(args, "--url", "https://"+dom)
	}
	cmd := exec.CommandContext(ctx, bin, args...)
	env := []string{}
	for _, e := range os.Environ() {
		k := strings.ToUpper(strings.SplitN(e, "=", 2)[0])
		if k == "HTTP_PROXY" || k == "HTTPS_PROXY" || k == "ALL_PROXY" || strings.HasPrefix(k, "NGROK_") || strings.HasPrefix(k, "HARK_BRIDGE_NGROK") {
			continue
		}
		env = append(env, e)
	}
	cmd.Env = append(env, "NGROK_AUTHTOKEN="+tok)
	hideWindow(cmd)
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		fmt.Println("ngrok 启动失败：", err)
		return nil, ""
	}
	bindChild(cmd)

	found := make(chan string, 1)
	failed := make(chan string, 1)
	var once sync.Once
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			var m map[string]any
			if json.Unmarshal([]byte(line), &m) != nil {
				continue
			}
			msg, _ := m["msg"].(string)
			lvl, _ := m["lvl"].(string)
			if msg == "started tunnel" {
				if u, _ := m["url"].(string); u != "" {
					select {
					case found <- u:
					default:
					}
				}
			}
			if lvl == "eror" || lvl == "crit" {
				e, _ := m["err"].(string)
				if e == "" {
					e = msg
				}
				e = strings.ReplaceAll(e, tok, "***")
				logf("ngrok: %s", firstLine(e))
				if lvl == "crit" || strings.Contains(e, "ERR_NGROK_") {
					once.Do(func() { failed <- e })
				}
			}
		}
		once.Do(func() { failed <- "ngrok 进程已退出" })
	}()
	select {
	case u := <-found:
		return cmd, u
	case e := <-failed:
		explainNgrokErr(e)
	case <-time.After(40 * time.Second):
		fmt.Println("ngrok：40 秒内未就绪。")
	}
	if cmd.Process != nil {
		cmd.Process.Kill()
	}
	return nil, ""
}

func firstLine(s string) string {
	if i := strings.IndexAny(s, "\r\n"); i > 0 {
		code := ""
		if j := strings.Index(s, "ERR_NGROK_"); j >= 0 {
			code = s[j:]
			if k := strings.IndexAny(code, " \r\n;\"\\"); k > 0 {
				code = code[:k]
			}
		}
		return strings.TrimSpace(s[:i]) + " " + code
	}
	return s
}

func explainNgrokErr(e string) {
	switch {
	case strings.Contains(e, "ERR_NGROK_105") || strings.Contains(e, "ERR_NGROK_107"):
		fmt.Println("ngrok：authtoken 无效，请在设置里重新粘贴。", firstLine(e))
	case strings.Contains(e, "ERR_NGROK_108"):
		fmt.Println("ngrok：免费账号同时只能开一个 ngrok，另一台电脑或另一个程序正在用这个账号。", firstLine(e))
	case strings.Contains(e, "ERR_NGROK_9009"):
		fmt.Println("ngrok：免费账号不允许通过 http 代理连接 ngrok。请关闭 ngrok.yml 里的 proxy_url 或用 TUN/直连。", firstLine(e))
	case strings.Contains(e, "ERR_NGROK_320") || strings.Contains(e, "ERR_NGROK_313") || strings.Contains(e, "ERR_NGROK_15013"):
		fmt.Println("ngrok：域名不属于这个账号或填写有误。", firstLine(e))
	case strings.Contains(e, "ERR_NGROK_334"):
		fmt.Println("ngrok：这个域名已经在别处在线（同一账号另一个 ngrok 正在用）。", firstLine(e))
	default:
		fmt.Println("ngrok 启动失败：", firstLine(e))
	}
}

func findOrDownloadNgrok() (string, error) {
	name := "ngrok"
	if runtime.GOOS == "windows" {
		name = "ngrok.exe"
	}
	for _, p := range []string{filepath.Join(exeDir, name), filepath.Join(dataDir, "ngrok", name)} {
		if st, err := os.Stat(p); err == nil && st.Size() > 1<<20 {
			return p, nil
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p, nil
	}
	plat := map[string]string{
		"windows/amd64": "windows-amd64", "windows/arm64": "windows-arm64", "windows/386": "windows-386",
		"darwin/amd64": "darwin-amd64", "darwin/arm64": "darwin-arm64",
		"linux/amd64": "linux-amd64", "linux/arm64": "linux-arm64",
	}[runtime.GOOS+"/"+runtime.GOARCH]
	if plat == "" {
		return "", fmt.Errorf("不支持的平台 %s/%s", runtime.GOOS, runtime.GOARCH)
	}
	ext := "zip"
	if strings.HasPrefix(plat, "linux") {
		ext = "tgz"
	}
	u := "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-" + plat + "." + ext
	fmt.Println("首次使用固定地址：正在下载 ngrok 官方程序（约 10 MB）……")
	cl := &http.Client{Timeout: 3 * time.Minute} // honours HTTPS_PROXY for the download
	resp, err := cl.Get(u)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("下载返回 %s", resp.Status)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	dir := filepath.Join(dataDir, "ngrok")
	os.MkdirAll(dir, 0o755)
	dst := filepath.Join(dir, name)
	if ext == "zip" {
		zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return "", err
		}
		for _, f := range zr.File {
			if strings.EqualFold(filepath.Base(f.Name), name) {
				rc, err := f.Open()
				if err != nil {
					return "", err
				}
				b, err := io.ReadAll(rc)
				rc.Close()
				if err != nil {
					return "", err
				}
				if err := os.WriteFile(dst+".tmp", b, 0o755); err != nil {
					return "", err
				}
				os.Rename(dst+".tmp", dst)
				return dst, nil
			}
		}
		return "", fmt.Errorf("压缩包里没有 %s", name)
	}
	tmp := filepath.Join(dir, "ngrok.tgz")
	os.WriteFile(tmp, data, 0o644)
	if out, err := exec.Command("tar", "xzf", tmp, "-C", dir).CombinedOutput(); err != nil {
		return "", fmt.Errorf("解压失败: %v %s", err, out)
	}
	os.Remove(tmp)
	return dst, nil
}
