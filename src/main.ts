// parpaing: the HTTP API for sandboxes and their commands, on port 8090 behind the nginx gateway (gateway/). This file only checks
// requests and formats responses; Docker lives in sandboxes.ts and exec.ts. Each route declares its schemas: they check the
// requests and make the OpenAPI description served at /openapi.json, which the gateway's /docs page draws.
import { serve } from "@hono/node-server";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { stream } from "hono/streaming";
import { startCommand } from "./exec.ts";
import { create, find, get, info, list, remove, VERSION } from "./sandboxes.ts";

const UNKNOWN = { error: "unknown sandbox" };
const IMAGE_HELP = "image: an image name, for example debian:trixie-slim";
const CMD_HELP = 'cmd: a command as an array, for example ["ls", "-la"]';

const Problem = z.object({ error: z.string() }).openapi("Error");
const Id = z.string().regex(/^[0-9a-f]{12}$/).openapi({ example: "3f9a2c7d1e4b" });
const Params = z.object({ id: Id });
const Sandbox = z.object({ id: Id, state: z.enum(["running", "stopped"]) }).openapi("Sandbox");
const Info = z
  .object({
    name: z.string(),
    version: z.string(),
    engines: z.array(z.string()).openapi({ example: ["runc"] }),
    cpus: z.number().int(),
    memory: z.number().int().openapi({ description: "Bytes" }),
    sandboxes: z.object({ total: z.number().int(), running: z.number().int() }),
  })
  .openapi("Info");
const ExecLine = z
  .union([
    z.object({ stream: z.enum(["stdout", "stderr"]), data: z.string() }),
    z.object({ exitCode: z.number().int() }),
    z.object({ error: z.string() }),
  ])
  .openapi("ExecLine");

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const NOT_FOUND = json(Problem, "Unknown sandbox");
const NOT_JSON = json(Problem, "The body is not labelled application/json");

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
app.openAPIRegistry.registerComponent("securitySchemes", "apiKey", { type: "http", scheme: "bearer", description: "Only when parpaing runs with PARPAING_API_KEY" });

// A POST body must be labelled JSON. A browser sends a JSON-labelled request to another site only
// after asking that site's permission (CORS), which parpaing never gives: a web page cannot create
// sandboxes behind the user's back.
app.use("*", async (c, next) => {
  if (c.req.method === "POST" && !c.req.header("content-type")?.startsWith("application/json")) {
    return c.json({ error: "content-type: application/json required" }, 415);
  }
  await next();
});

app.openapi(
  createRoute({
    method: "post",
    path: "/sandboxes",
    summary: "Create a sandbox", tags: ["Sandboxes"],
    description: "Starts a container from the image, debian:trixie-slim when none is given. A missing image is downloaded first.",
    request: body(z.object({ image: z.string({ error: IMAGE_HELP }).min(1, { error: IMAGE_HELP }).optional().openapi({ example: "debian:trixie-slim" }) })),
    responses: { 201: json(Sandbox, "The sandbox, running"), 400: json(Problem, "An image name Docker cannot use"), 415: NOT_JSON },
  }),
  async (c) => c.json(await create(c.req.valid("json").image), 201),
);

app.openapi(
  createRoute({ method: "get", path: "/sandboxes", summary: "List the sandboxes", tags: ["Sandboxes"], responses: { 200: json(z.array(Sandbox), "Every sandbox, running or stopped") } }),
  async (c) => c.json(await list(), 200),
);

app.openapi(
  createRoute({ method: "get", path: "/sandboxes/{id}", summary: "Get a sandbox", tags: ["Sandboxes"], request: { params: Params }, responses: { 200: json(Sandbox, "The sandbox"), 404: NOT_FOUND } }),
  async (c) => {
    const sandbox = await get(c.req.valid("param").id);
    return sandbox ? c.json(sandbox, 200) : c.json(UNKNOWN, 404);
  },
);

app.openapi(
  createRoute({
    method: "delete",
    path: "/sandboxes/{id}",
    summary: "Delete a sandbox", tags: ["Sandboxes"],
    description: "Removes the container and everything in it.",
    request: { params: Params },
    responses: { 204: { description: "Deleted" }, 404: NOT_FOUND },
  }),
  async (c) => ((await remove(c.req.valid("param").id)) ? c.body(null, 204) : c.json(UNKNOWN, 404)),
);

// Runs a command and streams its output live: one JSON line per chunk, then its exit code.
// Refusals (400, 404, 409) come before any line; a client that leaves does not stop it.
app.openapi(
  createRoute({
    method: "post",
    path: "/sandboxes/{id}/exec",
    summary: "Run a command", tags: ["Commands"],
    description: "Streams the output live, one JSON object per line: stdout and stderr chunks as they come, then the exit code. A failure after the start ends the stream with an error line.",
    request: { params: Params, ...body(z.object({ cmd: z.array(z.string({ error: CMD_HELP }), { error: CMD_HELP }).min(1, { error: CMD_HELP }).openapi({ example: ["ls", "-la"] }) })) },
    responses: {
      200: { description: "One ExecLine per line, the last one holds the exit code", content: { "application/x-ndjson": { schema: ExecLine } } },
      400: json(Problem, "No command"),
      404: NOT_FOUND,
      409: json(Problem, "The sandbox is stopped"),
      415: NOT_JSON,
    },
  }),
  async (c) => {
    const found = await find(c.req.valid("param").id);
    if (!found) return c.json(UNKNOWN, 404);
    if (!found.running) return c.json({ error: "sandbox stopped" }, 409);
    const follow = await startCommand(found.container, c.req.valid("json").cmd);

    c.header("content-type", "application/x-ndjson");
    const line = (value: unknown) => JSON.stringify(value) + "\n";
    // zod-openapi expects a typed JSON answer for any content type with "json" in it, x-ndjson included;
    // the stream is a plain Response, described by ExecLine above, hence the cast.
    return stream(
      c,
      async (out) => {
        const exitCode = await follow((name, data) => void out.write(line({ stream: name, data })));
        await out.write(line({ exitCode }));
      },
      async (error, out) => void (await out.write(line({ error: error.message }))),
    ) as never;
  },
);

// What this machine offers: version, engines, capacity, sandbox count. A central server uses it to
// place sandboxes.
app.openapi(
  createRoute({ method: "get", path: "/info", summary: "What this machine offers", tags: ["Machine"], responses: { 200: json(Info, "Version, engines, capacity, sandbox count") } }),
  async (c) => c.json(await info(), 200),
);

// Scalar shows one folder per tag. The server is the address /docs was opened from: its curl examples and Test Request follow it (127.0.0.1, localhost, a host name).
app.doc31("/openapi.json", { openapi: "3.1.0", servers: [{ url: "/" }], security: [{ apiKey: [] }, {}],
  tags: [
    { name: "Sandboxes", description: "Create, list, read and delete sandboxes" },
    { name: "Commands", description: "Run commands in a sandbox" },
    { name: "Machine", description: "What this machine offers" },
  ],
  info: { title: "parpaing", version: VERSION, description: "Self-hosted sandboxes for AI agents, driven by an HTTP API." } });

app.notFound((c) => c.json({ error: "unknown route" }, 404));

// A refused request (malformed JSON, missing API key…) and an error Docker blames on the request (image not found…) keep
// their status and their message. Anything else is a parpaing failure: its detail goes to the logs, not to the client.
app.onError((error, c) => {
  if (error instanceof HTTPException) return error.res ?? c.json({ error: error.message }, error.status);
  const status = (error as { statusCode?: number }).statusCode;
  if (status && status >= 400 && status < 500) return c.json({ error: error.message }, status as 400);
  console.error(error);
  return c.json({ error: "internal error" }, 500);
});

// parpaing listens on every address of its container, otherwise Docker cannot forward the port to it.
// compose decides who can reach it: 127.0.0.1 by default, PARPAING_ADDRESS for the network.
serve({ fetch: app.fetch, hostname: "0.0.0.0", port: 8090 }, () =>
  console.log(`parpaing: sandbox API on port 8090, ${KEY ? "API key required" : "no API key (PARPAING_API_KEY): open to anyone who reaches the port"}`),
);
