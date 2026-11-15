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
| Limits | ❓ | ❓ | ❓ | Kata: the limits apply to the virtual machine |
| Back after a restart | ❓ | ❓ | ❓ | |
| Network isolation, egress proxy | ❓ | ❓ | ❓ | gVisor has its own network stack |
| Stop a command | ❓ | ❓ | ❓ | Stops the command and everything it started |
| Archives | ❓ | ❓ | ❓ | runsc: do Docker's archive calls see files written inside gVisor? Kata: the files live in the virtual machine |
| Stop and start | ❓ | ❓ | ❓ | |
| Live resize | ❓ | ❓ | ❓ | Kata: memory and CPU added to a running virtual machine |
| Sandbox daemon, sessions, File API, terminal | ❓ | ❓ | ❓ | Runs inside the sandbox: expected the same everywhere |
| Preview URLs | ❓ | ❓ | ❓ | |
| Disk limit | ❓ | ❓ | ❓ | |
| Snapshots | ❓ | ❓ | ❓ | runsc: does `docker commit` see files written inside gVisor? |
| GPU | ❓ | ❓ | ❓ | |
