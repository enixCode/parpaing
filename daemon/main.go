// parpaingd: the sandbox daemon, the main process (PID 1) of every sandbox. parpaing mounts it read-only at
// /.parpaing/parpaingd from the parpaing-daemon volume, so it runs in any image, even one without a shell or sleep.
// As PID 1 it collects the processes left behind and cannot be ended from inside; the local socket and commands come next.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	// The agent must not end its own sandbox by signalling PID 1: a restart would wipe it on runsc. Linux already drops
	// these signals for a PID 1 without handlers; ignoring them makes it hold on every engine, whatever its kernel does.
	signal.Ignore(syscall.SIGHUP, syscall.SIGINT, syscall.SIGQUIT, syscall.SIGTERM, syscall.SIGUSR1, syscall.SIGUSR2,
		syscall.SIGPIPE, syscall.SIGALRM)

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
