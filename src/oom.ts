// The time of each sandbox's last out-of-memory kill, from Docker's oom events: why its commands were lost, when it restarted
// right after. Only a hint, kept in memory: after a parpaing restart it is empty, and a 410 only loses its reason.
import Docker from "dockerode";
import { LABEL } from "./sandboxes.ts";

const docker = new Docker();
const lastOom = new Map<string, number>();

// Whether the container had an oom within the 2 minutes before it started at `startedAt` (ms).
export const oomBefore = (id: string, startedAt: number) => {
  const at = lastOom.get(id);
  return at !== undefined && at <= startedAt && startedAt - at <= 120_000;
};

// From start, for parpaing's whole life: a stream that ends or fails is opened again 5 s later.
export function followOom() {
  let retried = false;
  const again = (error?: Error) => {
    if (retried) return;
    retried = true;
    if (error) console.error(`oom events: ${error.message}`);
    setTimeout(followOom, 5000);
  };
  docker
    .getEvents({ filters: { type: ["container"], event: ["oom"], label: [LABEL] } })
    .then((events) => {
      // One JSON object per line, and a chunk may hold several or half of one.
      let rest = "";
      events.on("data", (chunk) => {
        const lines = (rest + chunk).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            lastOom.set(event.Actor.ID, event.time * 1000);
          } catch {}
        }
      });
      events.on("end", () => again());
      events.on("error", again);
    })
    .catch(again);
}
