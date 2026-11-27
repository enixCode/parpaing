// The API contract: what each route accepts and answers. These schemas check the requests (a refusal carries one of the help
// messages below) and make the OpenAPI description served at /openapi.json. main.ts holds the code that answers them.
import { createRoute, z } from "@hono/zod-openapi";

export const UNKNOWN = { error: "unknown sandbox" };
export const UNKNOWN_COMMAND = { error: "unknown command" };
const IMAGE_HELP = "image: an image name, for example debian:trixie-slim";
const CMD_HELP = 'cmd: a command as an array, for example ["ls", "-la"]';
const MEMORY_HELP = "memory: megabytes, a whole number from 16, for example 2048";
const CPUS_HELP = "cpus: a number of CPUs from 0.01, for example 2 or 0.5";
const PROCESSES_HELP = "processes: a whole number from 16, for example 1024";
const DISK_HELP = "disk: megabytes, a whole number from 1, for example 20480";
const WAIT_HELP = "wait: seconds to wait for free memory, a whole number from 0 to 300";
const PATH_HELP = "path: an absolute folder path, for example /root/project";
const RUNTIME_HELP = "runtime: an engine of this machine, for example runsc (GET /info lists them)";
const NETWORK_HELP = 'network: "internet" (through the egress proxy) or "none"';
const LABELS_HELP =
  'labels: up to 32 key-value pairs, keys of 63 characters at most (letters, digits, ".", "_" or "-", starting with a letter or digit), values of 256 characters at most, for example {"user": "alice"}';
const LABEL_HELP = "label: a key or key=value, repeatable, for example label=user=alice";
const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

const Problem = z.object({ error: z.string() }).openapi("Error");
const Id = z.string().regex(/^[0-9a-f]{12}$/).openapi({ example: "3f9a2c7d1e4b" });
const Params = z.object({ id: Id });
const State = z.enum(["running", "stopped"]);
const Labels = z.record(z.string(), z.string()).openapi({ description: "Fixed at creation; {} when none", example: { user: "alice" } });
const SandboxItem = z.object({ id: Id, state: State, labels: Labels }).openapi("SandboxItem");
const limit = (description: string) => z.number().nullable().openapi({ description: `${description}; null: no limit (created before limits)` });
const Sandbox = z
  .object({
    id: Id,
    state: State,
    runtime: z.string().openapi({ example: "runc" }),
    network: z.enum(["internet", "none"]),
    memory: limit("Megabytes"),
    cpus: limit("CPUs"),
    processes: limit("Processes and threads"),
    disk: limit("Megabytes; enforced on runsc, only recorded on runc"),
    labels: Labels,
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
  network: z
    .enum(["internet", "none"], { error: NETWORK_HELP })
    .optional()
    .openapi({ description: "internet by default: through the egress proxy only (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY), never to the host, the local network or other sandboxes. none: no network" }),
  memory: whole(MEMORY_HELP, 16).optional().openapi({ description: "Megabytes, 1024 by default (PARPAING_MEMORY)", example: 2048 }),
  cpus: z.number({ error: CPUS_HELP }).min(0.01, { error: CPUS_HELP }).optional().openapi({ description: "1 by default (PARPAING_CPUS)", example: 2 }),
  processes: whole(PROCESSES_HELP, 16).optional().openapi({ description: "1024 by default (PARPAING_PROCESSES)", example: 1024 }),
  disk: whole(DISK_HELP, 1).optional().openapi({ description: "Megabytes, 10240 by default (PARPAING_DISK). Enforced on runsc only", example: 20480 }),
  wait: whole(WAIT_HELP, 0).max(300, { error: WAIT_HELP }).optional().openapi({ description: "Seconds to wait if the machine lacks free memory, 0 by default", example: 30 }),
  labels: z
    .record(z.string().regex(LABEL_KEY, { error: LABELS_HELP }), z.string({ error: LABELS_HELP }).max(256, { error: LABELS_HELP }), { error: LABELS_HELP })
    .refine((labels) => Object.keys(labels).length <= 32, { error: LABELS_HELP })
    .optional()
    .openapi({
      description: "Up to 32 key-value pairs to find the sandbox by (GET /sandboxes?label=), fixed at creation",
      example: { user: "alice" },
      maxProperties: 32,
      // propertyNames is OpenAPI 3.1, which the library's types leave out; the generator writes it as given.
      ...{ propertyNames: { pattern: LABEL_KEY.source } },
    }),
});
// A key alone, or key=value split on the first "=": the value may hold more.
const LabelFilter = z.string({ error: LABEL_HELP }).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}(=[\s\S]*)?$/, { error: LABEL_HELP });
const ListQuery = z.object({
  label: z
    .union([LabelFilter, z.array(LabelFilter)], { error: LABEL_HELP })
    .optional()
    .openapi({ description: "key or key=value, repeatable: only the sandboxes carrying every one", example: "user=alice" }),
});
const Folder = z.object({ path: z.string({ error: PATH_HELP }).startsWith("/", { error: PATH_HELP }).openapi({ example: "/root/project" }) });
const FROM_HELP = "from: a byte position in the output, 0 or more, for example 0";
const FOLLOW_HELP = "follow: true or false";
const Command = z.object({
  cmd: z.array(z.string({ error: CMD_HELP }), { error: CMD_HELP }).min(1, { error: CMD_HELP }).openapi({ example: ["ls", "-la"] }),
});
export const CommandStarted = z.object({ id: Id }).openapi("CommandStarted");
const commandFields = {
  id: Id,
  cmd: z.array(z.string()).openapi({ example: ["ls", "-la"] }),
  state: z.enum(["running", "exited"]).openapi({ description: "exited once the main process has ended; processes it left behind may still add output" }),
  exitCode: z.number().int().nullable().openapi({ description: "null while the command runs; 128 + the signal number when a signal killed it" }),
};
export const CommandItem = z.object(commandFields).openapi("CommandItem");
export const CommandState = z
  .object({ ...commandFields, outputSize: z.number().int().openapi({ description: "Bytes of output so far, stdout and stderr together" }) })
  .openapi("CommandState");
const Next = z.number().int().min(0).openapi({ description: "The byte position to resume from: from=next" });
const OutputChunk = z.object({ stream: z.enum(["stdout", "stderr"]), data: z.string().openapi({ description: "At most 64 KiB of UTF-8" }), next: Next });
const OutputSkipped = z.object({
  skipped: z.number().int().min(0).openapi({ description: "Bytes of output no longer kept: the reading goes on at next, where the kept output starts" }),
  next: Next,
});
const OutputEnd = z.object({ exitCode: z.number().int(), next: Next });
const OutputPause = z.object({ next: Next });
// The lines a daemon may send, in this order: a skipped line or a closing line with an exit code must not pass for a pause.
export const DaemonLine = z.union([OutputChunk, OutputSkipped, OutputEnd, OutputPause]);
const OutputLine = z
  .union([OutputChunk, OutputSkipped, OutputEnd, OutputPause, z.object({ error: z.string(), next: Next })])
  .openapi("OutputLine", {
    description:
      "An output piece; skipped, the bytes no longer kept before next; or the closing line: exitCode once the output is finished, next alone when there is more to read later, error when the relay to the sandbox broke",
  });
const CommandParams = z.object({ id: Id, cid: Id });
const Output = z.object({
  from: z.coerce.number({ error: FROM_HELP }).int({ error: FROM_HELP }).min(0, { error: FROM_HELP }).optional().openapi({ description: "0 by default", example: 0 }),
  follow: z.enum(["true", "false"], { error: FOLLOW_HELP }).optional().openapi({ description: "false by default: stop once caught up. true: wait for more output" }),
});
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

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { "application/json": { schema } } } });
const NOT_FOUND = json(Problem, "Unknown sandbox");
const NOT_JSON = json(Problem, "The body is not labelled application/json");
const STOPPED = json(Problem, "The sandbox is stopped");
const STOPPED_OR_OLD = json(Problem, "The sandbox is stopped, or its daemon is too old for commands (recreate the sandbox)");
const UNKNOWN_EITHER = json(Problem, "Unknown sandbox, or unknown command");
const LOST = json(Problem, "The command was lost in a sandbox restart");
const UNREACHABLE = json(Problem, "The sandbox is starting or at its memory or process limit, or its daemon cannot be reached or sent an answer too big, too slow or invalid");
const TAR = { "application/x-tar": { schema: z.string().openapi({ format: "binary" }) } };

export const createSandbox = createRoute({
  method: "post",
  path: "/sandboxes",
  summary: "Create a sandbox",
  tags: ["Sandboxes"],
  description:
    "Starts a container from the image, debian:trixie-slim when none is given. A missing image is downloaded first. Memory, CPUs, processes and disk are ceilings, not reservations; the disk limit holds on runsc only. The sandbox finds its limits in its environment (PARPAING_MEMORY_MB, PARPAING_CPUS, PARPAING_PROCESSES, PARPAING_DISK_MB), and its way out in the proxy variables (PARPAING_PROXY for ssh).",
  request: body(NewSandbox),
  responses: {
    201: json(Sandbox, "The sandbox, running"),
    400: json(Problem, "An image Docker cannot use, an engine this machine lacks, a limit it cannot give, or malformed labels"),
    415: NOT_JSON,
    503: json(Problem, "Not enough free memory on the machine, even after waiting"),
  },
});

export const listSandboxes = createRoute({
  method: "get",
  path: "/sandboxes",
  summary: "List the sandboxes",
  tags: ["Sandboxes"],
  description:
    "Every sandbox, or with label only those carrying all the labels asked. Labels are fixed at creation. They find sandboxes, they protect none: the API key opens every sandbox.",
  request: { query: ListQuery },
  responses: { 200: json(z.array(SandboxItem), "The sandboxes, running or stopped"), 400: json(Problem, "A label filter malformed") },
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

export const startCommand = createRoute({
  method: "post",
  path: "/sandboxes/{id}/commands",
  summary: "Start a command",
  tags: ["Commands"],
  description:
    "The sandbox daemon starts the command and parpaing answers at once with its id. The command runs in its own process group, with its id in PARPAING_EXEC, until it ends or is stopped: a client that leaves does not stop it. GET .../output reads what it prints.",
  request: { params: Params, ...body(Command) },
  responses: {
    201: {
      ...json(CommandStarted, "The command started"),
      headers: { Location: { description: "The command: /sandboxes/{id}/commands/{cid}", schema: { type: "string" } } },
    },
    400: json(Problem, "No command, or a program the sandbox cannot start"),
    404: NOT_FOUND,
    409: STOPPED_OR_OLD,
    415: NOT_JSON,
    503: UNREACHABLE,
  },
});

export const listCommands = createRoute({
  method: "get",
  path: "/sandboxes/{id}/commands",
  summary: "List the commands",
  tags: ["Commands"],
  description: "The running commands and the last 50 finished ones, in start order: past 50, starting a command removes the oldest finished one.",
  request: { params: Params },
  responses: { 200: json(z.array(CommandItem), "The commands, oldest first"), 404: NOT_FOUND, 409: STOPPED_OR_OLD, 503: UNREACHABLE },
});

export const readCommand = createRoute({
  method: "get",
  path: "/sandboxes/{id}/commands/{cid}",
  summary: "Get a command",
  tags: ["Commands"],
  description: "Answers at once, while the command runs or after it ended: its state, its exit code once ended, and the size of its output.",
  request: { params: CommandParams },
  responses: { 200: json(CommandState, "The command"), 404: UNKNOWN_EITHER, 409: STOPPED_OR_OLD, 410: LOST, 503: UNREACHABLE },
});

export const readOutput = createRoute({
  method: "get",
  path: "/sandboxes/{id}/commands/{cid}/output",
  summary: "Read a command's output",
  tags: ["Commands"],
  description:
    "stdout and stderr in the order they came, from byte `from`, one JSON object per line as it comes. Each piece carries `next`, and the last line says why the answer ends: the exit code once the output is finished, `next` alone when there is more to read later (follow=false once caught up, or follow=true after 50 s with nothing to send), or an error when the relay to the sandbox broke. To resume, ask again with from=next. A command keeps at least the last 50 MiB of its output, at most about 100 MiB: reading from before it first gives `{skipped, next}`, the bytes lost, then goes on from next. Inside the sandbox, the kept output is in /tmp/parpaing/{cid}/stdout and stderr, the previous part in stdout.1 and stderr.1, until the command leaves the list or the sandbox restarts.",
  request: { params: CommandParams, query: Output },
  responses: {
    200: { description: "One OutputLine per line, the last one closing", content: { "application/x-ndjson": { schema: OutputLine } } },
    400: json(Problem, "from or follow malformed"),
    404: UNKNOWN_EITHER,
    409: STOPPED_OR_OLD,
    410: LOST,
    503: UNREACHABLE,
  },
});

export const stopCommand = createRoute({
  method: "post",
  path: "/sandboxes/{id}/commands/{cid}/stop",
  summary: "Stop a command",
  tags: ["Commands"],
  description:
    "Answers at once, then sends SIGTERM to the command's process group and to every process carrying its PARPAING_EXEC, and SIGKILL 10 s later. Like every POST, it needs content-type: application/json; the body is ignored.",
  request: { params: CommandParams },
  responses: { 202: json(z.object({}), "Stopping"), 404: UNKNOWN_EITHER, 409: STOPPED_OR_OLD, 410: LOST, 415: NOT_JSON, 503: UNREACHABLE },
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
    { name: "Commands", description: "Start commands in a sandbox, read their output live, stop them" },
    { name: "Files", description: "Copy folders out of and into a sandbox" },
    { name: "Machine", description: "What this machine offers" },
  ],
  info: { title: "parpaing", version, description: "Self-hosted sandboxes for AI agents, driven by an HTTP API." },
});
