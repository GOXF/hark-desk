package main

// v1.4 多文件桥：一个通道（固定地址），按路径 /mcp/<桥名> 转发到本机其他文件桥进程。
// 路由表由桌面端写入 HARK_BRIDGE_ROUTES_FILE（JSON：{"桥名": 端口}），每次请求按修改时间重新读取，
// 新增/删除桥不需要重启通道。密钥由各个子桥自己校验。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

var (
	routesMu    sync.Mutex
	routesMtime time.Time
	routes      = map[string]int{}
	routeNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
)

func loadRoutes() map[string]int {
	f := os.Getenv("HARK_BRIDGE_ROUTES_FILE")
	if f == "" {
		return nil
	}
	routesMu.Lock()
	defer routesMu.Unlock()
	st, err := os.Stat(f)
	if err != nil {
		routes = map[string]int{}
		return routes
	}
	if !st.ModTime().Equal(routesMtime) {
		b, err := os.ReadFile(f)
		if err == nil {
			m := map[string]int{}
			if json.Unmarshal(b, &m) == nil {
				routes = m
				routesMtime = st.ModTime()
			}
		}
	}
	return routes
}

func handleRoute(w http.ResponseWriter, r *http.Request) {
	name := strings.Trim(strings.TrimPrefix(r.URL.Path, "/mcp/"), "/")
	name = strings.ToLower(name)
	if !routeNameRe.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	port, ok := loadRoutes()[name]
	if !ok || port <= 0 {
		http.Error(w, "bridge not found: "+name, http.StatusNotFound)
		return
	}
	target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
	rp := httputil.NewSingleHostReverseProxy(target)
	orig := rp.Director
	rp.Director = func(q *http.Request) {
		orig(q)
		q.URL.Path = "/mcp"
		q.URL.RawPath = ""
		q.Host = target.Host
	}
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		logf("转发到文件桥 %s 失败: %v", name, err)
		http.Error(w, "bridge "+name+" is offline", http.StatusBadGateway)
	}
	rp.ServeHTTP(w, r)
}
