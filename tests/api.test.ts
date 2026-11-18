// API tests: they call a running parpaing (docker compose up -d) through its gateway, Docker included.
// PARPAING_URL picks the address (http://127.0.0.1:8090 by default), PARPAING_API_KEY the key when parpaing runs with one.
// Each test deletes the sandboxes it creates, and only those.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.PARPAING_URL ?? "http://127.0.0.1:8090";
const KEY = process.env.PARPAING_API_KEY;
// The engine parpaing gives by default; CI runs the suite once on runc, once on runsc (gVisor).
const RUNTIME = process.env.PARPAING_RUNTIME || "runc";
const GVISOR = RUNTIME === "runsc";
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const created: string[] = [];

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = {
    method,
    headers: { ...(KEY ? { authorization: `Bearer ${KEY}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
  };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  return { status: res.status, data, text, headers: res.headers };
}

async function newSandbox() {
  const res = await api("POST", "/sandboxes", {});
  assert.equal(res.status, 201);
  created.push(res.data.id);
  return res.data.id as string;
}

const lines = (text: string) => text.trim().split("\n").map((line) => JSON.parse(line));
// The whole stdout of a command, whatever chunks it came in.
const stdout = (text: string) => JSON.parse(text).stdout as string;
// One answer when the command ends (the default), or the live stream.
const exec = (id: string, cmd: unknown) => api("POST", `/sandboxes/${id}/exec`, { cmd });
const execStream = (id: string, cmd: unknown) => api("POST", `/sandboxes/${id}/exec`, { cmd, stream: true });

after(async () => {
  for (const id of created) await api("DELETE", `/sandboxes/${id}`);
});

describe("sandboxes", () => {
  test("create, read, list, delete", async () => {
    const res = await api("POST", "/sandboxes", { image: "debian:trixie-slim" });
    assert.equal(res.status, 201);
    assert.match(res.data.id, /^[0-9a-f]{12}$/);
    assert.equal(res.data.state, "running");
    const { id } = res.data;
    created.push(id);

    assert.equal((await api("GET", `/sandboxes/${id}`)).data.state, "running");
    assert.ok((await api("GET", "/sandboxes")).data.some((sandbox: { id: string }) => sandbox.id === id));
    assert.equal((await api("DELETE", `/sandboxes/${id}`)).status, 204);
    assert.equal((await api("GET", `/sandboxes/${id}`)).status, 404);
    assert.deepEqual((await api("DELETE", `/sandboxes/${id}`)).data, { error: "unknown sandbox" });
  });

  test("refuses a bad image name with an example", async () => {
    for (const image of ["", null, 3]) {
      const res = await api("POST", "/sandboxes", { image });
      assert.equal(res.status, 400);
      assert.equal(res.data.error, "image: an image name, for example debian:trixie-slim");
    }
  });

  test("refuses an image Docker cannot find, with Docker's reason", async () => {
    const res = await api("POST", "/sandboxes", { image: "parpaing-test/does-not-exist:0" });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /^image parpaing-test\/does-not-exist:0: /);
  });

  test("an unknown or malformed id is an unknown sandbox", async () => {
    for (const id of ["000000000000", "nothex"]) {
      const res = await api("GET", `/sandboxes/${id}`);
      assert.equal(res.status, 404);
      assert.deepEqual(res.data, { error: "unknown sandbox" });
    }
  });
});

describe("daemon", () => {
  test("is PID 1, and runs images without a shell or sleep", async () => {
    const id = await newSandbox();
    assert.equal((await exec(id, ["sh", "-c", "tr '\\0' ' ' </proc/1/cmdline"])).data.stdout, "/.parpaing/parpaingd ");
    const bare = await api("POST", "/sandboxes", { image: "hello-world" });
    assert.equal(bare.status, 201);
    created.push(bare.data.id);
    assert.equal((await api("GET", `/sandboxes/${bare.data.id}`)).data.state, "running");
  });

  test("collects the processes left behind", async () => {
    const id = await newSandbox();
    // Each subshell ends at once: its sleep goes to PID 1, and is a zombie once it ends unless PID 1 collects it.
    for (let i = 0; i < 10; i++) await exec(id, ["sh", "-c", "(sleep 0.2 &); true"]);
    const count = ["sh", "-c", "grep -l '^State:.Z' /proc/[0-9]*/status 2>/dev/null | wc -l"];
    let zombies = "";
    for (let tries = 0; tries < 20 && zombies !== "0"; tries++) {
      await sleep(500);
      zombies = (await exec(id, count)).data.stdout.trim();
    }
    assert.equal(zombies, "0");
  });

  test("cannot be ended from inside", async () => {
    const id = await newSandbox();
    // PID 1's start time changes if the sandbox restarts.
    const started = async () => (await exec(id, ["sh", "-c", "cut -d' ' -f22 /proc/1/stat"])).data.stdout;
    const before = await started();
    for (const signal of ["TERM", "INT", "HUP", "QUIT", "USR1"]) await exec(id, ["kill", `-${signal}`, "1"]);
    await exec(id, ["sh", "-c", "kill -9 -1"]);
    await sleep(1500);
    assert.equal((await api("GET", `/sandboxes/${id}`)).data.state, "running");
    assert.equal(await started(), before);
  });

  test("answers ping on its local socket, with or without network, even after rm -rf /tmp", async () => {
    const offline = await api("POST", "/sandboxes", { network: "none" });
    assert.equal(offline.status, 201);
    created.push(offline.data.id);
    for (const id of [await newSandbox(), offline.data.id]) {
      // On runsc, /tmp is a mount point: rm empties it and fails on the folder itself.
      const ping = await exec(id, ["sh", "-c", "rm -rf /tmp; /.parpaing/parpaingd ping"]);
      assert.equal(ping.data.exitCode, 0, ping.data.stderr);
      assert.deepEqual(JSON.parse(ping.data.stdout), { ok: true, version: 1 });
    }
  });

  // A timeout: a second daemon that took the socket would never return.
  test("a second daemon started inside stops at once, the first keeps answering", { timeout: 30_000 }, async () => {
    const id = await newSandbox();
    const second = await exec(id, ["/.parpaing/parpaingd"]);
    assert.equal(second.data.exitCode, 1);
    assert.match(second.data.stderr, /in use/);
    assert.equal((await exec(id, ["/.parpaing/parpaingd", "ping"])).data.exitCode, 0);
  });
});

describe("limits", () => {
  test("a new sandbox gets the default ceilings", async () => {
    const res = await api("POST", "/sandboxes", {});
    assert.equal(res.status, 201);
    created.push(res.data.id);
    assert.deepEqual(
      { runtime: res.data.runtime, memory: res.data.memory, cpus: res.data.cpus, processes: res.data.processes, disk: res.data.disk },
      { runtime: RUNTIME, memory: 1024, cpus: 1, processes: 1024, disk: 10240 },
    );
  });

  test("asked ceilings are applied by the kernel and readable inside", async () => {
    const res = await api("POST", "/sandboxes", { memory: 256, cpus: 0.5, processes: 100, disk: 2048 });
    assert.equal(res.status, 201);
    const { id } = res.data;
    created.push(id);
    assert.deepEqual((await api("GET", `/sandboxes/${id}`)).data, { id, state: "running", runtime: RUNTIME, network: "internet", memory: 256, cpus: 0.5, processes: 100, disk: 2048 });
    const env = await exec(id, ["sh", "-c", "env | grep -E '^PARPAING_(CPUS|DISK_MB|MEMORY_MB|PROCESSES)=' | sort"]);
    assert.deepEqual(stdout(env.text).trim().split("\n"), [
      "PARPAING_CPUS=0.5",
      "PARPAING_DISK_MB=2048",
      "PARPAING_MEMORY_MB=256",
      "PARPAING_PROCESSES=100",
    ]);
    // runc shows the host's cgroup files; gVisor has its own, and shows the memory limit in free instead.
    const cgroup = GVISOR ? "grep MemTotal /proc/meminfo | tr -s ' '" : "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/pids.max";
    const kernel = stdout((await exec(id, ["sh", "-c", cgroup])).text).trim().split("\n");
    assert.deepEqual(kernel, GVISOR ? [`MemTotal: ${256 * 1024} kB`] : [String(256 * 1024 * 1024), "50000 100000", "100"]);
  });

  test("past its memory, the command is killed", async () => {
    const res = await api("POST", "/sandboxes", { memory: 64 });
    const { id } = res.data;
    created.push(id);
    // tail keeps the last lines of an endless input without newlines: its memory grows until the kernel stops it.
    const run = await exec(id, ["sh", "-c", "tail /dev/zero"]);
    assert.notEqual(run.data.exitCode, 0);
    // runc kills one process and the sandbox lives on; gVisor stops the whole sandbox, which Docker then starts again.
    if (!GVISOR) {
      assert.equal(run.data.exitCode, 137);
      assert.equal((await api("GET", `/sandboxes/${id}`)).data.state, "running");
    }
  });

  test("the disk limit holds on runsc", { skip: GVISOR ? false : "runc cannot enforce it without host setup" }, async () => {
    const res = await api("POST", "/sandboxes", { disk: 100 });
    const { id } = res.data;
    created.push(id);
    const run = await exec(id, ["sh", "-c", "dd if=/dev/zero of=/big bs=1M count=300; ls -l /big"]);
    assert.match(run.text, /No space left on device/);
    assert.match(stdout(run.text), / 104857600 /);
  });

  test("refuses an engine this machine lacks, listing those it has", async () => {
    const res = await api("POST", "/sandboxes", { runtime: "nope" });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /^runtime: one of .*runc.* on this machine$/);
  });

  test("refuses limits that are not numbers in range, with an example", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ memory: 0 }, /^memory: /],
      [{ memory: 1.5 }, /^memory: /],
      [{ memory: "1g" }, /^memory: /],
      [{ cpus: 0 }, /^cpus: /],
      [{ processes: 4 }, /^processes: /],
      [{ disk: 0 }, /^disk: /],
      [{ wait: 301 }, /^wait: /],
    ];
    for (const [body, error] of cases) {
      const res = await api("POST", "/sandboxes", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.data.error, error);
    }
  });

  test("refuses more than the machine has", async () => {
    const memory = await api("POST", "/sandboxes", { memory: 100_000_000 });
    assert.equal(memory.status, 400);
    assert.match(memory.data.error, /^memory: at most \d+ MB on this machine$/);
    const cpus = await api("POST", "/sandboxes", { cpus: 10_000 });
    assert.equal(cpus.status, 400);
    assert.match(cpus.data.error, /^cpus: at most \d+ on this machine$/);
  });
});

describe("commands", () => {
  test("answers once with the exit code, stdout and stderr apart", async () => {
    const res = await exec(await newSandbox(), ["sh", "-c", "echo out; echo oops >&2; exit 3"]);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(res.data, { exitCode: 3, stdout: "out\n", stderr: "oops\n", truncated: false });
  });

  test("cuts an output past 10 MB and says so", async () => {
    const res = await exec(await newSandbox(), ["sh", "-c", "head -c 11000000 /dev/zero | tr '\\0' a"]);
    assert.equal(res.data.exitCode, 0);
    assert.equal(res.data.truncated, true);
    assert.equal(res.data.stdout.length, 10 * 1024 * 1024);
  });

  test("with stream, sends stdout, then the exit code", async () => {
    const res = await execStream(await newSandbox(), ["sh", "-c", "echo ok"]);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-ndjson");
    assert.deepEqual(lines(res.text), [{ stream: "stdout", data: "ok\n" }, { exitCode: 0 }]);
  });

  test("with stream, keeps stderr apart and returns a failing exit code", async () => {
    const res = await execStream(await newSandbox(), ["sh", "-c", "echo oops >&2; exit 3"]);
    assert.deepEqual(lines(res.text), [{ stream: "stderr", data: "oops\n" }, { exitCode: 3 }]);
  });

  test("with stream, sends each chunk as it comes, not at the end", async () => {
    const id = await newSandbox();
    const started = performance.now();
    const res = await fetch(`${BASE}/sandboxes/${id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify({ cmd: ["sh", "-c", "echo first; sleep 2; echo second"], stream: true }),
    });
    const reader = res.body!.getReader();
    await reader.read();
    const first = performance.now() - started;
    while (!(await reader.read()).done);
    const total = performance.now() - started;
    assert.ok(total - first > 1500, `first chunk after ${Math.round(first)} ms, end after ${Math.round(total)} ms`);
  });

  test("refuses a missing or malformed command with an example", async () => {
    const id = await newSandbox();
    for (const cmd of [undefined, [], [1], "ls"]) {
      const res = await exec(id, cmd);
      assert.equal(res.status, 400);
      assert.equal(res.data.error, 'cmd: a command as an array, for example ["ls", "-la"]');
    }
    const stream = await api("POST", `/sandboxes/${id}/exec`, { cmd: ["true"], stream: "yes" });
    assert.equal(stream.status, 400);
    assert.match(stream.data.error, /^stream: /);
  });

  test("root keeps only the 9 capabilities parpaing grants, for good", async () => {
    // CHOWN, DAC_OVERRIDE, FOWNER, FSETID, KILL, SETGID, SETUID, NET_BIND_SERVICE, AUDIT_WRITE = 0x200004fb. CapBnd is the cap nothing can exceed.
    const res = await exec(await newSandbox(), ["sh", "-c", "grep -E '^Cap(Eff|Bnd):' /proc/self/status"]);
    const status = Object.fromEntries(stdout(res.text).trim().split("\n").map((line: string) => line.split(/:\s+/)));
    assert.deepEqual(status, { CapEff: "00000000200004fb", CapBnd: "00000000200004fb" });
  });

  test("refuses an unknown sandbox", async () => {
    for (const id of ["000000000000", "nothex"]) {
      const res = await exec(id, ["true"]);
      assert.equal(res.status, 404);
      assert.deepEqual(res.data, { error: "unknown sandbox" });
    }
  });
});

describe("network", () => {
  // Asks the proxy for a tunnel, as curl does with HTTPS_PROXY: the first line of its answer says whether it agreed.
  const tunnel = (id: string, target: string) =>
    exec(id, [
      "bash",
      "-c",
      'exec 3<>/dev/tcp/${PARPAING_PROXY%:*}/${PARPAING_PROXY#*:}; printf "CONNECT ' + target + ' HTTP/1.1\\r\\nHost: ' + target + '\\r\\n\\r\\n" >&3; timeout 15 head -1 <&3',
    ]);
  const agreed = (text: string) => /^HTTP\/1\.[01] 200/.test(stdout(text));

  test("reaches the internet through the proxy, raw TCP included", async () => {
    const id = await newSandbox();
    assert.ok(agreed((await tunnel(id, "example.com:443")).text), "https");
    assert.ok(agreed((await tunnel(id, "github.com:22")).text), "ssh");
  });

  test("has no direct way out", async () => {
    const id = await newSandbox();
    const run = await exec(id, ["bash", "-c", "timeout 5 bash -c '</dev/tcp/1.1.1.1/443'"]);
    assert.notEqual(run.data.exitCode, 0);
  });

  test("the proxy refuses the host, the local network, metadata and other sandboxes", async () => {
    const id = await newSandbox();
    const other = await newSandbox();
    const address = stdout((await exec(other, ["sh", "-c", "grep \"$(cat /etc/hostname)\" /etc/hosts | cut -f1"])).text).trim();
    assert.match(address, /^10\.89\./);
    for (const target of ["169.254.169.254:80", "172.17.0.1:2375", "192.168.1.1:80", "10.0.0.1.nip.io:80", `${address}:22`]) {
      assert.ok(!agreed((await tunnel(id, target)).text), target);
    }
  });

  test("none gives no network at all", async () => {
    const res = await api("POST", "/sandboxes", { network: "none" });
    assert.equal(res.status, 201);
    created.push(res.data.id);
    assert.equal(res.data.network, "none");
    const interfaces = stdout((await exec(res.data.id, ["sh", "-c", "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '"])).text).trim();
    assert.equal(interfaces, "lo");
  });

  test("refuses an unknown network mode", async () => {
    const res = await api("POST", "/sandboxes", { network: "lan" });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /^network: /);
  });
});

describe("archives", () => {
  const auth: Record<string, string> = KEY ? { authorization: `Bearer ${KEY}` } : {};
  const download = (id: string, path: string) => fetch(`${BASE}/sandboxes/${id}/archive?path=${path}`, { headers: auth });
  const upload = (id: string, path: string, body: BodyInit) =>
    fetch(`${BASE}/sandboxes/${id}/archive?path=${path}`, { method: "PUT", headers: { ...auth, "content-type": "application/x-tar" }, body });

  test("a folder goes out as a tar and comes back in another folder", async () => {
    const id = await newSandbox();
    await exec(id, ["sh", "-c", "mkdir -p /data/sub && echo hello > /data/a.txt && echo deep > /data/sub/b.txt"]);
    const out = await download(id, "/data");
    assert.equal(out.status, 200);
    assert.equal(out.headers.get("content-type"), "application/x-tar");
    const tar = await out.arrayBuffer();
    assert.equal(Buffer.from(tar).toString("latin1", 257, 262), "ustar");
    assert.equal((await upload(id, "/copy/here", tar)).status, 204);
    assert.equal(stdout((await exec(id, ["cat", "/copy/here/a.txt", "/copy/here/sub/b.txt"])).text), "hello\ndeep\n");
  });

  test("a big folder streams out and in whole", async () => {
    const id = await newSandbox();
    await exec(id, ["sh", "-c", "mkdir /big && head -c 30000000 /dev/urandom > /big/blob"]);
    const tar = await (await download(id, "/big")).arrayBuffer();
    assert.ok(tar.byteLength > 30000000);
    assert.equal((await upload(id, "/big2", tar)).status, 204);
    const sums = stdout((await exec(id, ["sh", "-c", "sha256sum < /big/blob; sha256sum < /big2/blob"])).text).split("\n");
    assert.equal(sums[0], sums[1]);
  });

  test("refuses a missing folder, a relative path and what is not an archive", async () => {
    const id = await newSandbox();
    const missing = await download(id, "/nope");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "no folder /nope in this sandbox" });
    for (const path of ["relative", ""]) {
      const res = await download(id, path);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "path: an absolute folder path, for example /root/project" });
    }
    const garbage = await upload(id, "/x", "not a tar archive, just text long enough to fill a block ".repeat(20));
    assert.equal(garbage.status, 400);
    assert.match((await garbage.json()).error, /tar archive/);
  });

  test("an image without tar says so", async () => {
    const id = await newSandbox();
    await exec(id, ["sh", "-c", 'rm "$(command -v tar)"']);
    const res = await download(id, "/root");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "this image has no tar: archives need it in the sandbox" });
  });

  test("refuses an unknown sandbox", async () => {
    assert.equal((await download("0123456789ab", "/root")).status, 404);
    assert.equal((await upload("0123456789ab", "/root", "x")).status, 404);
  });
});

describe("requests", () => {
  test("a POST body must be labelled JSON", async () => {
    const res = await api("POST", "/sandboxes", "{}", { "content-type": "text/plain" });
    assert.equal(res.status, 415);
  });

  test("malformed JSON is refused", async () => {
    const res = await api("POST", "/sandboxes", "{nope");
    assert.equal(res.status, 400);
    assert.deepEqual(res.data, { error: "Malformed JSON in request body" });
  });

  test("an unknown route says so", async () => {
    assert.deepEqual((await api("GET", "/nope")).data, { error: "unknown route" });
  });
});

test("info: version, engines, capacity, sandbox count", async () => {
  const { status, data } = await api("GET", "/info");
  assert.equal(status, 200);
  assert.equal(data.name, "parpaing");
  assert.equal(data.version, VERSION);
  assert.ok(data.engines.includes("runc"));
  assert.ok(data.cpus > 0 && data.memory > 0);
  assert.ok(data.sandboxes.running <= data.sandboxes.total);
  assert.ok(data.memoryAvailable > 0 && data.memoryReserved === 512 * 1024 * 1024);
});

describe("API reference", () => {
  test("/openapi.json describes every route, relative to the page", async () => {
    const res = await fetch(`${BASE}/openapi.json`);
    const spec = await res.json();
    assert.deepEqual(spec.servers, [{ url: "/" }]);
    assert.deepEqual(Object.keys(spec.paths).sort(), ["/info", "/sandboxes", "/sandboxes/{id}", "/sandboxes/{id}/archive", "/sandboxes/{id}/exec"]);
  });

  test("/docs loads Scalar under the strict CSP", async () => {
    const page = await fetch(`${BASE}/docs`);
    assert.match(await page.text(), /id="api-reference"/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal((await fetch(`${BASE}/docs/scalar.js`)).status, 200);
  });
});

describe("API key", { skip: KEY ? false : "parpaing runs without PARPAING_API_KEY" }, () => {
  test("a call without the key is refused", async () => {
    const res = await fetch(`${BASE}/sandboxes`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer/);
  });

  test("a wrong key is refused", async () => {
    assert.equal((await fetch(`${BASE}/sandboxes`, { headers: { authorization: "Bearer wrong" } })).status, 401);
  });

  test("another scheme than Bearer is refused", async () => {
    assert.equal((await fetch(`${BASE}/sandboxes`, { headers: { authorization: "Basic abc" } })).status, 400);
  });

  test("the API description stays public", async () => {
    assert.equal((await fetch(`${BASE}/openapi.json`)).status, 200);
  });
});
