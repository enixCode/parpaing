// Sandboxes: one Docker container each, recognized by its parpaing.sandbox label. Docker keeps
// everything, this file holds no state.
import { readFileSync } from "node:fs";
import Docker from "dockerode";

const docker = new Docker();
const LABEL = "parpaing.sandbox";
// Image used when the request does not name one.
const IMAGE = "debian:trixie-slim";

const stateOf = (running: boolean) => (running ? "running" : "stopped");
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

// An error caused by the image (not found, private, misspelled, no sleep): the API refuses it with a 400
// and Docker's message, without its "(HTTP code 404) unexpected - " prefix.
const imageError = (image: string, error: Error) =>
  Object.assign(new Error(`image ${image}: ${error.message.replace(/^\(HTTP code \d+\)[^-]*- /, "").trim()}`), { statusCode: 400 });

export async function create(image = IMAGE) {
  // sleep infinity does nothing and never ends: the container stays on.
  const options = { Image: image, Entrypoint: ["sleep", "infinity"], Labels: { [LABEL]: "" } };
  const container = await docker.createContainer(options).catch(async (error) => {
    if (error.statusCode === 400) throw imageError(image, error);
    if (error.statusCode !== 404) throw error;
    await pull(image).catch((error) => {
      throw imageError(image, error);
    });
    return docker.createContainer(options);
  });
  // An image without sleep does not start: the failed container is removed.
  await container.start().catch(async (error) => {
    await container.remove({ force: true });
    throw error.statusCode === 400 ? imageError(image, error) : error;
  });
  return { id: shortId(container.id), state: "running" };
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
  return { container, running: info.State.Running };
}

export async function get(id: string) {
  const found = await find(id);
  return found && { id, state: stateOf(found.running) };
}

// Returns false when the sandbox does not exist.
export async function remove(id: string) {
  const found = await find(id);
  if (!found) return false;
  await found.container.remove({ force: true });
  return true;
}
