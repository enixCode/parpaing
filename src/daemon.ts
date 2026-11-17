// The sandbox daemon (daemon/, Go). parpaing's image holds its binary; at start, parpaing copies it into the
// parpaing-daemon volume, mounted at /daemon here. Every new sandbox mounts that volume read-only at /.parpaing and runs
// the daemon as its main process, so any image works, even one without a shell or sleep.
import { chmod, copyFile, rename } from "node:fs/promises";

export const DAEMON_VOLUME = "parpaing-daemon";
export const DAEMON_LABEL = "parpaing.daemon";
// Where a sandbox finds it.
export const DAEMON_DIR = "/.parpaing";
export const DAEMON_PATH = `${DAEMON_DIR}/parpaingd`;
// /app/parpaingd in the image, built by the Dockerfile's Go stage.
const SOURCE = new URL("../parpaingd", import.meta.url);
const TARGET = "/daemon/parpaingd";

// Copied under a temporary name, then renamed: a sandbox starting meanwhile gets the old binary or the new one, never
// half of one, and a sandbox already running keeps the file it started with.
export async function installDaemon() {
  await copyFile(SOURCE, `${TARGET}.new`);
  await chmod(`${TARGET}.new`, 0o755);
  await rename(`${TARGET}.new`, TARGET);
}
