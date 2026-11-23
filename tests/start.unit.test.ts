// Start checks: src/start.ts alone, no running parpaing needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { exposureError } from "../src/start.ts";

test("a local or unset address needs no key", () => {
  for (const address of ["127.0.0.1", "localhost", "::1", "[::1]", undefined, ""]) assert.equal(exposureError(address, undefined), undefined, String(address));
});

test("an address beyond this machine without a key is refused", () => {
  for (const address of ["0.0.0.0", "203.0.113.7"]) {
    assert.equal(exposureError(address, undefined), `parpaing: PARPAING_ADDRESS=${address} exposes the API beyond this machine: set PARPAING_API_KEY`);
    assert.ok(exposureError(address, ""), `${address} with an empty key`);
  }
});

test("with a key, any address is fine", () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "203.0.113.7", undefined]) assert.equal(exposureError(address, "secret"), undefined, String(address));
});
