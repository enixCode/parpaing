// SDK tests: the same running parpaing as api.test.ts (PARPAING_URL, PARPAING_API_KEY), through sdk/index.ts.
// Each test deletes the sandboxes it creates, and only those.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import { Parpaing, ParpaingError } from "../sdk/index.ts";

const parpaing = new Parpaing({ url: process.env.PARPAING_URL, key: process.env.PARPAING_API_KEY });
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const created: string[] = [];
const newSandbox = async () => {
  const { id } = await parpaing.create();
  created.push(id);
  return id;
};

after(async () => {
  for (const id of created) await parpaing.delete(id).catch(() => {});
});

describe("sdk", () => {
  test("reads the machine, creates, reads, lists and deletes a sandbox", async () => {
    assert.equal((await parpaing.info()).version, VERSION);
    const box = await parpaing.create({ image: "debian:trixie-slim", memory: 256 });
    created.push(box.id);
    assert.equal(box.state, "running");
    assert.equal(box.memory, 256);
    assert.equal((await parpaing.get(box.id)).id, box.id);
    assert.ok((await parpaing.list()).some((item) => item.id === box.id));
    await parpaing.delete(box.id);
    await assert.rejects(parpaing.get(box.id), new ParpaingError(404, "unknown sandbox"));
  });

  test("runs a command, in one answer or live", async () => {
    const id = await newSandbox();
    const once = await parpaing.exec(id, ["sh", "-c", "echo out; echo oops >&2; exit 3"]);
    assert.deepEqual(once, { exitCode: 3, stdout: "out\n", stderr: "oops\n", truncated: false });
    const chunks: string[] = [];
    const live = await parpaing.exec(id, ["sh", "-c", "echo first; sleep 1; echo second >&2"], {
      onOutput: (data, stream) => chunks.push(`${stream}: ${data}`),
    });
    assert.deepEqual(live, { exitCode: 0 });
    assert.deepEqual(chunks, ["stdout: first\n", "stderr: second\n"]);
  });

  test("streams a folder out and straight back in", async () => {
    const id = await newSandbox();
    await parpaing.exec(id, ["sh", "-c", "mkdir -p /src && echo hello > /src/a.txt"]);
    await parpaing.writeFolder(id, "/copy", await parpaing.readFolder(id, "/src"));
    assert.equal((await parpaing.exec(id, ["cat", "/copy/a.txt"])).stdout, "hello\n");
  });

  test("refuses with the API's status and message", async () => {
    await assert.rejects(parpaing.create({ image: "" }), { name: "ParpaingError", status: 400, message: /^image: / });
    await assert.rejects(parpaing.exec("000000000000", ["true"]), { status: 404 });
  });
});
