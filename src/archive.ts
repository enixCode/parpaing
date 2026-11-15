// Folders in and out of a sandbox as tar archives, made by the sandbox's own tar. Docker's archive calls read the files on the
// host, which gVisor keeps in its own overlay, while tar runs inside and works the same on runc, runsc and Kata. parpaing only
// relays the bytes: it never unpacks an archive itself.
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type { Container, Exec } from "dockerode";
import { exitCode } from "./exec.ts";
import { clientError } from "./sandboxes.ts";

// Docker sends stdout and stderr in frames: 8 bytes of header (stream, size), then the bytes. Frames passes stdout on as a stream,
// with backpressure, so a slow client slows tar down instead of filling parpaing's memory, and keeps the start of stderr for the error.
class Frames extends Transform {
  stderr = "";
  #rest = Buffer.alloc(0);
  _transform(chunk: Buffer, _encoding: string, done: () => void) {
    let data = Buffer.concat([this.#rest, chunk]);
    while (data.length >= 8 && data.length >= 8 + data.readUInt32BE(4)) {
      const payload = data.subarray(8, 8 + data.readUInt32BE(4));
      if (data[0] !== 2) this.push(payload);
      else if (this.stderr.length < 4096) this.stderr += payload;
      data = data.subarray(8 + payload.length);
    }
    this.#rest = data;
    done();
  }
}

// tar's refusal in one sentence. A missing binary answers 127, with Docker's message on stdout.
function failure(code: number, stderr: string, path: string) {
  if (code === 127) return clientError("this image has no tar: archives need it in the sandbox");
  if (stderr.includes("No such file or directory")) return clientError(`no folder ${path} in this sandbox`, 404);
  return clientError(stderr.split("\n")[0].replace(/^tar: /, "") || `tar failed with exit code ${code}`);
}

async function start(container: Container, cmd: string[], stdin: boolean) {
  const exec: Exec = await container.exec({ Cmd: cmd, AttachStdin: stdin, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin });
  const frames = new Frames();
  stream.pipe(frames, { end: false });
  const ended = finished(stream, { writable: false })
    .catch(() => {})
    .then(() => exitCode(exec));
  return { stream, frames, ended };
}

// The folder's content as a tar stream. Errors (no tar, no folder) are thrown before the first byte. If tar fails midway, the
// stream breaks: the client never takes a cut archive for a whole one.
export async function readFolder(container: Container, path: string) {
  const { frames, ended } = await start(container, ["tar", "-cf", "-", "-C", path, "."], false);
  // A tar archive opens with a 512-byte header marked "ustar": until then, what came out may be an error message.
  const head = await new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const stop = () => {
      if (done) return;
      done = true;
      frames.off("data", take);
      frames.pause();
      resolve(Buffer.concat(chunks));
    };
    const take = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size >= 512) stop();
    };
    frames.on("data", take);
    ended.then(stop);
  });
  if (head.length < 512 || head.toString("latin1", 257, 262) !== "ustar") throw failure(await ended, frames.stderr, path);
  frames.unshift(head);
  ended.then((code) => (code === 0 ? frames.end() : frames.destroy(new Error(`tar stopped with exit code ${code}`))));
  return frames;
}

// Unpacks a tar stream into the folder, created if missing. Files in the archive replace those of the same name; others stay.
export async function writeFolder(container: Container, path: string, body: ReadableStream<Uint8Array>) {
  const made = await start(container, ["mkdir", "-p", path], false);
  made.frames.resume();
  const code = await made.ended;
  if (code !== 0) throw failure(code, made.frames.stderr, path);

  const { stream, frames, ended } = await start(container, ["tar", "-xf", "-", "-C", path], true);
  frames.resume();
  // tar may stop reading early (not an archive): its exit code says why.
  await pipeline(Readable.fromWeb(body as never), stream).catch(() => {});
  const result = await ended;
  if (result !== 0) throw failure(result, frames.stderr, path);
}
