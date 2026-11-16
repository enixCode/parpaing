// parpaing's TypeScript SDK: one method per API route, no dependency. It needs fetch and web streams only, so it runs on
// Node 18+, Deno, Bun and in browsers. The API reference is /docs on a running parpaing.

export type State = "running" | "stopped";
export type Network = "internet" | "none";

export interface NewSandbox {
  /** Any image Docker can pull, debian:trixie-slim by default: `node:24`, `user/image:tag`, `ghcr.io/owner/image:tag`. */
  image?: string;
  /** The engine, runc by default: one of `info().engines`, such as runsc. */
  runtime?: string;
  /** internet (the default) goes out through the egress proxy only; none cuts everything. */
  network?: Network;
  /** Megabytes, 1024 by default. */
  memory?: number;
  /** 1 by default. */
  cpus?: number;
  /** Processes and threads, 1024 by default. */
  processes?: number;
  /** Megabytes, 10240 by default, enforced on runsc only. */
  disk?: number;
  /** Seconds to wait if the machine lacks free memory, 0 by default. */
  wait?: number;
}

export interface Sandbox {
  id: string;
  state: State;
  runtime: string;
  network: Network;
  memory: number | null;
  cpus: number | null;
  processes: number | null;
  disk: number | null;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** stdout or stderr went past 10 MB and was cut. */
  truncated: boolean;
}

export interface Info {
  name: string;
  version: string;
  engines: string[];
  cpus: number;
  /** Bytes. */
  memory: number;
  memoryAvailable: number;
  memoryReserved: number;
  sandboxes: { total: number; running: number };
}

export type OnOutput = (data: string, stream: "stdout" | "stderr") => void;

/** A refusal from parpaing, with its HTTP status (400, 401, 404, 409, 503...) and its message. */
export class ParpaingError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ParpaingError";
    this.status = status;
  }
}

export class Parpaing {
  readonly #url: string;
  readonly #key: string | undefined;

  /** `url` is http://127.0.0.1:8090 by default; `key` is needed when parpaing runs with PARPAING_API_KEY. */
  constructor({ url = "http://127.0.0.1:8090", key }: { url?: string; key?: string } = {}) {
    this.#url = url.replace(/\/+$/, "");
    this.#key = key;
  }

  async #call(method: string, path: string, { json, tar, signal }: { json?: unknown; tar?: BodyInit; signal?: AbortSignal } = {}) {
    const headers: Record<string, string> = {};
    if (this.#key) headers.authorization = `Bearer ${this.#key}`;
    // duplex: Node's fetch needs it to send a stream as the body.
    const init: RequestInit & { duplex?: "half" } = { method, headers, signal };
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    } else if (tar !== undefined) {
      headers["content-type"] = "application/x-tar";
      init.body = tar;
      init.duplex = "half";
    }
    const res = await fetch(this.#url + path, init);
    if (res.ok) return res;
    const text = await res.text();
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {}
    throw new ParpaingError(res.status, message);
  }

  /** Version, engines, capacity and sandbox count of the machine. */
  async info(): Promise<Info> {
    return (await this.#call("GET", "/info")).json();
  }

  /** Starts a sandbox; a missing image is downloaded first. */
  async create(options: NewSandbox = {}): Promise<Sandbox> {
    return (await this.#call("POST", "/sandboxes", { json: options })).json();
  }

  async list(): Promise<{ id: string; state: State }[]> {
    return (await this.#call("GET", "/sandboxes")).json();
  }

  async get(id: string): Promise<Sandbox> {
    return (await this.#call("GET", `/sandboxes/${encodeURIComponent(id)}`)).json();
  }

  async delete(id: string): Promise<void> {
    await this.#call("DELETE", `/sandboxes/${encodeURIComponent(id)}`);
  }

  /**
   * Runs a command to its end and answers once. With `onOutput`, the output comes live instead, chunk by chunk, and only
   * the exit code is returned. Aborting `signal` stops waiting, not the command.
   */
  exec(id: string, cmd: string[], options?: { signal?: AbortSignal }): Promise<CommandResult>;
  exec(id: string, cmd: string[], options: { onOutput: OnOutput; signal?: AbortSignal }): Promise<{ exitCode: number }>;
  async exec(id: string, cmd: string[], { onOutput, signal }: { onOutput?: OnOutput; signal?: AbortSignal } = {}) {
    const json = { cmd, stream: onOutput !== undefined };
    const res = await this.#call("POST", `/sandboxes/${encodeURIComponent(id)}/exec`, { json, signal });
    if (!onOutput) return res.json();
    let exitCode: number | undefined;
    for await (const line of lines(res.body!)) {
      const item = JSON.parse(line);
      if (item.data !== undefined) onOutput(item.data, item.stream);
      else if (item.exitCode !== undefined) exitCode = item.exitCode;
      else if (item.error !== undefined) throw new ParpaingError(500, item.error);
    }
    if (exitCode === undefined) throw new ParpaingError(502, "the output ended without an exit code");
    return { exitCode };
  }

  /** A folder of the sandbox as a tar archive, streamed. The image needs tar. */
  async readFolder(id: string, path: string): Promise<ReadableStream<Uint8Array>> {
    return (await this.#call("GET", archive(id, path))).body!;
  }

  /** Unpacks a tar archive (bytes, a Blob or a stream) into a folder of the sandbox, created if missing. */
  async writeFolder(id: string, path: string, tar: BodyInit): Promise<void> {
    await this.#call("PUT", archive(id, path), { tar });
  }
}

const archive = (id: string, path: string) => `/sandboxes/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(path)}`;

// The lines of an NDJSON body, whole even when a chunk cuts one in two.
async function* lines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    // stream: a character cut between two chunks waits for its end.
    const parts = (rest + decoder.decode(value, { stream: !done })).split("\n");
    rest = parts.pop() ?? "";
    for (const part of parts) if (part) yield part;
    if (done) break;
  }
  if (rest) yield rest;
}
