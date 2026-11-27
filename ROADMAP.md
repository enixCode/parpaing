# Roadmap

Every feature, in the order it gets built: what is done, then what comes next, down to the last one.

🟢 Done: works today. 🟡 In progress: being built. ⚪ Planned: not started.

Which engine supports what: [docs/runtimes.md](docs/runtimes.md).

## Versions

- **Each major freezes the API.** 2.x adds without breaking: new routes and new optional fields only.
- **3.x, 4.x: later phases.** A new major only comes if a change has to break the API.

## Build order

| # | Feature | What it does | Version | Status |
|---|---|---|---|---|
| 1 | Create, list, read, remove | `POST /sandboxes`, `GET /sandboxes`, `GET /sandboxes/:id`, `DELETE /sandboxes/:id` | < 1.0.0 | 🟢 Done |
| 2 | Any image | Pulled on first use, `debian:trixie-slim` by default | < 1.0.0 | 🟢 Done |
| 3 | Clear image errors | 400 with Docker's reason (not found, private, misspelled) | < 1.0.0 | 🟢 Done |
| 4 | Run a command | In the sandbox, its output live, then the exit code | < 1.0.0 | 🟢 Done |
| 5 | Info | `GET /info`: version, engines, capacity, sandbox count, for a central server | < 1.0.0 | 🟢 Done |
| 6 | This machine only | Port on `127.0.0.1` by default, `PARPAING_ADDRESS` opens it | < 1.0.0 | 🟢 Done |
| 7 | Own containers only | Touches only containers labelled `parpaing.sandbox` | < 1.0.0 | 🟢 Done |
| 8 | runc | Docker's default engine | < 1.0.0 | 🟢 Done |
| 9 | One command | `docker compose up -d` | < 1.0.0 | 🟢 Done |
| 10 | Web page | Try the API at `http://127.0.0.1:8090`, with the `curl` of each request (nginx serves it and relays the API on the same port) | < 1.0.0 | 🟢 Done |
| 11 | API reference | OpenAPI at `/openapi.json`, generated from the code, and a `/docs` page | < 1.0.0 | 🟢 Done |
| 12 | API key | Optional: with `PARPAING_API_KEY`, `Authorization: Bearer <key>` on every call | < 1.0.0 | 🟢 Done |
| 13 | Hardening | Root in the sandbox (apt, pip work), with only 9 capabilities: nothing gets the others back | < 1.0.0 | 🟢 Done |
| 14 | Limits | Memory, CPU and processes per sandbox: ceilings, not reservations. A new sandbox is refused (or waits) when the machine lacks free memory | < 1.0.0 | 🟢 Done |
| 15 | Back after a restart | Sandboxes start again with the machine, with their files but not their processes | < 1.0.0 | 🟢 Done |
| 16 | Network isolation | Each sandbox alone in an internal network: no host, no local network, no metadata, no other sandboxes. `network: none` cuts everything | < 1.0.0 | 🟢 Done |
| 17 | Egress proxy | Internet only through a proxy (GOST): HTTP, HTTPS, SOCKS5, ssh | < 1.0.0 | 🟢 Done |
| 18 | Archives | `GET` and `PUT /sandboxes/:id/archive?path=`: a folder out as a tar, a tar back into a folder, made by the sandbox's own `tar` so it works the same on every engine | < 1.0.0 | 🟢 Done |
| 19 | gVisor (runsc) | Stronger isolation: `runtime` per sandbox, `PARPAING_RUNTIME` for the default | < 1.0.0 | 🟢 Done |
| 20 | Disk limit | Per sandbox on runsc, set by parpaing at creation; runc and Kata only record it | < 1.0.0 | 🟢 Done |
| | **🚀 Release 1.0.0** | The API is frozen: from here on, breaking changes only come with a new major | 1.0.0 | 🟢 Done |
| 21 | Sandbox daemon | `parpaingd`, main process of every sandbox from a read-only volume: any image, processes left behind collected. The base of 22 to 24 and 31 to 34 | 1.x | 🟢 Done |
| 22 | Commands | `POST /sandboxes/:id/commands`: an id at once, the command runs on its own, its output read live and resumed with `from` | 2.0.0 | 🟢 Done |
| 23 | Stop a command | By its id, with everything it started: SIGTERM, SIGKILL 10 s later | 2.0.0 | 🟢 Done |
| 24 | Output caps | The last 50 finished commands kept; per command, at least the last 50 MiB of output, at most about 100 MiB: a read from before it starts with a `{skipped, next}` line | 2.0.0 | 🟢 Done |
| | **🚀 Release 2.0.0** | Commands are a resource: started, read and stopped by id | 2.0.0 | 🟢 Done |
| 25 | Labels | Key-value pairs fixed at creation (`labels`), and filter the list with `GET /sandboxes?label=key=value` | 2.1.0 | 🟢 Done |
| 26 | Time to live | Removed after a set time, fixed at creation | 2.x | ⚪ Planned |
| 27 | Stop and start | Pause a sandbox, keep its files | 2.x | ⚪ Planned |
| 28 | Idle stop | Paused after some time without activity | 2.x | ⚪ Planned |
| 29 | Live resize | More memory or CPU for a running sandbox. To verify on runsc and Kata first | 2.x | ⚪ Planned |
| 30 | Key rotation | Two keys accepted at once, to change the key without downtime | 2.x | ⚪ Planned |
| 31 | Sessions | A shell that keeps its folder and variables | 2.x | ⚪ Planned |
| 32 | File API | Read, write and list files with WebDAV, the standard protocol (Explorer, Finder, WinSCP, rclone), served by the daemon | 2.x | ⚪ Planned |
| 33 | Interactive terminal | Live keyboard, resizable | 2.x | ⚪ Planned |
| 34 | Output pool | Per sandbox, 1, 5 or 10 GB of output in all: past it, the least read and oldest commands go first | 2.x | ⚪ Planned |
| 35 | SSH (to decide) | `ssh <id>@host` through a gateway, no SSH server in the sandbox. How, and whether we want it, is still open | 2.x | ⚪ Planned |
| 36 | Allowed domains | Per sandbox, or block everything, fixed at creation | 2.x | ⚪ Planned |
| 37 | Preview URLs | Open a sandbox port in the browser | 2.x | ⚪ Planned |
| 38 | Metrics | Prometheus and OpenTelemetry | 2.x | ⚪ Planned |
| 39 | SDK | TypeScript on npm (`npm install parpaing`), released with each version; Python next | 2.x | 🟡 In progress |
| 40 | CLI | Drive parpaing from a terminal | 2.x | ⚪ Planned |
| 41 | MCP server | Agents call parpaing directly | 2.x | ⚪ Planned |
| 42 | Snapshots | Turn a sandbox into a reusable image | 3.x | ⚪ Planned |
| 43 | Image builder | Build a sandbox image from code, cached | 3.x | ⚪ Planned |
| 44 | Ready pool | Sandboxes created in advance, for instant starts | 3.x | ⚪ Planned |
| 45 | Code runner | Run Python or JavaScript, keeping state | 3.x | ⚪ Planned |
| 46 | Shared volumes | Storage shared by several sandboxes | 3.x | ⚪ Planned |
| 47 | Artifacts | Collect what an agent produced, with a signed link | 3.x | ⚪ Planned |
| 48 | Secrets | Variables injected without being readable | 3.x | ⚪ Planned |
| 49 | Webhooks | Notify a URL when something happens, best effort | 3.x | ⚪ Planned |
| 50 | Kata Containers | A small VM per sandbox | 3.x | ⚪ Planned |
| 51 | GPU | Graphics cards in a sandbox | 4.x | ⚪ Planned |
| 52 | Desktop | Screen, mouse and keyboard for computer-use agents | 4.x | ⚪ Planned |
| 53 | Private registries | Pull images that need a login, if people ask for it | On request | ⚪ Planned |


