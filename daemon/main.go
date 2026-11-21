// parpaingd: the sandbox daemon, the main process (PID 1) of every sandbox. parpaing mounts it read-only at
// /.parpaing/parpaingd from the parpaing-daemon volume, so it runs in any image, even one without a shell or sleep.
// As PID 1 it collects the processes left behind, cannot be ended from inside, and answers on a local socket:
// `parpaingd ping` asks it from inside the sandbox, and it runs commands in the background (exec.go).
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
const version = 2

func main() {
	// Non-dumpable, in every mode: the agent runs as the same user but cannot open /proc/<pid>/fd of the daemon or of a
	// relay, so it never reaches the output files, pipes or socket through them.
	syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_SET_DUMPABLE, 0, 0)
	if len(os.Args) > 1 {
		os.Exit(client(os.Args[1:]))
	}
	// A second daemon started inside the sandbox finds the name taken and stops here.
	listener, err := net.Listen("unix", socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, "parpaingd:", err)
		os.Exit(1)
	}
	// Only once the socket is ours: a second daemon must not wipe the outputs of the first.
	os.RemoveAll(outputDir)

	// The agent must not end its own sandbox by signalling PID 1: a restart would wipe it on runsc. Linux already drops
	// these signals for a PID 1 without handlers; catching and dropping them makes it hold on every engine, whatever its
	// kernel does. Caught, not ignored: exec resets a handler but keeps an ignored signal, and commands must still die on
	// SIGTERM (stop) and SIGPIPE.
	signal.Notify(make(chan os.Signal, 1), syscall.SIGHUP, syscall.SIGINT, syscall.SIGQUIT, syscall.SIGTERM,
		syscall.SIGUSR1, syscall.SIGUSR2, syscall.SIGPIPE, syscall.SIGALRM)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /ping", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": version})
	})
	cmds := newTable()
	mux.HandleFunc("POST /commands", cmds.start)
	mux.HandleFunc("GET /commands", cmds.list)
	mux.HandleFunc("GET /commands/{id}", cmds.read)
	mux.HandleFunc("GET /commands/{id}/output", cmds.output)
	mux.HandleFunc("POST /commands/{id}/stop", cmds.stop)
	// If the socket ever fails, PID 1 still collects the processes: the sandbox keeps running.
	go func() { fmt.Fprintln(os.Stderr, "parpaingd:", http.Serve(listener, mux)) }()

	children := make(chan os.Signal, 1)
	signal.Notify(children, syscall.SIGCHLD)
	fmt.Println("parpaingd ready")
	for range children {
		cmds.reap()
	}
}

// A process whose parent ends is handed to PID 1, and once it ends it stays a zombie, holding its pid against the
// sandbox's process limit, until PID 1 collects it. One SIGCHLD can stand for several ended processes. The status of a
// command's main process goes to that command; the others are dropped.
func (t *table) reap() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if err == syscall.EINTR {
			continue
		}
		if pid <= 0 || err != nil {
			return
		}
		if c := t.byPid[pid]; c != nil {
			delete(t.byPid, pid)
			c.finish(status)
		}
	}
}

// The client, run inside the sandbox: `parpaingd ping` prints the daemon's answer, exit code 1 if it does not answer.
// `parpaingd relay` joins stdin and stdout to the socket: parpaing, in another network namespace, speaks HTTP to the
// daemon through it with docker exec.
func client(args []string) int {
	if len(args) == 1 && args[0] == "relay" {
		return relay()
	}
	if len(args) != 1 || args[0] != "ping" {
		fmt.Fprintln(os.Stderr, "usage: parpaingd [ping | relay]")
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

// Exit code 3 when nothing listens: the daemon behind is older than its socket, and parpaing tells it apart.
func relay() int {
	conn, err := net.Dial("unix", socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, "parpaingd:", err)
		return 3
	}
	// No half-close when stdin ends: Go's server takes it for a client gone and would cancel a follow. Every request carries
	// its length, and a parpaing that leaves shows up at the next write to stdout (within the 50 s idle line at most).
	go io.Copy(conn, os.Stdin)
	io.Copy(os.Stdout, conn)
	return 0
}
