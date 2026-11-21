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
  /**
   * Bytes of output not in this result, only when some were: those the command no longer kept (it keeps at least its last
   * 50 MiB, at most about 100 MiB) plus those exec dropped to keep only the last 10 MiB of each stream.
   */
  skipped?: number;
}

export interface CommandItem {
  id: string;
  cmd: string[];
  /** exited once the main process has ended; processes it left behind may still add output. */
  state: "running" | "exited";
  /** null while the command runs; 128 + the signal number when a signal killed it. */
  exitCode: number | null;
}

export interface Command extends CommandItem {
  /** Bytes of output so far, stdout and stderr together. */
  outputSize: number;
}

export interface OutputOptions {
  /** The byte position to read from, 0 by default: the `next` of an earlier read resumes it. */
  from?: number;
  /** false by default: stop once caught up. true: wait for more output, until the end or about 50 s of silence. */
  follow?: boolean;
  onOutput?: OnOutput;
  signal?: AbortSignal;
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

/**
 * A refusal from parpaing, with its HTTP status (400, 401, 404, 409, 410, 503...) and its message. A read of the output that
 * breaks (a broken connection or relay: 502, or a 5xx) also says `next`, where to resume with `from`.
 */
export class ParpaingError extends Error {
  readonly status: number;
  readonly next?: number;
  constructor(status: number, message: string, { next, cause }: { next?: number; cause?: unknown } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ParpaingError";
    this.status = status;
    if (next !== undefined) this.next = next;
  }
}

// What #read hands each piece to: its text, its stream and its size in bytes.
type Piece = (data: string, stream: "stdout" | "stderr", bytes: number) => void;
// exec without onOutput keeps the last 10 MiB of each stream.
const KEPT = 10 * 1024 * 1024;

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
   * Runs a command to its end and answers once, with the last 10 MiB of each stream. With `onOutput`, the output comes live
   * instead, piece by piece, and only the exit code is returned. `skipped` counts the bytes of output not in the answer,
   * when some were. A broken connection or a 5xx resumes where it stopped, 3 times in a row without progress at most; then
   * the ParpaingError says `next`. An error thrown by `onOutput` ends exec as it is. Aborting `signal` stops reading, not
   * the command.
   */
  exec(id: string, cmd: string[], options?: { signal?: AbortSignal }): Promise<CommandResult>;
  exec(id: string, cmd: string[], options: { onOutput: OnOutput; signal?: AbortSignal }): Promise<{ exitCode: number; skipped?: number }>;
  async exec(id: string, cmd: string[], { onOutput, signal }: { onOutput?: OnOutput; signal?: AbortSignal } = {}) {
    // Without onOutput, the pieces of each stream are kept up to KEPT bytes, the oldest dropped first.
    const kept = { stdout: { data: [] as string[], sizes: [] as number[], bytes: 0 }, stderr: { data: [] as string[], sizes: [] as number[], bytes: 0 } };
    let dropped = 0;
    let thrown = false;
    const show: Piece = (data, stream, bytes) => {
      if (onOutput) {
        try {
          return onOutput(data, stream);
        } catch (error) {
          thrown = true;
          throw error;
        }
      }
      const k = kept[stream];
      k.data.push(data);
      k.sizes.push(bytes);
      k.bytes += bytes;
      while (k.bytes > KEPT) {
        k.data.shift();
        const size = k.sizes.shift()!;
        k.bytes -= size;
        dropped += size;
      }
    };
    const { id: cid } = await this.start(id, cmd, signal);
    const at = { next: 0, skipped: 0 };
    for (let failures = 0; ; ) {
      const before = at.next;
      try {
        const { exitCode } = await this.#read(id, cid, at, true, show, signal);
        const skipped = at.skipped + dropped ? { skipped: at.skipped + dropped } : {};
        if (exitCode !== undefined) {
          if (onOutput) return { exitCode, ...skipped };
          return { exitCode, stdout: kept.stdout.data.join(""), stderr: kept.stderr.data.join(""), ...skipped };
        }
        failures = 0;
      } catch (error) {
        // onOutput's error, an abort or a refusal ends here; a broken connection or relay and a 5xx are tried again, 3 times
        // in a row without progress at most.
        if (thrown || signal?.aborted || !(error instanceof ParpaingError && error.status >= 500)) throw error;
        failures = at.next === before ? failures + 1 : 0;
        if (failures >= 3) throw error;
        // The pause ends at once when signal aborts.
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, 500);
          signal?.addEventListener("abort", done, { once: true });
        });
        signal?.throwIfAborted();
      }
    }
  }

  /** Starts a command and answers its id at once. It runs until it ends or is stopped, whoever reads it. */
  async start(id: string, cmd: string[], signal?: AbortSignal): Promise<{ id: string }> {
    return (await this.#call("POST", commands(id), { json: { cmd }, signal })).json();
  }

  /** The running commands and the last 50 finished ones, in start order. */
  async commands(id: string): Promise<CommandItem[]> {
    return (await this.#call("GET", commands(id))).json();
  }

  async command(id: string, cid: string): Promise<Command> {
    return (await this.#call("GET", commands(id, cid))).json();
  }

  /**
   * Reads a command's output once, from `from`: each piece goes to `onOutput`. Answers `next`, where to resume, the exit
   * code once the output is finished, and `skipped`, the bytes no longer kept, when the read started before what is kept.
   * A read that breaks throws a ParpaingError saying `next`; an error thrown by `onOutput` is thrown as it is.
   */
  async output(id: string, cid: string, { from = 0, follow = false, onOutput, signal }: OutputOptions = {}): Promise<{ exitCode?: number; next: number; skipped?: number }> {
    const at = { next: from, skipped: 0 };
    const { exitCode } = await this.#read(id, cid, at, follow, onOutput && ((data, stream) => onOutput(data, stream)), signal);
    return { ...(exitCode === undefined ? {} : { exitCode }), next: at.next, ...(at.skipped ? { skipped: at.skipped } : {}) };
  }

  /** SIGTERM to the command, SIGKILL 10 s later. Answers at once. */
  async stop(id: string, cid: string): Promise<void> {
    await this.#call("POST", `${commands(id, cid)}/stop`, { json: {} });
  }

  // One read of the output from at.next; at.next follows each line once handled, so a read that breaks still says how far
  // it got. A skipped line adds to at.skipped and the read goes on. A broken connection, a broken relay or a 5xx throws a
  // ParpaingError with next; an abort, a refusal and onOutput's errors are thrown as they are.
  async #read(id: string, cid: string, at: { next: number; skipped: number }, follow: boolean, onOutput?: Piece, signal?: AbortSignal) {
    const broken = (error: unknown) => {
      if (signal?.aborted || (error instanceof ParpaingError && error.status < 500)) return error;
      if (error instanceof ParpaingError) return new ParpaingError(error.status, error.message, { next: at.next });
      return new ParpaingError(502, `the connection to parpaing broke: ${(error as Error)?.message}`, { next: at.next, cause: error });
    };
    let res: Response;
    try {
      res = await this.#call("GET", `${commands(id, cid)}/output?from=${at.next}&follow=${follow}`, { signal });
    } catch (error) {
      throw broken(error);
    }
    for await (const line of lines(res.body!, broken)) {
      const item = JSON.parse(line);
      if (item.error !== undefined) throw new ParpaingError(502, item.error, { next: item.next ?? at.next });
      if (item.stream !== undefined) onOutput?.(item.data, item.stream, item.next - at.next);
      else if (item.skipped !== undefined) at.skipped += item.skipped;
      at.next = item.next;
      if (item.stream === undefined && item.skipped === undefined) return { exitCode: item.exitCode as number | undefined };
    }
    throw new ParpaingError(502, "the output ended without a closing line", { next: at.next });
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

const commands = (id: string, cid?: string) => `/sandboxes/${encodeURIComponent(id)}/commands` + (cid === undefined ? "" : `/${encodeURIComponent(cid)}`);
const archive = (id: string, path: string) => `/sandboxes/${encodeURIComponent(id)}/archive?path=${encodeURIComponent(path)}`;

// The lines of an NDJSON body, whole even when a chunk cuts one in two. A failed read throws broken(error). The body is
// released when the iteration stops, even early.
async function* lines(body: ReadableStream<Uint8Array>, broken: (error: unknown) => unknown) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw broken(error);
      }
      const { done, value } = chunk;
      // stream: a character cut between two chunks waits for its end.
      const parts = (rest + decoder.decode(value, { stream: !done })).split("\n");
      rest = parts.pop() ?? "";
      for (const part of parts) if (part) yield part;
      if (done) break;
    }
    if (rest) yield rest;
  } finally {
    reader.cancel().catch(() => {});
  }
}
