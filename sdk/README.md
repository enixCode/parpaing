# parpaing SDK

The TypeScript client for [parpaing](https://github.com/enixCode/parpaing): self-hosted sandboxes for AI agents. No dependency, only fetch and web streams: Node 18+, Deno, Bun, browsers.

```sh
npm install parpaing
```

```ts
import { Parpaing } from "parpaing";
import { setTimeout as sleep } from "node:timers/promises";

const parpaing = new Parpaing({ url: "http://127.0.0.1:8090" });
const { id } = await parpaing.create(); // debian:trixie-slim

// 1. Run a command, get its result
const { stdout } = await parpaing.exec(id, ["echo", "hello"]);
console.log(stdout); // hello

// 2. Watch the output live
await parpaing.exec(id, ["sh", "-c", "for i in 1 2 3; do echo $i; sleep 1; done"], {
  onOutput: (data) => process.stdout.write(data),
});

// 3. Start in the background, read what it printed, stop it
const { id: cid } = await parpaing.start(id, ["sh", "-c", "while true; do date; sleep 1; done"]);
await sleep(3000);
await parpaing.output(id, cid, { onOutput: (data) => process.stdout.write(data) });
await parpaing.stop(id, cid);

await parpaing.delete(id);
```

- **Run it**: save it as `demo.mjs`, then `node demo.mjs`.
- **With an API key**: `new Parpaing({ url: "http://127.0.0.1:8090", key: process.env.PARPAING_API_KEY })`.

| Method | Route | Returns |
|---|---|---|
| `info()` | `GET /info` | Version, engines, capacity, sandbox count |
| `create(options?)` | `POST /sandboxes` | The sandbox and its limits |
| `list()` | `GET /sandboxes` | `[{ id, state }]` |
| `get(id)` | `GET /sandboxes/:id` | The sandbox and its limits |
| `delete(id)` | `DELETE /sandboxes/:id` | |
| `exec(id, cmd)` | `start`, then `output` with `follow` to the end | `{ exitCode, stdout, stderr, skipped? }` |
| `exec(id, cmd, { onOutput })` | the same | `{ exitCode, skipped? }`, the output live |
| `start(id, cmd)` | `POST /sandboxes/:id/commands` | `{ id }`, at once |
| `commands(id)` | `GET /sandboxes/:id/commands` | `[{ id, cmd, state, exitCode }]`, the running and the last 50 finished |
| `command(id, cid)` | `GET /sandboxes/:id/commands/:cid` | `{ id, cmd, state, exitCode, outputSize }` |
| `output(id, cid, { from, follow, onOutput })` | `GET /sandboxes/:id/commands/:cid/output` | `{ exitCode?, next, skipped? }`, each piece to `onOutput` |
| `stop(id, cid)` | `POST /sandboxes/:id/commands/:cid/stop` | SIGTERM, SIGKILL 10 s later |
| `readFolder(id, path)` | `GET /sandboxes/:id/archive` | The folder as a tar stream |
| `writeFolder(id, path, tar)` | `PUT /sandboxes/:id/archive` | The tar (bytes, Blob or stream) unpacked in the folder |

- **`image`**: any image Docker can pull, `debian:trixie-slim` by default: `node:24`, `user/image:tag`, `ghcr.io/owner/image:tag`.
- **Refusals** throw a `ParpaingError` with the API's `status` and message.
- **Errors while reading output**: the `ParpaingError` carries `next`, the position to resume from with `from`.
- **`exec`** resumes by itself after a network failure or a 5xx answer, never after another error.
- **`exec` without `onOutput`** keeps at most the last 10 MiB of each stream.
- **`onOutput` errors** reach the caller unchanged and are not retried.
- **`output`** resumes where an earlier read stopped with `from: next`; `exitCode` comes once the output is finished.
- **`skipped`**: the bytes of output not in the result: those the daemon no longer kept, when a read started before them, plus those the SDK dropped. A command keeps at least its last 50 MiB of output, at most about 100 MiB.
- **`signal`** on `exec` and `output` stops reading, not the command: `stop` ends it.

## License

[Apache-2.0](LICENSE). The parpaing server is AGPL-3.0.
