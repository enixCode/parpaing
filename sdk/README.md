# parpaing SDK

The TypeScript client for [parpaing](https://github.com/enixCode/parpaing): self-hosted sandboxes for AI agents. No dependency, only fetch and web streams: Node 18+, Deno, Bun, browsers.

```sh
npm install parpaing
```

```ts
import { Parpaing } from "parpaing";

const parpaing = new Parpaing({ url: "http://127.0.0.1:8090", key: process.env.PARPAING_API_KEY });
const { id } = await parpaing.create({ image: "node:24" });
await parpaing.exec(id, ["node", "-v"]); // { exitCode, stdout, stderr, truncated }
await parpaing.exec(id, ["npm", "test"], { onOutput: (data) => process.stdout.write(data) }); // live, then { exitCode }
await parpaing.delete(id);
```

| Method | Route | Returns |
|---|---|---|
| `info()` | `GET /info` | Version, engines, capacity, sandbox count |
| `create(options?)` | `POST /sandboxes` | The sandbox and its limits |
| `list()` | `GET /sandboxes` | `[{ id, state }]` |
| `get(id)` | `GET /sandboxes/:id` | The sandbox and its limits |
| `delete(id)` | `DELETE /sandboxes/:id` | |
| `exec(id, cmd)` | `POST /sandboxes/:id/exec` | `{ exitCode, stdout, stderr, truncated }`, each output cut past 10 MB |
| `exec(id, cmd, { onOutput })` | the same, with `stream: true` | `{ exitCode }`, the output live |
| `readFolder(id, path)` | `GET /sandboxes/:id/archive` | The folder as a tar stream |
| `writeFolder(id, path, tar)` | `PUT /sandboxes/:id/archive` | The tar (bytes, Blob or stream) unpacked in the folder |

- **`image`**: any image Docker can pull, `debian:trixie-slim` by default: `node:24`, `user/image:tag`, `ghcr.io/owner/image:tag`.
- **Refusals** throw a `ParpaingError` with the API's `status` and message.
- **`signal`** on `exec` stops waiting, not the command.
