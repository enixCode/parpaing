# Roadmap

Every feature, in the order it gets built: what is done, then what comes next, down to the last one.

🟢 Done: works today, can still change before 1.0.0. 🟡 In progress: being built. ⚪ Planned: not started.

Which engine supports what: [docs/runtimes.md](docs/runtimes.md).

## Versions

- **< 1.0.0: everything can still change.** The 0.x versions come out along the way, 0.1.0 first.
- **1.0.0 freezes the API.** It holds what would break clients if added later (the API key, the command stream), plus what makes parpaing safe to run.
- **1.x adds without breaking.** New routes and new optional fields only.
- **2.x, 3.x: later phases.** A new major only comes if a change has to break the API.

## Build order

| # | Feature | What it does | Version | Status |
|---|---|---|---|---|
| 1 | Create, list, read, remove | `POST /sandboxes`, `GET /sandboxes`, `GET /sandboxes/:id`, `DELETE /sandboxes/:id` | < 1.0.0 | 🟢 Done |
| 2 | Any image | Pulled on first use, `debian:trixie-slim` by default | < 1.0.0 | 🟢 Done |
| 3 | Clear image errors | 400 with Docker's reason (not found, private, misspelled) | < 1.0.0 | 🟢 Done |
| 4 | Run a command | `POST /sandboxes/:id/exec`: live output, then the exit code | < 1.0.0 | 🟢 Done |
| 5 | Info | `GET /info`: version, engines, capacity, sandbox count, for a central server | < 1.0.0 | 🟢 Done |
| 6 | This machine only | Port on `127.0.0.1` by default, `PARPAING_ADDRESS` opens it | < 1.0.0 | 🟢 Done |
| 7 | Own containers only | Touches only containers labelled `parpaing.sandbox` | < 1.0.0 | 🟢 Done |
| 8 | runc | Docker's default engine | < 1.0.0 | 🟢 Done |
| 9 | One command | `docker compose up -d` | < 1.0.0 | 🟢 Done |
| 10 | Web page | Try the API at `http://127.0.0.1:8090`, with the `curl` of each request (nginx serves it and relays the API on the same port) | < 1.0.0 | 🟢 Done |
| 11 | API reference | OpenAPI at `/openapi.json`, generated from the code, and a `/docs` page | < 1.0.0 | 🟢 Done |
| 12 | API key | Optional: with `PARPAING_API_KEY`, `Authorization: Bearer <key>` on every call | < 1.0.0 | 🟢 Done |
| 13 | Hardening | Dropped capabilities, no privilege escalation, non-root user | < 1.0.0 | ⚪ Planned |
| 14 | Limits | Memory, CPU and processes, per sandbox | < 1.0.0 | ⚪ Planned |
| 15 | Back after a restart | Sandboxes start again with the machine | < 1.0.0 | ⚪ Planned |
| 16 | Network isolation | No local network, no other sandboxes | < 1.0.0 | ⚪ Planned |
| 17 | Egress proxy | Internet only through a proxy | < 1.0.0 | ⚪ Planned |
| 18 | Command id | First line of the stream: `{"exec": "<id>"}` | < 1.0.0 | ⚪ Planned |
| 19 | Stop a command | `POST /sandboxes/:id/exec/:execId/stop`, with everything it started | < 1.0.0 | ⚪ Planned |
| 20 | Result in one answer | The whole output and the exit code in one JSON | < 1.0.0 | ⚪ Planned |
| 21 | Archives | `GET` and `PUT /sandboxes/:id/archive?path=`: save or restore a folder as a tar. To verify on runsc and Kata first | < 1.0.0 | ⚪ Planned |
| | **🚀 Release 1.0.0** | The API is frozen: from here on, breaking changes only come with a new major | 1.0.0 | ⚪ Planned |
| 22 | Labels | Key-value pairs on a sandbox, and filter the list by label | 1.x | ⚪ Planned |
| 23 | Time to live | Removed after a set time, fixed at creation | 1.x | ⚪ Planned |
| 24 | Stop and start | Pause a sandbox, keep its files | 1.x | ⚪ Planned |
| 25 | Idle stop | Paused after some time without activity | 1.x | ⚪ Planned |
| 26 | Live resize | More memory or CPU for a running sandbox. To verify on runsc and Kata first | 1.x | ⚪ Planned |
| 27 | Key rotation | Two keys accepted at once, to change the key without downtime | 1.x | ⚪ Planned |
| 28 | Sandbox daemon | A small program inside each sandbox, the base of 29 to 31 | 1.x | ⚪ Planned |
| 29 | Sessions | A shell that keeps its folder and variables, background commands | 1.x | ⚪ Planned |
| 30 | File API | Read, write and list files with WebDAV, the standard protocol (Explorer, Finder, WinSCP, rclone), served by the daemon | 1.x | ⚪ Planned |
| 31 | Interactive terminal | Live keyboard, resizable | 1.x | ⚪ Planned |
| 32 | SSH (to decide) | `ssh <id>@host` through a gateway, no SSH server in the sandbox. How, and whether we want it, is still open | 1.x | ⚪ Planned |
| 33 | Allowed domains | Per sandbox, or block everything, fixed at creation | 1.x | ⚪ Planned |
| 34 | Preview URLs | Open a sandbox port in the browser | 1.x | ⚪ Planned |
| 35 | HTTPS | To expose the server safely | 1.x | ⚪ Planned |
| 36 | gVisor (runsc) | Stronger isolation, chosen per sandbox | 1.x | ⚪ Planned |
| 37 | Disk limit | Per sandbox | 1.x | ⚪ Planned |
| 38 | Metrics | Prometheus and OpenTelemetry | 1.x | ⚪ Planned |
| 39 | SDK | TypeScript first, then Python | 1.x | ⚪ Planned |
| 40 | CLI | Drive parpaing from a terminal | 1.x | ⚪ Planned |
| 41 | MCP server | Agents call parpaing directly | 1.x | ⚪ Planned |
| 42 | Snapshots | Turn a sandbox into a reusable image | 2.x | ⚪ Planned |
| 43 | Image builder | Build a sandbox image from code, cached | 2.x | ⚪ Planned |
| 44 | Ready pool | Sandboxes created in advance, for instant starts | 2.x | ⚪ Planned |
| 45 | Code runner | Run Python or JavaScript, keeping state | 2.x | ⚪ Planned |
| 46 | Shared volumes | Storage shared by several sandboxes | 2.x | ⚪ Planned |
| 47 | Artifacts | Collect what an agent produced, with a signed link | 2.x | ⚪ Planned |
| 48 | Secrets | Variables injected without being readable | 2.x | ⚪ Planned |
| 49 | Webhooks | Notify a URL when something happens, best effort | 2.x | ⚪ Planned |
| 50 | Kata Containers | A small VM per sandbox | 2.x | ⚪ Planned |
| 51 | GPU | Graphics cards in a sandbox | 3.x | ⚪ Planned |
| 52 | Desktop | Screen, mouse and keyboard for computer-use agents | 3.x | ⚪ Planned |
| 53 | Private registries | Pull images that need a login, if people ask for it | On request | ⚪ Planned |


