# Developing parpaing

A few commands per part. Needs Docker; Node 26 for the tests; Go only through Docker. The commands are for a POSIX shell: on Windows, Git Bash with `MSYS_NO_PATHCONV=1` set, or WSL.

## Run it from the source

```sh
npm ci
docker compose up -d --build        # the three images, the daemon compiled in parpaing's
docker compose logs -f parpaing     # the API's log
```

Page on <http://127.0.0.1:8090>, API reference on `/docs`.

## Test

```sh
npm run typecheck                   # the API, the tests and the SDK as built for npm
npm test                            # every test in tests/, against http://127.0.0.1:8090
PARPAING_URL=http://127.0.0.1:18092 npm test        # against another parpaing
PARPAING_API_KEY=… npm test                         # when parpaing runs with a key
```

On a full machine (refuses new sandboxes):

```sh
PARPAING_RESERVED_MEMORY=99999999 docker compose up -d parpaing
PARPAING_TEST_SATURATED=1 node --test tests/saturated.test.ts
docker compose up -d parpaing       # back to normal
```

On runsc (gVisor installed, see README):

```sh
PARPAING_RUNTIME=runsc docker compose up -d
PARPAING_RUNTIME=runsc npm test
```

## Try a change without replacing your running parpaing

A second API on port 18092, sharing Docker, the egress proxy and the daemon volume:

```sh
docker build -t parpaing-dev .
docker run -d --name parpaing-dev --network parpaing_default -p 127.0.0.1:18092:8090 \
  -v /var/run/docker.sock:/var/run/docker.sock -v parpaing-daemon:/daemon parpaing-dev
PARPAING_URL=http://127.0.0.1:18092 npm test
docker rm -f parpaing-dev
```

The gateway is not in front: the test of `/docs` security headers fails there, and only there.

## The sandbox daemon (daemon/, Go)

```sh
docker run --rm -v "$PWD/daemon:/src" -w /src golang:1.27-trixie \
  sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go test ./... && go build -o /tmp/parpaingd .'
docker compose up -d --build parpaing   # rebuilds it; parpaing copies it into the parpaing-daemon volume
```

- New sandboxes get the new binary; a running one keeps its own until it restarts.
- In a sandbox: `docker logs <id>` shows `parpaingd ready`; `docker exec <id> /.parpaing/parpaingd ping` gives `{"ok":true,"version":2}`.
- `version` goes up when the daemon gains a command: a running sandbox keeps the daemon it started with.

## Commands: the path to the daemon

parpaing (Docker's network) cannot reach a sandbox's socket, so each call goes:

```
parpaing -> docker exec <sandbox> /.parpaing/parpaingd relay -> @parpaingd (abstract unix socket) -> parpaingd, PID 1
```

- **The relay** joins the exec's stdin and stdout to the socket; parpaing speaks plain HTTP through it (`src/relay.ts`, `daemon/main.go`).
- **Hostile answers**: the agent can write into the relay's output. parpaing reads at most 1 MiB per JSON answer or per output line, 10 s for a non-stream answer, and only the known fields go on.
- **Non-dumpable**: the daemon and the relay, so the agent (no `CAP_SYS_PTRACE`) cannot open their descriptors.
- **Exit code 3** of the relay: nothing listens on the socket, a daemon older than commands (409).

What the daemon does (`daemon/exec.go`):

- **Output files**: each piece, byte for byte, in `/tmp/parpaing/<cid>/stdout` or `stderr`, with its place in the arrival order.
- **Generations**: once `stdout` and `stderr` hold 50 MiB together, the next write renames them `stdout.1` and `stderr.1` (the older `.1` goes) and starts new ones. Positions never reset.
- **Index**: one entry per run of one stream in one generation: a write of the same stream extends the last entry, so the index grows only when the stream changes.
- **Skipped**: a position before the oldest kept generation gets `{skipped, next}`, then the output from that generation's start.
- **Locking**: write, rotation and each line's read happen under the command's lock; lines go to the network after it is released.
- **Eviction**: at each start, past 50 finished commands, the oldest go with their folder; their readers end with `{next}`, then 404.
- **Lines**: at most 64 KiB, cut on character boundaries, from one index entry.
- **End of `follow`**: at the main process's exit, after a 200 ms drain; what its children write later stays readable with `from`.
- **Pause**: `{next}` after 50 s without output. The gateway holds 1 h of silence.
- **Stop**: SIGTERM to the command's process group and to processes carrying `PARPAING_EXEC=<cid>`, SIGKILL 10 s later; `exitCode` = 128 + signal.
- **SDK `exec`** reads with `follow` and resumes by itself: undici, Node's fetch, cuts a body after 5 min without data.

## The SDK (sdk/)

```sh
cd sdk
npm run build                       # dist/: JavaScript and types
npm pack --dry-run                  # what npm would get: 5 files
```

Its tests are `tests/sdk.test.ts`, run by `npm test`.

## Sandboxes by hand

```sh
docker ps --filter label=parpaing.sandbox        # every sandbox
curl -X DELETE http://127.0.0.1:8090/sandboxes/<id>
```

## Workflows

```sh
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7 -no-color
```

## Release

1. Same version in three places: `npm version X.Y.Z --no-git-tag-version`, `sdk/package.json`, the three images in `compose.yml`.
2. Pull request, CI green on runc and runsc, merge.
3. `git tag -a vX.Y.Z -m "vX.Y.Z"` on main, then `git push origin vX.Y.Z`: `release.yml` checks the versions, pushes the images to GHCR and the SDK to npm (trusted publishing, no token).
4. `gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes>`: notes written by hand, with no link (no `--generate-notes`, it adds some).
