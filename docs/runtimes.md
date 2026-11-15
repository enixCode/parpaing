# Engines

Each sandbox runs with an engine (an OCI runtime). parpaing must work with the three below. Today, every sandbox uses runc.

| Engine | What it is |
|---|---|
| runc | Docker's default: the sandbox shares the host's kernel |
| runsc (gVisor) | A kernel written in Go between the sandbox and the host |
| Kata Containers | A small virtual machine per sandbox |

## What works where

✅ tested. ❓ not tested yet. ❌ does not work.

| Feature | runc | runsc | Kata | To check |
|---|---|---|---|---|
| Create, list, read, remove | ✅ | ❓ | ❓ | |
| Any image | ✅ | ❓ | ❓ | Docker pulls the image before the engine starts: expected the same everywhere |
| Run a command | ✅ | ❓ | ❓ | |
| Hardening (9 capabilities) | ✅ | ❓ | ❓ | Both apply Docker's capabilities (gVisor, Kata agent). ping without NET_RAW relies on a kernel setting gVisor may not copy |
| Memory and CPU limits | ✅ | ❓ | ❓ | Kata: the limits apply inside the virtual machine, which costs ~150 to 300 MB more |
| Process limit | ✅ | ❓ | ❓ | runsc: the host limit also counts gVisor's own threads; the host stays protected, the sandbox may crash |
| Back after a restart | ❓ | ❓ | ❓ | |
| Network isolation, egress proxy | ❓ | ❓ | ❓ | gVisor has its own network stack |
| Stop a command | ❓ | ❓ | ❓ | Stops the command and everything it started |
| Archives | ❓ | ❓ | ❓ | runsc: do Docker's archive calls see files written inside gVisor? Kata: the files live in the virtual machine |
| Stop and start | ❓ | ❓ | ❓ | |
| Live resize | ❓ | ❓ | ❓ | Kata: memory and CPU added to a running virtual machine |
| Sandbox daemon, sessions, File API, terminal | ❓ | ❓ | ❓ | Runs inside the sandbox: expected the same everywhere |
| Preview URLs | ❓ | ❓ | ❓ | |
| Disk limit | ❌ | ❓ | ❓ | runc and Kata need host setup (xfs quotas): without it, Docker ignores the size, so parpaing only records it. runsc: gVisor's own `size=` |
| Snapshots | ❓ | ❓ | ❓ | runsc: does `docker commit` see files written inside gVisor? |
| GPU | ❓ | ❓ | ❓ | |
