// SDK unit tests: the output reading of sdk/index.ts against a fake fetch, no running parpaing needed.
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { Parpaing, ParpaingError } from "../sdk/index.ts";

const parpaing = new Parpaing();
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Replaces fetch: a POST starts command c1, each GET of the output takes the next answer of `outputs`. Returns the URLs asked.
const fake = (outputs: (() => Response)[]) => {
  const calls: string[] = [];
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${input}`);
    if (init?.method === "POST") return Response.json({ id: "c1" });
    const output = outputs.shift();
    assert.ok(output, "no more output answers");
    return output();
  };
  return calls;
};

// An NDJSON body made of `items`, one line per pull; `onCancel` sees the body released.
const ndjson = (items: Iterable<object>, onCancel?: () => void) => {
  const it = items[Symbol.iterator]();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const { done, value } = it.next();
      if (done) controller.close();
      else controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
    },
    cancel: onCancel,
  });
  return new Response(body);
};

describe("sdk output reading", () => {
  test("an error thrown by onOutput reaches the caller as it is, not retried", async () => {
    let cancelled = false;
    const calls = fake([() => ndjson([{ stream: "stdout", data: "hi", next: 2 }, { exitCode: 0, next: 2 }], () => (cancelled = true))]);
    const boom = new Error("boom");
    await assert.rejects(
      parpaing.output("s1", "c1", {
        onOutput: () => {
          throw boom;
        },
      }),
      (error) => error === boom,
    );
    assert.equal(calls.length, 1);
    assert.ok(cancelled, "the body is released");

    const execCalls = fake([() => ndjson([{ stream: "stdout", data: "hi", next: 2 }, { exitCode: 0, next: 2 }])]);
    await assert.rejects(
      parpaing.exec("s1", ["true"], {
        onOutput: () => {
          throw boom;
        },
      }),
      (error) => error === boom,
    );
    assert.equal(execCalls.length, 2, "one start, one read");
  });

  test("exec without onOutput keeps the last 10 MiB of each stream and counts the rest in skipped", async () => {
    const PIECE = 64 * 1024;
    const PIECES = 176; // 11 MiB
    function* items() {
      yield { skipped: 5, next: 5 };
      let next = 5;
      for (let i = 0; i < PIECES; i++) {
        next += PIECE;
        yield { stream: "stdout", data: String.fromCharCode(97 + (i % 26)).repeat(PIECE), next };
      }
      next += 3;
      yield { stream: "stderr", data: "err", next };
      yield { exitCode: 0, next };
    }
    fake([() => ndjson(items())]);
    const result = await parpaing.exec("s1", ["yes"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.length, 10 * 1024 * 1024);
    assert.equal(result.stdout[0], String.fromCharCode(97 + (16 % 26)), "the 16 oldest pieces are dropped");
    assert.equal(result.stdout.at(-1), String.fromCharCode(97 + ((PIECES - 1) % 26)));
    assert.equal(result.stderr, "err");
    assert.equal(result.skipped, 5 + 16 * PIECE);
  });

  test("an error line then a 5xx three times ends exec with a ParpaingError saying next", async () => {
    const busy = () => Response.json({ error: "busy" }, { status: 503 });
    const calls = fake([() => ndjson([{ stream: "stdout", data: "hi", next: 2 }, { error: "the relay broke", next: 2 }]), busy, busy, busy]);
    await assert.rejects(parpaing.exec("s1", ["true"]), (error) => {
      assert.ok(error instanceof ParpaingError);
      assert.equal(error.status, 503);
      assert.equal(error.next, 2);
      return true;
    });
    assert.equal(calls.length, 5);
    assert.match(calls[2], /from=2&/);
  });

  test("an abort during the pause between retries stops at once", async () => {
    fake([() => Response.json({ error: "busy" }, { status: 503 })]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await assert.rejects(parpaing.exec("s1", ["true"], { signal: controller.signal }), { name: "AbortError" });
    assert.ok(Date.now() - started < 400, "well before the 500 ms pause ends");
  });
});
