// parpaingd: the sandbox daemon, the main process (PID 1) of every sandbox. parpaing mounts it read-only at
// /.parpaing/parpaingd from the parpaing-daemon volume, so it runs in any image, even one without a shell or sleep.
// As PID 1 it collects the processes left behind, cannot be ended from inside, and answers on a local socket:
// `parpaingd ping` asks it from inside the sandbox. Commands come next.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// An abstract unix socket: a name, not a file, so nothing in the sandbox can remove or replace it, and it needs
// neither /tmp nor write access. The name stays taken while the daemon lives. Each sandbox has its own network
// namespace, so its own name, on runc, runsc and Kata.
const socket = "@parpaingd"

// Goes up when the daemon gains a command. A running sandbox keeps the daemon it started with, while
// `/.parpaing/parpaingd ping` runs the binary of the volume, maybe newer: ping tells what the daemon behind knows.
const version = 1

func main() {
	if len(os.Args) > 1 {
		os.Exit(client(os.Args[1:]))
	}
	// A second daemon started inside the sandbox finds the name taken and stops here.
	listener, err := net.Listen("unix", socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, "parpaingd:", err)
		os.Exit(1)
	}

	// The agent must not end its own sandbox by signalling PID 1: a restart would wipe it on runsc. Linux already drops
	// these signals for a PID 1 without handlers; ignoring them makes it hold on every engine, whatever its kernel does.
	signal.Ignore(syscall.SIGHUP, syscall.SIGINT, syscall.SIGQUIT, syscall.SIGTERM, syscall.SIGUSR1, syscall.SIGUSR2,
		syscall.SIGPIPE, syscall.SIGALRM)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ping", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": version})
	})
	// If the socket ever fails, PID 1 still collects the processes: the sandbox keeps running.
	go func() { fmt.Fprintln(os.Stderr, "parpaingd:", http.Serve(listener, mux)) }()

	children := make(chan os.Signal, 1)
	signal.Notify(children, syscall.SIGCHLD)
	fmt.Println("parpaingd ready")
	for range children {
		reap()
	}
}

// A process whose parent ends is handed to PID 1, and once it ends it stays a zombie, holding its pid against the
// sandbox's process limit, until PID 1 collects it. One SIGCHLD can stand for several ended processes.
func reap() {
	for {
		pid, err := syscall.Wait4(-1, nil, syscall.WNOHANG, nil)
		if err == syscall.EINTR {
			continue
		}
		if pid <= 0 || err != nil {
			return
		}
	}
}

// The client, run inside the sandbox: `parpaingd ping` prints the daemon's answer, exit code 1 if it does not answer.
func client(args []string) int {
	if len(args) != 1 || args[0] != "ping" {
		fmt.Fprintln(os.Stderr, "usage: parpaingd [ping]")
		return 2
	}
	local := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}}
	res, err := local.Get("http://parpaingd/ping")
	if err != nil {
		fmt.Fprintln(os.Stderr, "parpaingd:", err)
		return 1
	}
	defer res.Body.Close()
	if _, err := io.Copy(os.Stdout, res.Body); err != nil || res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
