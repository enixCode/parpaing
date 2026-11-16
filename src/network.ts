// Each sandbox sits alone in its own Docker internal network: no route out, no address on the host side, so no host, no LAN,
// no cloud metadata, no other sandbox. Its only way out is the egress proxy (egress/), which has a leg in every sandbox
// network at address .2 and refuses private destinations. Nothing is set on the host.
import Docker from "dockerode";

const docker = new Docker();
const EGRESS = "parpaing-egress";
const PORT = 3128;
export const NETWORK_LABEL = "parpaing.network";
// parpaing's own address range, cut into networks of 16 addresses, one per sandbox: Docker's default pools hold about thirty.
const RANGE = process.env.PARPAING_SUBNETS || "10.89.0.0/16";

const toInt = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
const toIp = (n: number) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".");
// The proxy takes the second address of a network; the first belongs to a gateway that does not exist.
const proxyOf = (subnet: string) => toIp(toInt(subnet.split("/")[0]) + 2);

// What sends programs through the proxy: curl, apt, pip, npm and git over https read the HTTP variables, SOCKS clients ALL_PROXY,
// ssh takes PARPAING_PROXY in a ProxyCommand. An address, not a name: Docker's DNS does not answer under gVisor; the proxy resolves names.
export function proxyEnv(proxy: string) {
  const http = `http://${proxy}:${PORT}`;
  const socks = `socks5h://${proxy}:${PORT}`;
  return [
    ...["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].map((name) => `${name}=${http}`),
    ...["ALL_PROXY", "all_proxy"].map((name) => `${name}=${socks}`),
    ...["NO_PROXY", "no_proxy"].map((name) => `${name}=localhost,127.0.0.1`),
    `PARPAING_PROXY=${proxy}:${PORT}`,
  ];
}

async function connectEgress(network: Docker.Network, subnet: string) {
  await network.connect({ Container: EGRESS, EndpointConfig: { IPAMConfig: { IPv4Address: proxyOf(subnet) } } });
}

// A new network on the first free block of the range, with the proxy in it. Two creations at once may aim at the same block:
// the loser moves to the next one.
export async function createNetwork() {
  const [base, bits] = RANGE.split("/");
  const used = new Set((await docker.listNetworks()).flatMap((network) => (network.IPAM?.Config ?? []).map((config) => config.Subnet)));
  for (let block = 0; block < 2 ** (28 - Number(bits)); block++) {
    const start = toIp(toInt(base) + block * 16);
    const subnet = `${start}/28`;
    if (used.has(subnet)) continue;
    const name = `parpaing-net-${start.replaceAll(".", "-")}`;
    const network = await docker
      .createNetwork({
        Name: name,
        Internal: true,
        Labels: { [NETWORK_LABEL]: "" },
        // No address for the host on this network: the sandbox cannot reach it.
        Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
        IPAM: { Config: [{ Subnet: subnet }] },
      })
      .catch((error) => {
        if (/overlap|already exists/i.test(error.message)) return undefined;
        throw error;
      });
    if (!network) continue;
    await connectEgress(network, subnet).catch(async (error) => {
      await network.remove().catch(() => {});
      throw new Error(`egress proxy ${EGRESS} unreachable (${error.message}); start it with docker compose up -d`);
    });
    return { name, proxy: proxyOf(subnet) };
  }
  throw Object.assign(new Error(`no free network left in ${RANGE}`), { statusCode: 503 });
}

// Docker refuses to remove a network something is still connected to: the proxy leaves first.
export async function removeNetwork(name: string) {
  const network = docker.getNetwork(name);
  await network.disconnect({ Container: EGRESS, Force: true }).catch(() => {});
  await network.remove().catch((error) => {
    if (error.statusCode !== 404) throw error;
  });
}

// A proxy started again from a new container (new image, docker compose up) has lost its legs: every sandbox network gets it back.
async function reconnect() {
  const networks = await docker.listNetworks({ filters: { label: [NETWORK_LABEL] } });
  for (const { Name, IPAM } of networks) {
    const subnet = IPAM?.Config?.[0]?.Subnet;
    const network = docker.getNetwork(Name);
    const { Containers } = await network.inspect();
    if (!subnet || Object.values(Containers ?? {}).some((container) => (container as { Name: string }).Name === EGRESS)) continue;
    await connectEgress(network, subnet).catch((error) => console.error(`network ${Name}: ${error.message}`));
  }
}

// At start, then each time the proxy starts.
export async function followEgress() {
  await reconnect().catch((error) => console.error(`egress: ${error.message}`));
  const events = await docker.getEvents({ filters: { container: [EGRESS], event: ["start"] } });
  events.on("data", () => void reconnect().catch((error) => console.error(`egress: ${error.message}`)));
}
