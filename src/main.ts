// parpaing: the HTTP API for sandboxes and their commands, on port 8090 behind the nginx gateway (gateway/). This file answers
// the routes declared in routes.ts (what each one accepts and answers); Docker lives in sandboxes.ts, relay.ts and archive.ts.
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import { readFolder, writeFolder } from "./archive.ts";
import { DAEMON_VOLUME, installDaemon } from "./daemon.ts";
import { followEgress } from "./network.ts";
import { followOom } from "./oom.ts";
import * as commands from "./relay.ts";
import * as routes from "./routes.ts";
import { UNKNOWN, UNKNOWN_COMMAND } from "./routes.ts";
import * as sandboxes from "./sandboxes.ts";
import { exposureError } from "./start.ts";

const app = new OpenAPIHono({
  // A refused request gets one sentence saying what to send; an id that cannot exist is an unknown sandbox, a command id
  // that cannot exist an unknown command.
  defaultHook: (result, c) => {
    if (result.success) return;
    if (result.target === "param") return c.json(result.error.issues.some((issue) => issue.path[0] === "id") ? UNKNOWN : UNKNOWN_COMMAND, 404);
    return c.json({ error: result.error.issues[0].message }, 400);
  },
});

// The API key is optional. With PARPAING_API_KEY, every call but /openapi.json needs Authorization: Bearer <key>;
// without it, anyone who reaches the port can use the API. A port published beyond this machine (PARPAING_ADDRESS) needs one.
const KEY = process.env.PARPAING_API_KEY;
const exposed = exposureError(process.env.PARPAING_ADDRESS, KEY);
if (exposed) {
  console.error(exposed);
  process.exit(1);
}
if (KEY) {
  const auth = bearerAuth({
    token: KEY,
    noAuthenticationHeader: { message: { error: "authorization: Bearer <PARPAING_API_KEY> required" } },
    invalidAuthenticationHeader: { message: { error: "authorization: Bearer <key> expected" } },
    invalidToken: { message: { error: "wrong API key :(" } },
  });
  app.use("*", (c, next) => (c.req.path === "/openapi.json" ? next() : auth(c, next)));
}
app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", routes.apiKey);

// A POST body must be labelled JSON. A browser sends a JSON-labelled request to another site only
// after asking that site's permission (CORS), which parpaing never gives: a web page cannot create
// sandboxes behind the user's back.
app.use("*", async (c, next) => {
  if (c.req.method === "POST" && !c.req.header("content-type")?.startsWith("application/json")) {
    return c.json({ error: "content-type: application/json required" }, 415);
  }
  await next();
});

app.openapi(routes.createSandbox, async (c) => c.json(await sandboxes.create(c.req.valid("json")), 201));

app.openapi(routes.listSandboxes, async (c) => c.json(await sandboxes.list(), 200));

app.openapi(routes.getSandbox, async (c) => {
  const sandbox = await sandboxes.get(c.req.valid("param").id);
  return sandbox ? c.json(sandbox, 200) : c.json(UNKNOWN, 404);
});

app.openapi(routes.deleteSandbox, async (c) => ((await sandboxes.remove(c.req.valid("param").id)) ? c.body(null, 204) : c.json(UNKNOWN, 404)));

// Commands run by the sandbox's daemon: started at once, read and stopped by id. A client that leaves does not stop them.
app.openapi(routes.startCommand, async (c) => {
  const { id } = c.req.valid("param");
  const started = await commands.startCommand(id, c.req.valid("json").cmd);
  c.header("location", `/sandboxes/${id}/commands/${started.id}`);
  return c.json(started, 201);
});

app.openapi(routes.listCommands, async (c) => c.json(await commands.listCommands(c.req.valid("param").id), 200));

app.openapi(routes.readCommand, async (c) => {
  const { id, cid } = c.req.valid("param");
  return c.json(await commands.readCommand(id, cid), 200);
});

app.openapi(routes.stopCommand, async (c) => {
  const { id, cid } = c.req.valid("param");
  return c.json(await commands.stopCommand(id, cid), 202);
});

// The output goes to the client line by line as the daemon sends it; refusals (400, 404, 409, 410, 503) come before the first
// line. A client that leaves closes the relay, not the command.
app.openapi(routes.readOutput, async (c) => {
  const { id, cid } = c.req.valid("param");
  const { from = 0, follow } = c.req.valid("query");
  const output = await commands.openOutput(id, cid, from, follow === "true", c.req.raw.signal);
  c.header("content-type", "application/x-ndjson");
  // zod-openapi expects a typed JSON answer for any content type with "json" in it, x-ndjson included;
  // the stream is a plain Response, described by OutputLine in routes.ts, hence the cast.
  return stream(c, async (out) => {
    out.onAbort(output.close);
    for await (const line of output.lines) await out.write(JSON.stringify(line) + "\n");
  }) as never;
});

// A folder out as a tar stream, or a tar stream unpacked into a folder. Refusals come before the first byte.
app.openapi(routes.readArchive, async (c) => {
  const container = await sandboxes.running(c.req.valid("param").id);
  const archive = await readFolder(container, c.req.valid("query").path);
  // A tar stream, not the JSON zod-openapi expects: the same cast as the output stream.
  return c.body(Readable.toWeb(archive) as ReadableStream, 200, { "content-type": "application/x-tar" }) as never;
});

app.openapi(routes.writeArchive, async (c) => {
  const container = await sandboxes.running(c.req.valid("param").id);
  await writeFolder(container, c.req.valid("query").path, c.req.raw.body ?? new Blob().stream());
  return c.body(null, 204);
});

// What this machine offers: version, engines, capacity, sandbox count. A central server uses it to place sandboxes.
app.openapi(routes.machineInfo, async (c) => c.json(await sandboxes.info(), 200));

app.doc31("/openapi.json", routes.document(sandboxes.VERSION));

app.notFound((c) => c.json({ error: "unknown route" }, 404));

// A refused request (malformed JSON, missing API key…), an error Docker blames on the request (image not found…) and a full
// machine (503) keep their status and their message. Anything else is a parpaing failure: its detail goes to the logs, not to the client.
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.res ?? c.json({ error: error.message }, error.status);
  const status = (error as { statusCode?: number }).statusCode;
  if (status && ((status >= 400 && status < 500) || status === 503)) return c.json({ error: error.message }, status as 400);
  console.error(error);
  return c.json({ error: "internal error" }, 500);
});

// parpaing listens on every address of its container, otherwise Docker cannot forward the port to it.
// compose decides who can reach it: 127.0.0.1 by default, PARPAING_ADDRESS for the network.
// The egress proxy gets its legs back in every sandbox network now, and whenever it starts again.
followEgress().catch((error) => console.error(`egress: ${error.message}`));
// The out-of-memory kills of sandboxes, behind the reason of a 410.
followOom();

// Without the daemon in its volume, no sandbox could start: better to stop here with the reason.
await installDaemon().catch((error) => {
  console.error(`parpaing: cannot copy the sandbox daemon into the ${DAEMON_VOLUME} volume (mounted at /daemon): ${error.message}`);
  process.exit(1);
});

serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 8090 }, () =>
  console.log(`parpaing: sandbox API on port 8090, ${KEY ? "API key required" : "no API key (PARPAING_API_KEY): open to anyone who reaches the port"}`),
);
