# Engines

Each sandbox runs with an engine (an OCI runtime), chosen with `runtime` or `PARPAING_RUNTIME`. parpaing must work with the three below.

| Engine | What it is |
|---|---|
| runc | Docker's default: the sandbox shares the host's kernel |
| runsc (gVisor) | A kernel written in Go between the sandbox and the host |
| Kata Containers | A small virtual machine per sandbox |

## What works where

✅ tested. ❓ not tested yet. ❌ does not work. runc and runsc: the API tests run on both in CI.

| Feature | runc | runsc | Kata | To check |
|---|---|---|---|---|
| Create, list, read, remove | ✅ | ✅ | ❓ | |
| Any image | ✅ | ✅ | ❓ | Docker pulls the image before the engine starts: expected the same everywhere |
| Run a command | ✅ | ✅ | ❓ | |
| Hardening (9 capabilities) | ✅ | ✅ | ❓ | runsc: the same 9 capabilities (`0x200004fb`), apt and ping work |
| Memory and CPU limits | ✅ | ✅ | ❓ | runsc: free shows the memory limit; past its memory, the whole sandbox stops (Docker starts it again), not one process. Kata: the limits apply inside the virtual machine, which costs ~150 to 300 MB more |
| Process limit | ✅ | ❓ | ❓ | runsc: the limit also counts gVisor's own threads. A thread bomb without a memory cap froze the test VM: to test again with parpaing's memory cap |
| Back after a restart | ✅ | ❓ | ❓ | Docker restarts the sandbox on every engine. runsc: files written outside volumes live in gVisor's overlay and are probably lost |
| Network isolation, egress proxy | ❓ | ❓ | ❓ | gVisor has its own network stack |
| Stop a command | ❓ | ❓ | ❓ | Stops the command and everything it started |
| Archives | ✅ | ✅ | ❓ | The sandbox's own `tar` runs through exec |
| Stop and start | ❓ | ❓ | ❓ | |
| Live resize | ❓ | ❓ | ❓ | Kata: memory and CPU added to a running virtual machine |
| Sandbox daemon, sessions, File API, terminal | ❓ | ❓ | ❓ | Runs inside the sandbox: expected the same everywhere |
| Preview URLs | ❓ | ❓ | ❓ | |
| Disk limit | ❌ | ✅ | ❓ | runc and Kata need host setup (xfs quotas): without it, Docker ignores the size, so parpaing only records it. runsc: parpaing sets gVisor's overlay size per sandbox by annotation; writes stop at exactly the size |
| Snapshots | ❓ | ❓ | ❓ | runsc: does `docker commit` see files written inside gVisor? |
| GPU | ❓ | ❓ | ❓ | |
