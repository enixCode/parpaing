<p align="center"><img src="docs/brand/banner.svg" alt="parpaing, the building block for AI agents" width="100%"></p>

# parpaing

**parpaing** (French for *cinder block*): self-hosted sandboxes for AI agents, driven by an HTTP API. Your own machine, only Docker.

Website: <https://parpaing.dev>

> **Stable since 2.0.0.** The API follows semantic versioning: no breaking change before 3.0.0, only new routes and new optional fields. See the [roadmap](ROADMAP.md).

## Features

- **Any image**: a sandbox is a Docker container, even from an image without a shell.
- **Commands**: start one, follow its output live, resume after a cut, stop it and the processes it started.
- **Files**: a folder out as a tar archive, a tar back in.
- **Isolation**: each sandbox alone in its network, internet only through an egress proxy; gVisor (runsc) for a stronger wall.
- **Limits**: memory, CPU, processes and disk per sandbox.
- **Lasting**: commands survive the client and parpaing restarts; sandboxes come back with their files after a reboot.
- **SDK**: TypeScript, no dependency.
- **Self-hosted**: one machine, only Docker, one port, an optional API key.

## Quick start

```sh
curl -O https://raw.githubusercontent.com/enixCode/parpaing/main/compose.yml
docker compose up -d
```

Human digest API demo at <http://127.0.0.1:8090>. The API answers on the same port.

The page creates sandboxes and runs commands in them; each action shows the request, the answer and the matching `curl` command.

The API reference is at <http://127.0.0.1:8090/docs>.

Set `PARPAING_API_KEY` to require `Authorization: Bearer <key>` on every call. Without it, anyone who reaches the port can use the API.

- **Exposed beyond this machine** (`PARPAING_ADDRESS` other than `127.0.0.1`, `localhost`, `::1`): `PARPAING_API_KEY` is required, parpaing does not start without it.
- **Host names**: the gateway answers only for `localhost`, `127.0.0.1` and the names in `PARPAING_HOSTS` (space-separated: a domain, the machine's IP).

## API

| Feature | Endpoint | What it does | Status |
|---|---|---|---|
| Sandboxes (CRUD) | `POST /sandboxes`<br>`GET /sandboxes`<br>`GET /sandboxes/:id`<br>`DELETE /sandboxes/:id` | Create, list, read, remove | 🟢 Done |
| Commands | `POST /sandboxes/:id/commands`<br>`GET /sandboxes/:id/commands`<br>`GET /sandboxes/:id/commands/:cid` | Start a command (its id at once), list, read its state and exit code | 🟢 Done |
| Command output | `GET /sandboxes/:id/commands/:cid/output?from=&follow=` | stdout and stderr live, resumable from any position | 🟢 Done |
| Stop a command | `POST /sandboxes/:id/commands/:cid/stop` | The command and the processes it started (its group, and every process still carrying `PARPAING_EXEC`): SIGTERM, SIGKILL 10 s later | 🟢 Done |
| Info | `GET /info` | Version, engines, capacity, sandbox count | 🟢 Done |
| OpenAPI | `GET /openapi.json` | The API description, generated from the code | 🟢 Done |
| Archives | `GET /sandboxes/:id/archive?path=`<br>`PUT /sandboxes/:id/archive?path=` | Download a folder as a tar, upload one back, streamed (tested with 3 GB). The image needs `tar` | 🟢 Done |
| API key | `Authorization: Bearer <key>` | Optional, with `PARPAING_API_KEY` | 🟢 Done |
| Limits | `POST /sandboxes` + `memory`, `cpus`, `processes`, `disk`, `wait` | Ceilings per sandbox, readable inside with `env`. Disk: enforced on gVisor only | 🟢 Done |
| Network | `POST /sandboxes` + `network` | `internet` through the egress proxy (HTTP, HTTPS, SOCKS5, ssh), or `none` | 🟢 Done |
| Engine | `POST /sandboxes` + `runtime` | `runc` or `runsc` (gVisor), `PARPAING_RUNTIME` for the default | 🟢 Done |

See the details in [ROADMAP.md](ROADMAP.md).

### Commands

- **Started at once**: `POST` answers `201 {id}`; the command runs until it ends or is stopped.
- **Survives the client**: it keeps running when the client leaves or parpaing restarts. A sandbox restart loses it (410).
- **Last 50 finished kept**: past them, the next start removes the oldest finished command (404 after).
- **Output**: one JSON line per piece, `{stream, data, next}`, then one closing line: `{exitCode, next}` once it ended, `{next}` when more may come, `{error, next}` when the link to the sandbox broke.
- **Output kept**: per command, at least the last 50 MiB, at most about 100 MiB.
- **`{skipped, next}`**: a read from before the kept output gets it first (the bytes lost), then the rest from `next`.
- **Resume**: ask again with `from=next`, after a cut or a pause.
- **`follow=true`** waits for more output, until the end or 50 s of silence; without it, the answer stops at what is written.
- **Exact bytes**: the output is UTF-8 text in the API; the sandbox keeps the raw bytes in `/tmp/parpaing/<cid>/stdout` and `stderr`, the previous 50 MiB in `stdout.1` and `stderr.1`, downloadable with the archive route.

| Status | When |
|---|---|
| 400 | Empty command, or a program the sandbox cannot find |
| 404 | Unknown sandbox or command |
| 409 | Sandbox stopped, or its daemon too old for commands (recreate the sandbox) |
| 410 | Command lost when its sandbox restarted (out of memory on gVisor, for instance) |
| 503 | Sandbox at its memory or process limit, or starting; daemon unreachable |

## SDK

TypeScript, no dependency (Node 18+, Deno, Bun, browsers): `npm install parpaing`. Source in [sdk/](sdk/).

```ts
import { Parpaing } from "parpaing";

const parpaing = new Parpaing({ url: "http://127.0.0.1:8090" });
const { id } = await parpaing.create(); // debian:trixie-slim

const { stdout } = await parpaing.exec(id, ["echo", "hello"]);
console.log(stdout); // hello

await parpaing.exec(id, ["sh", "-c", "for i in 1 2 3; do echo $i; sleep 1; done"], {
  onOutput: (data) => process.stdout.write(data), // live
});

await parpaing.delete(id);
```

Save it as `demo.mjs`, then `node demo.mjs`. Background commands, output and stop: [sdk/README.md](sdk/README.md).

## Isolation

| Engine | What it is | For | Status |
|---|---|---|---|
| runc | Docker's default: the sandbox shares the host's kernel | Dev, pre-prod | 🟢 Done |
| runsc (gVisor) | A kernel in Go between the sandbox and the host, on any Linux server, no KVM needed. Enforces the disk limit | Prod | 🟢 Done |
| Kata Containers | A small virtual machine per sandbox, needs KVM | To plan | ⚪ Planned |

To use runsc, install gVisor once per machine; it registers itself in Docker:

```sh
URL=https://storage.googleapis.com/gvisor/releases/release/latest/$(uname -m)
wget $URL/gvisor.tar.zstd $URL/gvisor.tar.zstd.sha512 && sha512sum -c gvisor.tar.zstd.sha512
sudo tar --zstd -xf gvisor.tar.zstd -C /usr/local/bin
sudo runsc install && sudo systemctl restart docker
```

Then ask `"runtime": "runsc"` per sandbox, or set `PARPAING_RUNTIME=runsc` for every sandbox.

Which engine supports what: [docs/runtimes.md](docs/runtimes.md).

## The sandbox daemon

`parpaingd`, a small program brought by parpaing (not by the image), is the main process of every sandbox, from a read-only volume.

- Any image works, even one without a shell or sleep.
- Processes left behind are collected, so they never use up the process limit.
- Signals from inside the sandbox do not end it.
- It runs the commands: each one gets an id and can be stopped with the processes it started.
- It answers on a local socket, from inside the sandbox: `/.parpaing/parpaingd ping` gives `{"ok":true,"version":2,"boot":"<4 hex>"}`.

Next, on top of it:

- **Sessions**: a shell that keeps its folder and variables.
- **File API**: read, write and list files with WebDAV (Explorer, Finder, rclone).
- **Interactive terminal**: live keyboard, resizable.

Planned for 2.x, see the [roadmap](ROADMAP.md).

## How it works

- **A sandbox is a Docker container** labelled `parpaing.sandbox`. Parpaing never touches other containers.
- **Always on**: the container runs the parpaing daemon, mounted read-only, and waits for commands: any image works, even one without a shell. It starts again with Docker, with its files but not its processes.
- **Commands through the daemon**: parpaing reaches it with `docker exec`, never through the network. Details in [DEV.md](DEV.md).
- **Its own network**: each sandbox sits alone in an internal network. Its only way out is the egress proxy (GOST), which refuses the host (its own addresses included, `PARPAING_BLOCK` for others), the local network, cloud metadata and other sandboxes. Programs find it in `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`; ssh with `-o ProxyCommand='nc -X connect -x $PARPAING_PROXY %h %p'`. Programs that ignore proxies (`psql`) need `proxychains` or an ssh tunnel.
- **No state in Parpaing**: Docker keeps everything.
- **One port**: the `gateway` container (nginx) serves the web page and the brand kit, and relays the API. The `parpaing` container also works without the page; sandboxes with internet need the `egress` container.

## Services

<img src="services.svg">

## Contributing

- **Issues are welcome**: bugs, questions, ideas. [Open one](https://github.com/enixCode/parpaing/issues).
- **No pull requests for now.**
- **Running and testing it from the source**: [DEV.md](DEV.md).

## License

The server: [AGPL-3.0](LICENSE). The SDK: [Apache-2.0](sdk/LICENSE).
