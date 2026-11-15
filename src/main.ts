// parpaing: the HTTP API for sandboxes and their commands, on port 8090 behind the nginx gateway (gateway/). This file only checks
// requests and formats responses; Docker lives in sandboxes.ts and exec.ts.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { startCommand } from "./exec.ts";
import { create, find, get, info, list, remove } from "./sandboxes.ts";

const SANDBOX = "/sandboxes/:id{[0-9a-f]{12}}";
const UNKNOWN = { error: "unknown sandbox" };

const app = new Hono();

// A POST body must be labelled JSON. A browser sends a JSON-labelled request to another site only
// after asking that site's permission (CORS), which parpaing never gives: a web page cannot create
// sandboxes behind the user's back.
app.use("*", async (c, next) => {
  if (c.req.method === "POST" && !c.req.header("content-type")?.startsWith("application/json")) {
    return c.json({ error: "content-type: application/json required" }, 415);
  }
  await next();
});

app.post("/sandboxes", async (c) => {
  const { image } = await c.req.json().catch(() => ({}));
  if (image !== undefined && (typeof image !== "string" || !image)) {
    return c.json({ error: "image: an image name, for example debian:trixie-slim" }, 400);
  }
  return c.json(await create(image), 201);
});

app.get("/sandboxes", async (c) => c.json(await list()));

app.get(SANDBOX, async (c) => {
  const sandbox = await get(c.req.param("id"));
  return sandbox ? c.json(sandbox) : c.json(UNKNOWN, 404);
});

app.delete(SANDBOX, async (c) => {
  if (!(await remove(c.req.param("id")))) return c.json(UNKNOWN, 404);
  return c.body(null, 204);
});

// Runs a command and streams its output live: one JSON line per chunk, then its exit code.
// Refusals (400, 404, 409) come before any line; a client that leaves does not stop it.
app.post(`${SANDBOX}/exec`, async (c) => {
  const { cmd } = await c.req.json().catch(() => ({}));
  const isCommand = Array.isArray(cmd) && cmd.length > 0 && cmd.every((word) => typeof word === "string");
  if (!isCommand) return c.json({ error: 'cmd: a command as an array, for example ["ls", "-la"]' }, 400);
  const found = await find(c.req.param("id"));
  if (!found) return c.json(UNKNOWN, 404);
  if (!found.running) return c.json({ error: "sandbox stopped" }, 409);
  const follow = await startCommand(found.container, cmd);

  c.header("content-type", "application/x-ndjson");
  const line = (value: unknown) => JSON.stringify(value) + "\n";
  return stream(
    c,
    async (out) => {
      const exitCode = await follow((name, data) => void out.write(line({ stream: name, data })));
      await out.write(line({ exitCode }));
    },
    async (error, out) => void (await out.write(line({ error: error.message }))),
  );
});

// What this machine offers: version, engines, capacity, sandbox count. A central server uses it to
// place sandboxes.
app.get("/info", async (c) => c.json(await info()));

app.notFound((c) => c.json({ error: "unknown route" }, 404));

// An error Docker blames on the request (image not found…) keeps its status and its message. Anything
// else is a parpaing failure: its detail goes to the logs, not to the client.
app.onError((error, c) => {
  const status = (error as { statusCode?: number }).statusCode;
  if (status && status >= 400 && status < 500) return c.json({ error: error.message }, status as 400);
  console.error(error);
  return c.json({ error: "internal error" }, 500);
});

// parpaing listens on every address of its container, otherwise Docker cannot forward the port to it.
// compose decides who can reach it: 127.0.0.1 by default, PARPAING_ADDRESS for the network.
serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 8090 }, () => console.log("parpaing: sandbox API on http://127.0.0.1:8090"));

