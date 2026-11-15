// A machine without enough free memory: CI restarts parpaing with an impossible reserve, then runs this file with
// PARPAING_TEST_SATURATED=1. Skipped otherwise.
import assert from "node:assert/strict";
import { test } from "node:test";

const BASE = process.env.PARPAING_URL ?? "http://127.0.0.1:8090";
const skip = process.env.PARPAING_TEST_SATURATED ? false : "needs parpaing started with an impossible PARPAING_RESERVED_MEMORY";
const create = (body: unknown) =>
  fetch(`${BASE}/sandboxes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a full machine refuses new sandboxes at once", { skip }, async () => {
  const res = await create({});
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /^not enough free memory on this machine/);
});

test("with wait, it checks every second until the deadline", { skip }, async () => {
  const started = performance.now();
  const res = await create({ wait: 2 });
  assert.equal(res.status, 503);
  assert.ok(performance.now() - started >= 2000);
});
