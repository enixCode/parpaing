// parpaing: the HTTP API for sandboxes and their commands, on port 8090 behind the nginx gateway (gateway/). This file answers
// the routes declared in routes.ts (what each one accepts and answers); Docker lives in sandboxes.ts and exec.ts.
import { serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import { startCommand } from "./exec.ts";
import * as routes from "./routes.ts";
import { UNKNOWN } from "./routes.ts";
import { create, find, get, info, list, remove, VERSION } from "./sandboxes.ts";

const app = new OpenAPIHono({
  // A refused request gets one sentence saying what to send; an id that cannot exist is an unknown sandbox.
  defaultHook: (result, c) => {
    if (result.success) return;
    if (result.target === "param") return c.json(UNKNOWN, 404);
    return c.json({ error: result.error.issues[0].message }, 400);
  },
});

// The API key is optional. With PARPAING_API_KEY, every call but /openapi.json needs Authorization: Bearer <key>;
// without it, anyone who reaches the port can use the API.
const KEY = process.env.PARPAING_API_KEY;
if (KEY) {
  const auth = bearerAuth({
    token: KEY,
    noAuthenticationHeader: { message: { error: "authorization: Bearer <PARPAING_API_KEY> required" } },
    invalidAuthenticationHeader: { message: { error: "authorization: Bearer <key> expected" } },
    invalidToken: { message: { error: "wrong API key" } },
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

app.openapi(routes.createSandbox, async (c) => c.json(await create(c.req.valid("json")), 201));

app.openapi(routes.listSandboxes, async (c) => c.json(await list(), 200));

app.openapi(routes.getSandbox, async (c) => {
  const sandbox = await get(c.req.valid("param").id);
  return sandbox ? c.json(sandbox, 200) : c.json(UNKNOWN, 404);
});

app.openapi(routes.deleteSandbox, async (c) => ((await remove(c.req.valid("param").id)) ? c.body(null, 204) : c.json(UNKNOWN, 404)));

// Runs a command and streams its output live: one JSON line per chunk, then its exit code.
// Refusals (400, 404, 409) come before any line; a client that leaves does not stop it.
app.openapi(routes.runCommand, async (c) => {
  const found = await find(c.req.valid("param").id);
  if (!found) return c.json(UNKNOWN, 404);
  if (!found.running) return c.json({ error: "sandbox stopped" }, 409);
  const follow = await startCommand(found.container, c.req.valid("json").cmd);

  c.header("content-type", "application/x-ndjson");
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  // zod-openapi expects a typed JSON answer for any content type with "json" in it, x-ndjson included;
  // the stream is a plain Response, described by ExecLine in routes.ts, hence the cast.
  return stream(
    c,
    async (out) => {
      const exitCode = await follow((name, data) => void out.write(line({ stream: name, data })));
      await out.write(line({ exitCode }));
    },
    async (error, out) => void (await out.write(line({ error: error.message }))),
  ) as never;
});

// What this machine offers: version, engines, capacity, sandbox count. A central server uses it to place sandboxes.
app.openapi(routes.machineInfo, async (c) => c.json(await info(), 200));

app.doc31("/openapi.json", routes.document(VERSION));

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
serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 8090 }, () =>
  console.log(`parpaing: sandbox API on port 8090, ${KEY ? "API key required" : "no API key (PARPAING_API_KEY): open to anyone who reaches the port"}`),
);
