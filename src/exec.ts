// One command in a sandbox: its output chunk by chunk, then its exit code.
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import type { Container } from "dockerode";

export type Output = "stdout" | "stderr";

// Starts the command; a Docker error (sandbox stopped…) lands here, before any output. The
// returned function follows the command to the end: each chunk goes to onOutput as soon as it
// arrives, then it returns the exit code.
export async function startCommand(container: Container, cmd: string[]) {
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const output = await exec.start({ hijack: true, stdin: false });

  return async (onOutput: (name: Output, data: string) => void) => {
    // Docker mixes stdout and stderr into one stream: demuxStream splits them. One decoder per stream
    // holds a character cut between two chunks until the next chunk.
    const sink = (name: Output) => {
      const decoder = new StringDecoder("utf8");
      return new Writable({
        write(chunk, _encoding, done) {
          const data = decoder.write(chunk);
          if (data) onOutput(name, data);
          done();
        },
      });
    };
    container.modem.demuxStream(output, sink("stdout"), sink("stderr"));
    await finished(output, { writable: false });
    // The stream can close just before Docker records the end of the command.
    let info = await exec.inspect();
    while (info.Running) {
      await sleep(10);
      info = await exec.inspect();
    }
    return info.ExitCode as number;
  };
}
