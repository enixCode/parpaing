// Sandboxes: one Docker container each, recognized by its parpaing.sandbox label. Docker keeps
// everything, this file holds no state.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import Docker from "dockerode";
import { DAEMON_DIR, DAEMON_LABEL, DAEMON_PATH, DAEMON_VOLUME } from "./daemon.ts";
import { createNetwork, NETWORK_LABEL, proxyEnv, removeNetwork } from "./network.ts";

const docker = new Docker();
export const LABEL = "parpaing.sandbox";
// Image used when the request does not name one.
const IMAGE = "debian:trixie-slim";
// The agent is root in its sandbox, so apt and pip work, but root keeps only these powers: files, users, its own
// processes, ports below 1024, audit messages (sudo writes one). Every other capability is dropped and nothing gets it back, sudo included.
// no-new-privileges is not set: it would break sudo in images that start as a non-root user, and the cap above
// already bounds every process.
const CAPABILITIES = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "NET_BIND_SERVICE", "AUDIT_WRITE"];

// Limits are ceilings, not reservations: a sandbox only uses what it consumes, so a small server holds many.
// Defaults come from compose (PARPAING_*), a request can ask for others. Memory and disk in MB.
export type Limits = { memory: number; cpus: number; processes: number; disk: number };
const setting = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const DEFAULTS: Limits = {
  memory: setting("PARPAING_MEMORY", 1024),
  cpus: setting("PARPAING_CPUS", 1),
  processes: setting("PARPAING_PROCESSES", 1024),
  disk: setting("PARPAING_DISK", 10240),
};
// The engine a sandbox gets when the request names none: runc, or runsc (gVisor) on a production machine.
const RUNTIME = process.env.PARPAING_RUNTIME || "runc";
// Free memory kept for the system, Docker and parpaing: under it, no new sandbox.
const RESERVED = setting("PARPAING_RESERVED_MEMORY", 512);
const MB = 1024 * 1024;
// The disk limit is recorded on every engine; runsc enforces it (see create), runc and Kata cannot without host setup.
const DISK_LABEL = "parpaing.disk";

// The machine's free memory. parpaing's own container has no memory limit, so /proc/meminfo shows the host's.
function memoryAvailable() {
  const found = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m);
  return found ? Number(found[1]) * 1024 : Infinity;
}

export const clientError = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// The engine must be one Docker knows, and a limit cannot exceed the machine. Under the reserve of free memory, a new sandbox
// waits, checked every second for up to `wait` seconds, then is refused. Answers whether the engine is gVisor.
async function fits(limits: Limits, runtime: string, wait: number) {
  const host = await docker.info();
  const engines: Record<string, { path: string }> = host.Runtimes ?? {};
  if (!engines[runtime]) throw clientError(`runtime: one of ${Object.keys(engines).join(", ")} on this machine`);
  if (limits.memory * MB > host.MemTotal) throw clientError(`memory: at most ${Math.floor(host.MemTotal / MB)} MB on this machine`);
  if (limits.cpus > host.NCPU) throw clientError(`cpus: at most ${host.NCPU} on this machine`);
  for (let waited = 0; memoryAvailable() < RESERVED * MB; waited++) {
    if (waited >= wait) throw clientError(`not enough free memory on this machine (reserve: ${RESERVED} MB); try again later, or ask to wait with "wait"`, 503);
    await sleep(1000);
  }
  return basename(engines[runtime].path) === "runsc";
}

const stateOf = (running: boolean): "running" | "stopped" => (running ? "running" : "stopped");
// A sandbox id is the start of its container's Docker id: 12 hex characters.
const shortId = (id: string) => id.slice(0, 12);

// On create, Docker refuses a missing image instead of downloading it: parpaing asks for it,
// then waits for the download to finish.
async function pull(image: string) {
  const progress = await docker.pull(image);
  await new Promise((resolve, reject) => {
    docker.modem.followProgress(progress, (error: Error | null, output: unknown) => (error ? reject(error) : resolve(output)));
  });
}

// An error caused by the image (not found, private, misspelled): the API refuses it with a 400
// and Docker's message, without its "(HTTP code 404) unexpected - " prefix.
const imageError = (image: string, error: Error) =>
  Object.assign(new Error(`image ${image}: ${error.message.replace(/^\(HTTP code \d+\)[^-]*- /, "").trim()}`), { statusCode: 400 });

export async function create({
  image = IMAGE,
  wait = 0,
  runtime = RUNTIME,
  network = "internet",
  ...asked
}: { image?: string; wait?: number; runtime?: string; network?: "internet" | "none" } & Partial<Limits>) {
  const limits = { ...DEFAULTS };
  for (const [key, value] of Object.entries(asked)) if (value !== undefined) limits[key as keyof Limits] = value;
  const gvisor = await fits(limits, runtime, wait);
  // Internet goes through the egress proxy only, from the sandbox's own network; "none" gives no network at all.
  const net = network === "none" ? undefined : await createNetwork();
  // The daemon is the main process, from the read-only parpaing-daemon volume: the container stays on whatever the image holds.
  const options = {
    Image: image,
    Entrypoint: [DAEMON_PATH],
    Labels: { [LABEL]: "", [DISK_LABEL]: String(limits.disk), [NETWORK_LABEL]: net?.name ?? "none", [DAEMON_LABEL]: "1" },
    // The agent reads its limits with env: on runc, nproc, free and df show the whole machine.
    Env: [
      `PARPAING_MEMORY_MB=${limits.memory}`,
      `PARPAING_CPUS=${limits.cpus}`,
      `PARPAING_PROCESSES=${limits.processes}`,
      `PARPAING_DISK_MB=${limits.disk}`,
      ...(net ? proxyEnv(net.proxy) : []),
    ],
    HostConfig: {
      Runtime: runtime,
      NetworkMode: net?.name ?? "none",
      Mounts: [{ Type: "volume" as const, Source: DAEMON_VOLUME, Target: DAEMON_DIR, ReadOnly: true }],
      CapDrop: ["ALL"],
      CapAdd: CAPABILITIES,
      // No swap: past its memory, the kernel kills a process of this sandbox, and only of this one.
      Memory: limits.memory * MB,
      MemorySwap: limits.memory * MB,
      NanoCpus: Math.round(limits.cpus * 1e9),
      PidsLimit: limits.processes,
      // If the whole machine runs out of memory, the kernel kills sandbox processes first, not parpaing or Docker.
      OomScoreAdj: 500,
      // Back after a restart of the machine or of Docker, with its files but without the processes it ran.
      RestartPolicy: { Name: "unless-stopped" },
      // gVisor keeps what the sandbox writes in its own overlay and stops it at this size. overlay2 is one of the runsc settings a
      // container may set by annotation, with no change to the runtime's config; runc and Kata ignore the annotation.
      ...(gvisor && { Annotations: { "dev.gvisor.flag.overlay2": `root:self,size=${limits.disk}m` } }),
    },
  };
  try {
    const container = await docker.createContainer(options).catch(async (error) => {
      if (error.statusCode === 400) throw imageError(image, error);
      if (error.statusCode !== 404) throw error;
      await pull(image).catch((error) => {
        throw imageError(image, error);
      });
      return docker.createContainer(options);
    });
    // A container that does not start is removed.
    await container.start().catch(async (error) => {
      await container.remove({ force: true });
      throw error.statusCode === 400 ? imageError(image, error) : error;
    });
    return { id: shortId(container.id), state: stateOf(true), runtime, network, ...limits };
  } catch (error) {
    if (net) await removeNetwork(net.name);
    throw error;
  }
}

export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// The engines are the runtimes Docker offers (runc, and runsc once gVisor is installed).
export async function info() {
  const [host, containers] = await Promise.all([docker.info(), docker.listContainers({ all: true, filters: { label: [LABEL] } })]);
  const running = containers.filter((container) => container.State === "running").length;
  return {
    name: "parpaing",
    version: VERSION,
    engines: Object.keys(host.Runtimes ?? {}),
    cpus: host.NCPU,
    memory: host.MemTotal,
    memoryAvailable: memoryAvailable(),
    memoryReserved: RESERVED * MB,
    sandboxes: { total: containers.length, running },
  };
}

export async function list() {
  const containers = await docker.listContainers({ all: true, filters: { label: [LABEL] } });
  return containers.map((container) => ({ id: shortId(container.Id), state: stateOf(container.State === "running") }));
}

// The sandbox's container, or nothing: a container without the label is not a sandbox.
export async function find(id: string) {
  const container = docker.getContainer(id);
  const info = await container.inspect().catch((error) => {
    if (error.statusCode !== 404) throw error;
  });
  if (info?.Config.Labels?.[LABEL] === undefined) return undefined;
  return { container, running: info.State.Running, info };
}

// The container of a running sandbox, for a command or an archive. Refused otherwise.
export async function running(id: string) {
  const found = await find(id);
  if (!found) throw clientError("unknown sandbox", 404);
  if (!found.running) throw clientError("sandbox stopped", 409);
  return found.container;
}

// A sandbox created before limits existed has none: null.
export async function get(id: string) {
  const found = await find(id);
  if (!found) return undefined;
  const { HostConfig: host, Config: config } = found.info;
  const or = (value: number | null | undefined) => value || null;
  return {
    id,
    state: stateOf(found.running),
    runtime: host.Runtime ?? "runc",
    network: config.Labels?.[NETWORK_LABEL] === "none" ? ("none" as const) : ("internet" as const),
    memory: or((host.Memory ?? 0) / MB),
    cpus: or((host.NanoCpus ?? 0) / 1e9),
    processes: or(host.PidsLimit),
    disk: or(Number(config.Labels?.[DISK_LABEL])),
  };
}

// Returns false when the sandbox does not exist.
export async function remove(id: string) {
  const found = await find(id);
  if (!found) return false;
  await found.container.remove({ force: true });
  const network = found.info.Config.Labels?.[NETWORK_LABEL];
  if (network && network !== "none") await removeNetwork(network);
  return true;
}
