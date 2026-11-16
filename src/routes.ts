// The API contract: what each route accepts and answers. These schemas check the requests (a refusal carries one of the help
// messages below) and make the OpenAPI description served at /openapi.json. main.ts holds the code that answers them.
import { createRoute, z } from "@hono/zod-openapi";

export const UNKNOWN = { error: "unknown sandbox" };
const IMAGE_HELP = "image: an image name, for example debian:trixie-slim";
const CMD_HELP = 'cmd: a command as an array, for example ["ls", "-la"]';
const MEMORY_HELP = "memory: megabytes, a whole number from 16, for example 2048";
const CPUS_HELP = "cpus: a number of CPUs from 0.01, for example 2 or 0.5";
const PROCESSES_HELP = "processes: a whole number from 16, for example 1024";
const DISK_HELP = "disk: megabytes, a whole number from 1, for example 20480";
const WAIT_HELP = "wait: seconds to wait for free memory, a whole number from 0 to 300";
const PATH_HELP = "path: an absolute folder path, for example /root/project";
const RUNTIME_HELP = "runtime: an engine of this machine, for example runsc (GET /info lists them)";

const Problem = z.object({ error: z.string() }).openapi("Error");
const Id = z.string().regex(/^[0-9a-f]{12}$/).openapi({ example: "3f9a2c7d1e4b" });
const Params = z.object({ id: Id });
const State = z.enum(["running", "stopped"]);
const SandboxItem = z.object({ id: Id, state: State }).openapi("SandboxItem");
const limit = (description: string) => z.number().nullable().openapi({ description: `${description}; null: no limit (created before limits)` });
const Sandbox = z
  .object({
    id: Id,
    state: State,
    runtime: z.string().openapi({ example: "runc" }),
    memory: limit("Megabytes"),
    cpus: limit("CPUs"),
    processes: limit("Processes and threads"),
    disk: limit("Megabytes; enforced on runsc, only recorded on runc"),
  })
  .openapi("Sandbox");
const whole = (help: string, min: number) => z.number({ error: help }).int({ error: help }).min(min, { error: help });
const NewSandbox = z.object({
  image: z.string({ error: IMAGE_HELP }).min(1, { error: IMAGE_HELP }).optional().openapi({ example: "debian:trixie-slim" }),
  runtime: z
    .string({ error: RUNTIME_HELP })
    .min(1, { error: RUNTIME_HELP })
    .optional()
    .openapi({ description: "The engine, runc by default (PARPAING_RUNTIME). GET /info lists this machine's engines", example: "runsc" }),
  memory: whole(MEMORY_HELP, 16).optional().openapi({ description: "Megabytes, 1024 by default (PARPAING_MEMORY)", example: 2048 }),
  cpus: z.number({ error: CPUS_HELP }).min(0.01, { error: CPUS_HELP }).optional().openapi({ description: "1 by default (PARPAING_CPUS)", example: 2 }),
  processes: whole(PROCESSES_HELP, 16).optional().openapi({ description: "1024 by default (PARPAING_PROCESSES)", example: 1024 }),
  disk: whole(DISK_HELP, 1).optional().openapi({ description: "Megabytes, 10240 by default (PARPAING_DISK). Enforced on runsc only", example: 20480 }),
  wait: whole(WAIT_HELP, 0).max(300, { error: WAIT_HELP }).optional().openapi({ description: "Seconds to wait if the machine lacks free memory, 0 by default", example: 30 }),
});
const Folder = z.object({ path: z.string({ error: PATH_HELP }).startsWith("/", { error: PATH_HELP }).openapi({ example: "/root/project" }) });
const Command = z.object({ cmd: z.array(z.string({ error: CMD_HELP }), { error: CMD_HELP }).min(1, { error: CMD_HELP }).openapi({ example: ["ls", "-la"] }) });
const Info = z
  .object({
    name: z.string(),
    version: z.string(),
    engines: z.array(z.string()).openapi({ example: ["runc"] }),
    cpus: z.number().int(),
    memory: z.number().int().openapi({ description: "Bytes" }),
    memoryAvailable: z.number().openapi({ description: "Free memory now, bytes" }),
    memoryReserved: z.number().int().openapi({ description: "Free memory kept for the machine, bytes (PARPAING_RESERVED_MEMORY)" }),
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
const STOPPED = json(Problem, "The sandbox is stopped");
const TAR = { "application/x-tar": { schema: z.string().openapi({ format: "binary" }) } };

export const createSandbox = createRoute({
  method: "post",
  path: "/sandboxes",
  summary: "Create a sandbox",
  tags: ["Sandboxes"],
  description:
    "Starts a container from the image, debian:trixie-slim when none is given. A missing image is downloaded first. Memory, CPUs, processes and disk are ceilings, not reservations; the disk limit holds on runsc only. The sandbox finds its limits in its environment (PARPAING_MEMORY_MB, PARPAING_CPUS, PARPAING_PROCESSES, PARPAING_DISK_MB).",
  request: body(NewSandbox),
  responses: {
    201: json(Sandbox, "The sandbox, running"),
    400: json(Problem, "An image Docker cannot use, an engine this machine lacks, or a limit it cannot give"),
    415: NOT_JSON,
    503: json(Problem, "Not enough free memory on the machine, even after waiting"),
  },
});

export const listSandboxes = createRoute({
  method: "get",
  path: "/sandboxes",
  summary: "List the sandboxes",
  tags: ["Sandboxes"],
  responses: { 200: json(z.array(SandboxItem), "Every sandbox, running or stopped") },
});

export const getSandbox = createRoute({
  method: "get",
  path: "/sandboxes/{id}",
  summary: "Get a sandbox",
  tags: ["Sandboxes"],
  request: { params: Params },
  responses: { 200: json(Sandbox, "The sandbox and its limits"), 404: NOT_FOUND },
});

export const deleteSandbox = createRoute({
  method: "delete",
  path: "/sandboxes/{id}",
  summary: "Delete a sandbox",
  tags: ["Sandboxes"],
  description: "Removes the container and everything in it.",
  request: { params: Params },
  responses: { 204: { description: "Deleted" }, 404: NOT_FOUND },
});

export const runCommand = createRoute({
  method: "post",
  path: "/sandboxes/{id}/exec",
  summary: "Run a command",
  tags: ["Commands"],
  description:
    "Streams the output live, one JSON object per line: stdout and stderr chunks as they come, then the exit code. A failure after the start ends the stream with an error line.",
  request: { params: Params, ...body(Command) },
  responses: {
    200: { description: "One ExecLine per line, the last one holds the exit code", content: { "application/x-ndjson": { schema: ExecLine } } },
    400: json(Problem, "No command"),
    404: NOT_FOUND,
    409: STOPPED,
    415: NOT_JSON,
  },
});

export const readArchive = createRoute({
  method: "get",
  path: "/sandboxes/{id}/archive",
  summary: "Download a folder",
  tags: ["Files"],
  description:
    "Streams the folder's content as a tar archive, made by tar inside the sandbox: the image needs tar (Debian, Ubuntu, Alpine, Node and Python images have it). If tar fails midway, the transfer breaks instead of ending with a cut archive.",
  request: { params: Params, query: Folder },
  responses: {
    200: { description: "The folder's content as a tar archive", content: TAR },
    400: json(Problem, "No absolute path, or an image without tar"),
    404: json(Problem, "Unknown sandbox, or no such folder"),
    409: STOPPED,
  },
});

export const writeArchive = createRoute({
  method: "put",
  path: "/sandboxes/{id}/archive",
  summary: "Upload a folder",
  tags: ["Files"],
  description:
    "Unpacks a tar archive into the folder, created if missing. Files in the archive replace those of the same name; other files stay. An archive from GET restores the folder.",
  request: { params: Params, query: Folder, body: { required: true, content: TAR } },
  responses: {
    204: { description: "Unpacked" },
    400: json(Problem, "No absolute path, not a tar archive, or an image without tar"),
    404: NOT_FOUND,
    409: STOPPED,
  },
});

export const machineInfo = createRoute({
  method: "get",
  path: "/info",
  summary: "What this machine offers",
  tags: ["Machine"],
  responses: { 200: json(Info, "Version, engines, capacity, sandbox count") },
});

export const apiKey = { type: "http", scheme: "bearer", description: "Only when parpaing runs with PARPAING_API_KEY" } as const;

// The OpenAPI document around the routes. Scalar shows one folder per tag. The server is the address /docs was opened from:
// its curl examples and Test Request follow it (127.0.0.1, localhost, a host name).
export const document = (version: string) => ({
  openapi: "3.1.0",
  servers: [{ url: "/" }],
  security: [{ apiKey: [] }, {}] as Record<string, string[]>[],
  tags: [
    { name: "Sandboxes", description: "Create, list, read and delete sandboxes" },
    { name: "Commands", description: "Run commands in a sandbox" },
    { name: "Files", description: "Copy folders out of and into a sandbox" },
    { name: "Machine", description: "What this machine offers" },
  ],
  info: { title: "parpaing", version, description: "Self-hosted sandboxes for AI agents, driven by an HTTP API." },
});
