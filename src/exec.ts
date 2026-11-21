// The end of a docker exec: archive.ts waits for tar's exit code with it.
import { setTimeout as sleep } from "node:timers/promises";
import type { Exec } from "dockerode";

// The exit code of a finished command. Its output can close just before Docker records the end.
export async function exitCode(exec: Exec) {
  let info = await exec.inspect();
  while (info.Running) {
    await sleep(10);
    info = await exec.inspect();
  }
  return info.ExitCode as number;
}
