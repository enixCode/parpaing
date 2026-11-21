// API tests: they call a running parpaing (docker compose up -d) through its gateway, Docker included.
// PARPAING_URL picks the address (http://127.0.0.1:8090 by default), PARPAING_API_KEY the key when parpaing runs with one.
// Each test deletes the sandboxes it creates, and only those.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import Docker from "dockerode";

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
const start = (id: string, cmd: unknown) => api("POST", `/sandboxes/${id}/commands`, { cmd });
// One read of a command's output: the answer, and its lines when it has some.
async function output(id: string, cid: string, from = 0, follow = true) {
  const res = await api("GET", `/sandboxes/${id}/commands/${cid}/output?from=${from}&follow=${follow}`);
  return { ...res, lines: res.status === 200 ? lines(res.text) : [] };
}
// Runs a command to its end and answers once, as one JSON with its exit code, stdout and stderr: start, then follow the
// output, resuming from the last next after a pause, an error line (a relay killed from inside) or a 503 (the daemon out of
// reach for a moment, or the sandbox starting, 500 ms later), without progress at most 3 error lines or 20 answers 503 in a row.
// Any other answer than 201 to the start or 200 to a read fails the test, unless its status is in allowed: then it comes back as is.
async function exec(id: string, cmd: unknown, allowed: number[] = []) {
  const started = await start(id, cmd);
  if (started.status !== 201) {
    assert.ok(allowed.includes(started.status), `start answered ${started.status}: ${started.text}`);
    return started;
  }
  const data = { exitCode: -1, stdout: "", stderr: "" };
  let next = 0;
  for (let failures = 0, busy = 0; failures < 3 && busy < 20; ) {
    const res = await output(id, started.data.id, next);
    if (res.status === 503) {
      busy++;
      await sleep(500);
      continue;
    }
    if (res.status !== 200) {
      assert.ok(allowed.includes(res.status), `output answered ${res.status}: ${res.text}`);
      return res;
    }
    const before = next;
    for (const line of res.lines) {
      next = line.next;
      if (line.stream) data[line.stream as "stdout" | "stderr"] += line.data;
      else if (line.exitCode !== undefined) {
        data.exitCode = line.exitCode;
        return { status: 200, data, text: JSON.stringify(data) };
      } else if (line.error) failures = next === before ? failures + 1 : 0;
    }
    if (next !== before) failures = busy = 0;
  }
  throw new Error(`the output of ${JSON.stringify(cmd)} kept breaking`);
}

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
    // Through sh: kill is a shell builtin, the image has no kill program. ABRT and SEGV: Go handles them itself, so without a
    // catch-all they would reach PID 1 and end it.
    for (const signal of ["TERM", "INT", "HUP", "QUIT", "USR1", "ABRT", "SEGV"]) await exec(id, ["sh", "-c", `kill -${signal} 1`]);
    // kill -9 -1 also kills the relay that carries this very call: its 503 is expected.
    await exec(id, ["sh", "-c", "kill -9 -1"], [503]);
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
      const { boot, ...rest } = JSON.parse(ping.data.stdout);
      assert.deepEqual(rest, { ok: true, version: 2 });
      assert.match(boot, /^[0-9a-f]{4}$/);
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
    assert.equal(res.status, 201, res.text);
    const { id } = res.data;
    created.push(id);
    // runc kills one process and the sandbox lives on; gVisor stops the whole sandbox, which Docker then starts again: the
    // command is then lost in the restart (410), or the sandbox is still starting (409).
    // tail keeps the last lines of an endless input without newlines: its memory grows until the kernel stops it.
    const run = await exec(id, ["sh", "-c", "tail /dev/zero"], GVISOR ? [409, 410] : []);
    if (!GVISOR) {
      assert.equal(run.data.exitCode, 137);
      assert.equal((await api("GET", `/sandboxes/${id}`)).data.state, "running");
    } else if (run.status === 200) assert.ok(run.data.exitCode > 0, run.text);
    else if (run.status === 410) assert.match(run.data.error, /restarted at/, run.text);
    else assert.equal(run.status, 409, run.text);
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
  const read = (id: string, cid: string) => api("GET", `/sandboxes/${id}/commands/${cid}`);
  const stop = (id: string, cid: string) => api("POST", `/sandboxes/${id}/commands/${cid}/stop`, {});
  // Reads the command every 100 ms until it has exited.
  async function ended(id: string, cid: string) {
    for (;;) {
      const res = await read(id, cid);
      assert.equal(res.status, 200, res.text);
      if (res.data.state === "exited") return res.data;
      await sleep(100);
    }
  }
  // The lines of a followed output, each with the time it arrived.
  async function timed(id: string, cid: string) {
    const res = await fetch(`${BASE}/sandboxes/${id}/commands/${cid}/output?follow=true`, { headers: KEY ? { authorization: `Bearer ${KEY}` } : {} });
    const got: { line: any; at: number }[] = [];
    let rest = "";
    for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop()!;
      for (const part of parts) if (part) got.push({ line: JSON.parse(part), at: performance.now() });
    }
    return got;
  }

  test("starts at once, then answers the state and the whole output", { timeout: 30_000 }, async () => {
    const id = await newSandbox();
    const cmd = ["sh", "-c", "echo out; sleep 0.2; echo err >&2; sleep 1; exit 3"];
    const res = await start(id, cmd);
    assert.equal(res.status, 201);
    assert.match(res.data.id, /^[0-9a-f]{12}$/);
    const cid = res.data.id;
    assert.equal(res.headers.get("location"), `/sandboxes/${id}/commands/${cid}`);
    const now = await read(id, cid);
    assert.equal(now.data.state, "running");
    assert.equal(now.data.exitCode, null);
    const end = await ended(id, cid);
    assert.deepEqual(end, { id: cid, cmd, state: "exited", exitCode: 3, outputSize: 8 });
    const out = await output(id, cid, 0, false);
    assert.equal(out.headers.get("content-type"), "application/x-ndjson");
    assert.deepEqual(out.lines, [
      { stream: "stdout", data: "out\n", next: 4 },
      { stream: "stderr", data: "err\n", next: 8 },
      { exitCode: 3, next: end.outputSize },
    ]);
  });

  test("follow sends each line as it comes, then the exit code", { timeout: 30_000 }, async () => {
    const id = await newSandbox();
    const { data } = await start(id, ["sh", "-c", "for i in 1 2 3; do echo $i; sleep 0.5; done"]);
    const got = await timed(id, data.id);
    assert.deepEqual(
      got.map(({ line }) => line),
      [
        { stream: "stdout", data: "1\n", next: 2 },
        { stream: "stdout", data: "2\n", next: 4 },
        { stream: "stdout", data: "3\n", next: 6 },
        { exitCode: 0, next: 6 },
      ],
    );
    assert.ok(got[2].at - got[0].at > 700, `lines 1 and 3 ${Math.round(got[2].at - got[0].at)} ms apart`);
  });

  test("from=next of a line answers only what follows", { timeout: 30_000 }, async () => {
    const id = await newSandbox();
    // Two streams, since the following chunks of one stream come back as one line.
    const { data } = await start(id, ["sh", "-c", "echo a; sleep 0.2; echo b >&2"]);
    await ended(id, data.id);
    const first = (await output(id, data.id, 0, false)).lines[0];
    assert.deepEqual(first, { stream: "stdout", data: "a\n", next: 2 });
    assert.deepEqual((await output(id, data.id, first.next, false)).lines, [
      { stream: "stderr", data: "b\n", next: 4 },
      { exitCode: 0, next: 4 },
    ]);
  });

  test("each command keeps its own exit code, among orphans", { timeout: 60_000 }, async () => {
    const id = await newSandbox();
    const codes = Array.from({ length: 20 }, (_, i) => i + 1);
    // Each one leaves two sleeps to PID 1, collected by the same reaper as the commands.
    const orphans = Array.from({ length: 5 }, () => exec(id, ["sh", "-c", "(sleep 0.3 &); (sleep 0.4 &); true"]));
    const runs = await Promise.all(codes.map((n) => exec(id, ["sh", "-c", `sleep 0.5; exit ${n}`])));
    await Promise.all(orphans);
    assert.deepEqual(
      runs.map((run) => run.data.exitCode),
      codes,
    );
  });

  test("runs in its own process group, with its id in PARPAING_EXEC", { timeout: 30_000 }, async () => {
    const id = await newSandbox();
    const { data } = await start(id, ["sh", "-c", 'echo $PARPAING_EXEC; cut -d" " -f5 /proc/$$/stat; echo $$']);
    const out = (await output(id, data.id)).lines.map((line) => line.data ?? "").join("");
    const [cid, group, pid] = out.trim().split("\n");
    assert.equal(cid, data.id);
    assert.equal(group, pid);
  });

  test("cuts a long output in lines of at most 64 KiB, never inside a character", { timeout: 30_000 }, async () => {
    const id = await newSandbox();
    const { data } = await start(id, ["sh", "-c", "yes é | head -n 70000 | tr -d '\\n'"]);
    const out = await output(id, data.id);
    const pieces = out.lines.filter((line) => line.stream);
    assert.ok(pieces.length > 1);
    for (const piece of pieces) assert.ok(Buffer.byteLength(piece.data) <= 65536, `${Buffer.byteLength(piece.data)} bytes`);
    assert.equal(pieces.map((piece) => piece.data).join(""), "é".repeat(70000));
    assert.deepEqual(out.lines.at(-1), { exitCode: 0, next: 140000 });
  });

  test("past 100 MiB, keeps the end of the output and says what is skipped", { timeout: 120_000 }, async () => {
    const id = await newSandbox();
    const total = 130_000_000;
    const { data } = await start(id, ["sh", "-c", `head -c ${total} /dev/zero | tr '\\0' a`]);
    // Waits for the end from the end: nothing to pull.
    assert.deepEqual((await output(id, data.id, total)).lines, [{ exitCode: 0, next: total }]);
    assert.equal((await read(id, data.id)).data.outputSize, total);
    assert.equal(stdout((await exec(id, ["ls", `/tmp/parpaing/${data.id}`])).text), "stderr\nstderr.1\nstdout\nstdout.1\n");
    // Only the first two lines from 0, then the connection is cut: no 80 MB through the test.
    const res = await fetch(`${BASE}/sandboxes/${id}/commands/${data.id}/output?from=0`, { headers: KEY ? { authorization: `Bearer ${KEY}` } : {} });
    const got: any[] = [];
    let rest = "";
    for await (const chunk of res.body!.pipeThrough(new TextDecoderStream())) {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop()!;
      got.push(...parts.map((part) => JSON.parse(part)));
      if (got.length >= 2) break;
    }
    const [skipped, first] = got;
    const MiB50 = 50 * 1024 * 1024;
    assert.deepEqual(Object.keys(skipped).sort(), ["next", "skipped"]);
    assert.equal(skipped.next, skipped.skipped);
    assert.ok(skipped.skipped >= MiB50 && skipped.skipped <= total - MiB50, `skipped ${skipped.skipped}`);
    assert.equal(first.stream, "stdout");
    assert.match(first.data, /^a+$/);
    assert.equal(first.next, skipped.next + first.data.length);
  });

  test("keeps the last 50 finished commands", { timeout: 180_000 }, async () => {
    const id = await newSandbox();
    const ids: string[] = [];
    // Each one read to its exit code, so finished before the next starts.
    for (let i = 0; i < 51; i++) {
      const { data } = await start(id, ["true"]);
      ids.push(data.id);
      assert.equal((await output(id, data.id)).lines.at(-1).exitCode, 0);
    }
    // The next start removes the oldest finished one.
    const last = (await start(id, ["true"])).data.id;
    for (const res of [await read(id, ids[0]), await output(id, ids[0])]) {
      assert.equal(res.status, 404);
      assert.deepEqual(res.data, { error: "unknown command" });
    }
    const list = await api("GET", `/sandboxes/${id}/commands`);
    assert.deepEqual(
      list.data.map((item: { id: string }) => item.id),
      [...ids.slice(1), last],
    );
  });

  test("ends with its main process, while what it left behind keeps writing", { timeout: 30_000 }, async () => {
    const id = await newSandbox();
    const { data } = await start(id, ["sh", "-c", "(sleep 1; echo late) & echo early"]);
    const out = await output(id, data.id);
    assert.deepEqual(out.lines, [
      { stream: "stdout", data: "early\n", next: 6 },
      { exitCode: 0, next: 6 },
    ]);
    await sleep(1500);
    assert.equal((await output(id, data.id, 6, false)).lines[0].data, "late\n");
  });

  test("stop ends the process group with SIGTERM, or SIGKILL 10 s later", { timeout: 60_000 }, async () => {
    const id = await newSandbox();
    // The command lines of the processes left in the sandbox, read a few times while the signalled ones end.
    const list = ["sh", "-c", 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline; echo; done'];
    async function sleepsLeft() {
      let left = "";
      for (let tries = 0; tries < 10; tries++) {
        left = (await exec(id, list)).data.stdout;
        if (!left.includes("sleep 300")) break;
        await sleep(300);
      }
      return left;
    }
    const term = await start(id, ["sh", "-c", "sleep 300 & sleep 300 & wait"]);
    let since = performance.now();
    const stopped = await stop(id, term.data.id);
    assert.equal(stopped.status, 202);
    assert.deepEqual(stopped.data, {});
    assert.equal((await ended(id, term.data.id)).exitCode, 143);
    assert.ok(performance.now() - since < 3000, `exited after ${Math.round(performance.now() - since)} ms`);
    let left = await sleepsLeft();
    assert.ok(!left.includes("sleep 300"), left);

    // setsid takes the child out of the group; it keeps PARPAING_EXEC, which stop also signals.
    const away = await start(id, ["sh", "-c", "setsid sleep 300 & sleep 300 & wait"]);
    await sleep(300);
    assert.equal((await stop(id, away.data.id)).status, 202);
    assert.equal((await ended(id, away.data.id)).exitCode, 143);
    left = await sleepsLeft();
    assert.ok(!left.includes("sleep 300"), left);

    const deaf = await start(id, ["sh", "-c", 'trap "" TERM; sleep 300']);
    await sleep(300);
    since = performance.now();
    assert.equal((await stop(id, deaf.data.id)).status, 202);
    assert.equal((await ended(id, deaf.data.id)).exitCode, 137);
    const waited = performance.now() - since;
    assert.ok(waited > 9000 && waited < 14000, `killed after ${Math.round(waited)} ms`);
  });

  test("lists the commands in start order", { timeout: 30_000 }, async () => {
    const id = await newSandbox();
    const ids: string[] = [];
    for (const cmd of [["true"], ["sleep", "5"], ["false"]]) ids.push((await start(id, cmd)).data.id);
    const res = await api("GET", `/sandboxes/${id}/commands`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.data.map((item: { id: string }) => item.id),
      ids,
    );
    assert.deepEqual(res.data[1], { id: ids[1], cmd: ["sleep", "5"], state: "running", exitCode: null });
  });

  test("without follow, a running command's output ends with next alone", { timeout: 30_000 }, async () => {
    const id = await newSandbox();
    const { data } = await start(id, ["sleep", "5"]);
    assert.deepEqual((await output(id, data.id, 0, false)).lines, [{ next: 0 }]);
  });

  test("a command lost in a sandbox restart answers 410", { timeout: 120_000 }, async () => {
    const since = performance.now();
    const id = await newSandbox();
    const started = await start(id, ["sleep", "300"]);
    assert.equal(started.status, 201, started.text);
    // docker restart does not raise RestartCount: only a start more than 30 s after the creation counts as a restart.
    await sleep(31_000 - (performance.now() - since));
    // The sandbox id is the start of its container's id.
    await new Docker().getContainer(id).restart({ t: 1 });
    for (let tries = 0; (await api("GET", `/sandboxes/${id}`)).data.state !== "running"; tries++) {
      assert.ok(tries < 300, "the sandbox is not running again after 30 s");
      await sleep(100);
    }
    // The daemon needs a moment to listen: 503 until then.
    let lost = await read(id, started.data.id);
    for (let tries = 0; lost.status === 503 && tries < 150; tries++) {
      await sleep(200);
      lost = await read(id, started.data.id);
    }
    assert.equal(lost.status, 410, lost.text);
    assert.match(lost.data.error, /restarted at/);
  });

  test("refuses an unknown command, a bad position, a missing program and an unknown sandbox", { timeout: 30_000 }, async () => {
    const id = await newSandbox();
    for (const cid of ["000000000000", "nothex"]) {
      for (const res of [await read(id, cid), await output(id, cid), await stop(id, cid)]) {
        assert.equal(res.status, 404);
        assert.deepEqual(res.data, { error: "unknown command" });
      }
    }
    const { data } = await start(id, ["true"]);
    const bad = await output(id, data.id, -1);
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /^from: /);
    const missing = await start(id, ["/nope"]);
    assert.equal(missing.status, 400);
    assert.match(missing.data.error, /nope/);
    for (const sandbox of ["000000000000", "nothex"]) {
      const res = await start(sandbox, ["true"]);
      assert.equal(res.status, 404);
      assert.deepEqual(res.data, { error: "unknown sandbox" });
      assert.equal((await api("GET", `/sandboxes/${sandbox}/commands`)).status, 404);
    }
  });

  test("the daemon's file descriptors stay out of reach", { timeout: 30_000 }, async () => {
    // exec fails the test if the API does: 1 is readlink's own refusal.
    const res = await exec(await newSandbox(), ["readlink", "/proc/1/fd/0"]);
    assert.equal(res.data.exitCode, 1, res.text);
  });

  test("refuses a missing or malformed command with an example", async () => {
    const id = await newSandbox();
    for (const cmd of [undefined, [], [1], "ls"]) {
      const res = await start(id, cmd);
      assert.equal(res.status, 400);
      assert.equal(res.data.error, 'cmd: a command as an array, for example ["ls", "-la"]');
    }
  });

  test("root keeps only the 9 capabilities parpaing grants, for good", async () => {
    // CHOWN, DAC_OVERRIDE, FOWNER, FSETID, KILL, SETGID, SETUID, NET_BIND_SERVICE, AUDIT_WRITE = 0x200004fb. CapBnd is the cap nothing can exceed.
    const res = await exec(await newSandbox(), ["sh", "-c", "grep -E '^Cap(Eff|Bnd):' /proc/self/status"]);
    const status = Object.fromEntries(stdout(res.text).trim().split("\n").map((line: string) => line.split(/:\s+/)));
    assert.deepEqual(status, { CapEff: "00000000200004fb", CapBnd: "00000000200004fb" });
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
    // 1: the connection failed, 124: it hung until the timeout; anything else is not a network answer.
    assert.ok([1, 124].includes(run.data.exitCode), run.text);
  });

  test("the proxy refuses the host, the local network, metadata and other sandboxes", async () => {
    const id = await newSandbox();
    const other = await newSandbox();
    const address = stdout((await exec(other, ["sh", "-c", "grep \"$(cat /etc/hostname)\" /etc/hosts | cut -f1"])).text).trim();
    assert.match(address, /^10\.89\./);
    for (const target of ["169.254.169.254:80", "172.17.0.1:2375", "192.168.1.1:80", "10.0.0.1.nip.io:80", `${address}:22`]) {
      // Exit code 0: the proxy was reached and answered or closed in time, so the refusal is the proxy's own.
      const run = await tunnel(id, target);
      assert.equal(run.data.exitCode, 0, `${target}: ${run.text}`);
      assert.ok(!agreed(run.text), target);
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
    assert.deepEqual(Object.keys(spec.paths).sort(), [
      "/info",
      "/sandboxes",
      "/sandboxes/{id}",
      "/sandboxes/{id}/archive",
      "/sandboxes/{id}/commands",
      "/sandboxes/{id}/commands/{cid}",
      "/sandboxes/{id}/commands/{cid}/output",
      "/sandboxes/{id}/commands/{cid}/stop",
    ]);
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
