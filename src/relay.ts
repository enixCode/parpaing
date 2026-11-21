// Talking to the sandbox daemon. parpaing is in another network namespace and cannot reach its socket, so it runs
// `parpaingd relay` with docker exec, which joins the exec's stdin and stdout to the socket, and speaks plain HTTP through it.
// Everything that comes back is hostile: the agent can write into the relay's stdout. So a JSON answer gets at most 1 MiB and
// 10 s, an output line at most 1 MiB, and only the known fields of an answer go on to the client.
import { type IncomingMessage, request } from "node:http";
import { Duplex, finished, PassThrough, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { Container, Exec } from "dockerode";
import type { z } from "@hono/zod-openapi";
import { DAEMON_LABEL, DAEMON_PATH } from "./daemon.ts";
import { CommandItem, CommandStarted, CommandState, DaemonLine } from "./routes.ts";
import { clientError, find } from "./sandboxes.ts";

const TOO_OLD_COMMENT = "this sandbox's daemon is too old for commands: recreate the sandbox";
const MAX = 1024 * 1024;
const DEADLINE = 10_000;

const unreachable = (reason: string) => clientError(`the sandbox daemon cannot be reached: ${reason}`, 503);
const invalid = (reason: string) => clientError(`the sandbox daemon sent an invalid answer: ${reason}`, 503);

type Relay = { res: IncomingMessage; close: () => void };

// The container of a running sandbox whose daemon may run commands: one created before the daemon has none.
async function daemonOf(id: string) {
  const found = await find(id);
  if (!found) throw clientError("unknown sandbox", 404);
  if (!found.running) throw clientError("sandbox stopped", 409);
  if (found.info.Config.Labels?.[DAEMON_LABEL] === undefined) throw clientError(TOO_OLD_COMMENT, 409);
  return found.container;
}

// The relay's exit code, if it ends within 2 s: a relay stopped from inside never would.
async function exitCode(exec: Exec) {
  for (let tries = 0; tries < 40; tries++) {
    const info = await exec.inspect();
    if (!info.Running) return info.ExitCode;
    await sleep(50);
  }
}

// Sends one HTTP request to the daemon and resolves with its answer's head; the body is left to read. Aborting `signal`
// closes the relay. Without an answer, the relay's exit code tells why: 3 means nothing listens on the socket (a daemon
// older than it); anything else, a sandbox at its process limit for instance, is a daemon out of reach.
async function open(container: Container, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Relay> {
  const exec = await container.exec({ Cmd: [DAEMON_PATH, "relay"], AttachStdin: true, AttachStdout: true, AttachStderr: true });
  const output = await exec.start({ hijack: true, stdin: true }).catch((error) => {
    throw unreachable(error.message);
  });

  // Docker mixes stdout and stderr into one stream: stdout carries the daemon's answer, stderr the relay's own complaint.
  // demuxStream ignores backpressure, so Docker's stream pauses while the answer waits for a slow client: memory stays bounded.
  const answer = new PassThrough();
  let stderr = "";
  const toAnswer = new Writable({
    write(chunk, _encoding, done) {
      if (!answer.write(chunk) && !output.isPaused()) {
        output.pause();
        answer.once("drain", () => output.resume());
      }
      done();
    },
  });
  // Only the start: the agent can write into the relay's stderr too.
  const toStderr = new Writable({
    write(chunk, _encoding, done) {
      if (stderr.length < 4096) stderr += chunk;
      done();
    },
  });
  container.modem.demuxStream(output, toAnswer, toStderr);
  finished(output, { writable: false }, () => answer.end());
  // Node takes a pair of Node streams here; its types only list the web stream pair, hence the cast.
  const socket = Duplex.from({ readable: answer, writable: output } as never);
  // The relay does not half-close: stdin stays open until the answer ends, then everything goes.
  const close = () => {
    signal?.removeEventListener("abort", close);
    socket.destroy();
    (output as Duplex).destroy();
  };
  signal?.addEventListener("abort", close);
  if (signal?.aborted) close();

  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = { host: "parpaingd", connection: "close", ...(payload && { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }) };
  try {
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      // No agent option: with agent: false, Node makes a new Agent that ignores createConnection and dials port 80.
      const req = request({ createConnection: () => socket, method, path, headers }, resolve);
      req.on("error", reject);
      req.end(payload);
    });
    return { res, close };
  } catch (error) {
    close();
    // Cut on purpose (deadline, client gone): the caller knows why.
    if (signal?.aborted) throw error;
    if ((await exitCode(exec)) === 3) throw clientError(TOO_OLD_COMMENT, 409);
    // The first line says why; a relay that could not start a thread adds a whole Go stack after it.
    throw unreachable(stderr.trim().split("\n")[0] || (error as Error).message);
  }
}

// A whole JSON answer of at most 1 MiB, read before the deadline; then the relay closes.
async function answerOf({ res, close }: Relay, deadline: AbortSignal) {
  deadline.addEventListener("abort", close);
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res as AsyncIterable<Buffer>) {
      if ((size += chunk.length) > MAX) throw unreachable("its answer is over 1 MiB");
      chunks.push(chunk);
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {}
    return { status: res.statusCode ?? 0, data };
  } catch (error) {
    if (deadline.aborted) throw unreachable(`no answer within ${DEADLINE / 1000} s`);
    if ((error as { statusCode?: number }).statusCode) throw error;
    throw unreachable((error as Error).message);
  } finally {
    deadline.removeEventListener("abort", close);
    close();
  }
}

// One request to the daemon, answered in JSON.
async function ask(id: string, method: string, path: string, body?: unknown) {
  const container = await daemonOf(id);
  const deadline = AbortSignal.timeout(DEADLINE);
  const relay = await open(container, method, path, body, deadline).catch((error) => {
    throw deadline.aborted ? unreachable(`no answer within ${DEADLINE / 1000} s`) : error;
  });
  return answerOf(relay, deadline);
}

// A refusal from the daemon. Only a daemon older than the commands answers 404 without its JSON "unknown command".
function refused(status: number, data: any): never {
  if (status === 404 && data?.error === "unknown command") throw clientError("unknown command", 404);
  if (status === 404) throw clientError(TOO_OLD_COMMENT, 409);
  if (status === 400 && typeof data?.error === "string") throw clientError(data.error, 400);
  throw invalid(`status ${status}`);
}

// The known fields of an answer, checked.
function parsed<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw invalid(result.error.issues[0].message);
  return result.data;
}

export async function startCommand(id: string, cmd: string[]) {
  const { status, data } = await ask(id, "POST", "/commands", { cmd });
  if (status !== 201) refused(status, data);
  return parsed(CommandStarted, data);
}

export async function listCommands(id: string) {
  const { status, data } = await ask(id, "GET", "/commands");
  if (status !== 200) refused(status, data);
  return parsed(CommandItem.array(), data);
}

export async function readCommand(id: string, cid: string) {
  const { status, data } = await ask(id, "GET", `/commands/${cid}`);
  if (status !== 200) refused(status, data);
  return parsed(CommandState, data);
}

export async function stopCommand(id: string, cid: string) {
  const { status, data } = await ask(id, "POST", `/commands/${cid}/stop`);
  if (status !== 202) refused(status, data);
  return {};
}

// Opens a command's output. Refusals come before the first line; then `lines` gives the daemon's lines as they come, with
// no time limit. `signal` (the client leaving) and `close` end the relay.
export async function openOutput(id: string, cid: string, from: number, follow: boolean, signal: AbortSignal) {
  const relay = await open(await daemonOf(id), "GET", `/commands/${cid}/output?from=${from}&follow=${follow}`, undefined, signal);
  if (relay.res.statusCode !== 200) {
    const { status, data } = await answerOf(relay, AbortSignal.timeout(DEADLINE));
    refused(status, data);
  }
  return { lines: lines(relay, from), close: relay.close };
}

// The daemon's lines, checked and stripped to their known fields. They end with the closing line; a skipped line is not
// one, the output goes on after it. A line over 1 MiB, a malformed one or a broken relay end them with an error line
// saying where to resume.
async function* lines({ res, close }: Relay, from: number) {
  let next = from;
  let rest = Buffer.alloc(0);
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      rest = Buffer.concat([rest, chunk]);
      for (let end = rest.indexOf(10); end !== -1; end = rest.indexOf(10)) {
        if (end > MAX) break;
        let raw;
        try {
          raw = JSON.parse(rest.subarray(0, end).toString("utf8"));
        } catch {}
        rest = rest.subarray(end + 1);
        const line = DaemonLine.safeParse(raw);
        if (!line.success) {
          yield { error: "the sandbox daemon sent a malformed line", next };
          return;
        }
        next = line.data.next;
        yield line.data;
        if (!("stream" in line.data) && !("skipped" in line.data)) return;
      }
      if (rest.length > MAX) {
        yield { error: "the sandbox daemon sent a line over 1 MiB", next };
        return;
      }
    }
    yield { error: "the sandbox daemon's output ended without a closing line", next };
  } catch (error) {
    yield { error: `the relay to the sandbox broke: ${(error as Error).message}`, next };
  } finally {
    close();
  }
}
