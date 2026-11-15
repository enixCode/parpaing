// API tests: they call a running parpaing (docker compose up -d) through its gateway, Docker included.
// PARPAING_URL picks the address (http://127.0.0.1:8090 by default), PARPAING_API_KEY the key when parpaing runs with one.
// Each test deletes the sandboxes it creates, and only those.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, test } from "node:test";

const BASE = process.env.PARPAING_URL ?? "http://127.0.0.1:8090";
const KEY = process.env.PARPAING_API_KEY;
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
const exec = (id: string, cmd: unknown) => api("POST", `/sandboxes/${id}/exec`, { cmd });

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

    assert.deepEqual((await api("GET", `/sandboxes/${id}`)).data, { id, state: "running" });
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

describe("commands", () => {
  test("streams stdout, then the exit code", async () => {
    const res = await exec(await newSandbox(), ["sh", "-c", "echo ok"]);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-ndjson");
    assert.deepEqual(lines(res.text), [{ stream: "stdout", data: "ok\n" }, { exitCode: 0 }]);
  });

  test("keeps stderr apart and returns a failing exit code", async () => {
    const res = await exec(await newSandbox(), ["sh", "-c", "echo oops >&2; exit 3"]);
    assert.deepEqual(lines(res.text), [{ stream: "stderr", data: "oops\n" }, { exitCode: 3 }]);
  });

  test("sends each chunk as it comes, not at the end", async () => {
    const id = await newSandbox();
    const started = performance.now();
    const res = await fetch(`${BASE}/sandboxes/${id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify({ cmd: ["sh", "-c", "echo first; sleep 2; echo second"] }),
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
  });

  test("root keeps only the 9 capabilities parpaing grants, for good", async () => {
    // CHOWN, DAC_OVERRIDE, FOWNER, FSETID, KILL, SETGID, SETUID, NET_BIND_SERVICE, AUDIT_WRITE = 0x200004fb. CapBnd is the cap nothing can exceed.
    const res = await exec(await newSandbox(), ["sh", "-c", "grep -E '^Cap(Eff|Bnd):' /proc/self/status"]);
    const status = Object.fromEntries(lines(res.text)[0].data.trim().split("\n").map((line: string) => line.split(/:\s+/)));
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
});

describe("API reference", () => {
  test("/openapi.json describes every route, relative to the page", async () => {
    const res = await fetch(`${BASE}/openapi.json`);
    const spec = await res.json();
    assert.deepEqual(spec.servers, [{ url: "/" }]);
    assert.deepEqual(Object.keys(spec.paths).sort(), ["/info", "/sandboxes", "/sandboxes/{id}", "/sandboxes/{id}/exec"]);
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
