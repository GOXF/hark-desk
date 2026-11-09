import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createHarkStatusBridge,
  installHarkExecutionContract,
} from "./hark_short_confirmation.mjs";

const fixture = () => {
  const input = new EventEmitter();
  const output = {
    writes: [],
    write(chunk) {
      this.writes.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    },
  };
  const bridge = createHarkStatusBridge(input, output);
  const prompt = (id, sessionId) =>
    input.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "session/prompt",
          params: { sessionId },
        }) + "\n",
      ),
    );
  const notices = () =>
    output.writes
      .map((s) => JSON.parse(s))
      .filter((x) => x.method === "session/update");
  return { input, output, bridge, prompt, notices };
};
const status = (sequence = 1, state = "processing") => ({
  type: "hark.status",
  status: state,
  sequence,
  request_id: "r1",
  conversation_id: "p1",
  message_id: "m1",
  line: "正在查找文件",
});
const streamResponse = (chunks) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
const frame = (s) => `event: hark.status\ndata: ${JSON.stringify(s)}\n\n`;

test("separates fragmented status into bound ACP metadata without altering body frames", async () => {
  const f = fixture();
  f.prompt(9, "session-a");
  const normal =
    'data: {"choices":[{"delta":{"content":"Hark 正文保持原样"}}]}\n\ndata: [DONE]\n\n';
  const custom = frame(status());
  const response = f.bridge.response(
    streamResponse([custom.slice(0, 13), custom.slice(13) + normal]),
  );
  assert.equal(await response.text(), normal);
  assert.equal(f.notices()[0].params.sessionId, "session-a");
  assert.equal(
    f.notices()[0].params.update._meta.hark.status.line,
    "正在查找文件",
  );
  assert.equal(
    f.notices().at(-1).params.update._meta.hark.status.status,
    "ended",
  );
  f.bridge.uninstall();
});

test("does not opt in or associate ambiguous simultaneous ACP prompts", () => {
  const f = fixture();
  f.prompt(1, "a");
  f.prompt(2, "b");
  assert.equal(f.bridge.context(), undefined);
  assert.equal(f.notices().length, 0);
  f.bridge.uninstall();
});

test("no status source means no invented stage for older gateways", async () => {
  const f = fixture();
  f.prompt(1, "a");
  const normal = "data: [DONE]\n\n";
  assert.equal(
    await f.bridge.response(streamResponse([normal])).text(),
    normal,
  );
  assert.equal(f.notices().length, 0);
  f.bridge.uninstall();
});

test("waiting for user wins over later running stub and stream end", async () => {
  const f = fixture();
  f.prompt(1, "a");
  await f.bridge
    .response(
      streamResponse([
        frame(status(1, "waiting_for_user")),
        frame(status(2)),
        frame(status(3, "ended")),
      ]),
    )
    .text();
  assert.deepEqual(
    f.notices().map((n) => n.params.update._meta.hark.status.status),
    ["waiting_for_user"],
  );
  f.bridge.uninstall();
});

test("drops stale sequence and mismatched upstream request id within a stream", async () => {
  const f = fixture();
  f.prompt(1, "a");
  await f.bridge
    .response(
      streamResponse([
        frame(status(2)),
        frame(status(1)),
        frame({ ...status(3), request_id: "old" }),
      ]),
    )
    .text();
  assert.deepEqual(
    f.notices().map((n) => n.params.update._meta.hark.status.status),
    ["processing", "ended"],
  );
  f.bridge.uninstall();
});

test("observes fragmented ACP JSONL without changing forwarded stdin/stdout bytes", () => {
  const f = fixture();
  const bytes = [];
  f.input.on("data", (b) => bytes.push(Buffer.from(b)));
  const raw =
    JSON.stringify({
      id: 1,
      method: "session/prompt",
      params: { sessionId: "a" },
    }) + "\n";
  f.input.emit("data", Buffer.from(raw.slice(0, 10)));
  f.input.emit("data", Buffer.from(raw.slice(10)));
  assert.equal(Buffer.concat(bytes).toString(), raw);
  assert.equal(f.bridge.context().sessionId, "a");
  f.output.write('{"id":1,"result":{}}\n');
  assert.equal(f.bridge.context(), undefined);
  f.bridge.uninstall();
});

test("cancellation and response stream failure end a real stage without body injection", async () => {
  const f = fixture();
  f.prompt(1, "a");
  const response = f.bridge.response(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(frame(status())));
        },
        cancel() {},
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  const reader = response.body.getReader();
  const pending = reader.read();
  await new Promise((r) => setTimeout(r, 5));
  f.input.emit(
    "data",
    Buffer.from(
      JSON.stringify({ method: "session/cancel", params: { sessionId: "a" } }) +
        "\n",
    ),
  );
  await reader.cancel();
  await pending;
  assert.equal(
    f.notices().at(-1).params.update._meta.hark.status.reason,
    "cancelled",
  );
  f.bridge.uninstall();
});

test("real error overrides waiting but normal stream ending does not", async () => {
  const f = fixture();
  f.prompt(1, "a");
  await f.bridge
    .response(
      streamResponse([
        frame(status(1, "waiting_for_user")),
        frame({ ...status(2, "ended"), reason: "error" }),
      ]),
    )
    .text();
  assert.deepEqual(
    f.notices().map((n) => n.params.update._meta.hark.status.status),
    ["waiting_for_user", "ended"],
  );
  assert.equal(
    f.notices().at(-1).params.update._meta.hark.status.reason,
    "error",
  );
  f.bridge.uninstall();
});

test("request ordinal resets terminal gating for each subsequent HTTP tool round", async () => {
  const f = fixture();
  f.prompt(1, "a");
  await f.bridge
    .response(streamResponse([frame(status(1, "waiting_for_user"))]))
    .text();
  await f.bridge
    .response(streamResponse([frame({ ...status(), request_id: "r2" })]))
    .text();
  assert.deepEqual(
    f.notices().map((n) => n.params.update._meta.hark.requestOrdinal),
    [1, 2, 2],
  );
  f.bridge.uninstall();
});

test("does not splice status metadata into a fragmented outgoing ACP frame", async () => {
  const f = fixture();
  f.prompt(1, "a");
  f.output.write('{"jsonrpc":"2.0","method":"fixture');
  await f.bridge.response(streamResponse([frame(status())])).text();
  assert.equal(f.output.writes.length, 1);
  f.output.write('","params":{}}\n');
  const frames = f.output.writes
    .join("")
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.equal(frames[0].method, "fixture");
  assert.equal(frames[1].method, "session/update");
  f.bridge.uninstall();
});

test("Hark request opt-in preserves ordinary text and does not adapt other API calls", async () => {
  const input = new EventEmitter();
  const output = {
    write() {
      return true;
    },
  };
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (req, init) => {
    requests.push(await new Request(req, init).json());
    return streamResponse(["data: [DONE]\n\n"]);
  };
  const uninstall = installHarkExecutionContract({ input, output });
  try {
    input.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          id: 1,
          method: "session/prompt",
          params: { sessionId: "a" },
        }) + "\n",
      ),
    );
    const body = {
      model: "mapped",
      stream: true,
      messages: [{ role: "user", content: "Hark 正文不改" }],
    };
    await (
      await fetch("https://fixture.invalid/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).text();
    assert.equal(requests[0].hark_status, true);
    assert.deepEqual(requests[0].messages, body.messages);
    await fetch("https://fixture.invalid/other", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.deepEqual(requests[1], body);
  } finally {
    uninstall();
    globalThis.fetch = previous;
  }
});

test("the real SDK Uint8Array stdout representation does not hide subsequent prompts", async () => {
  const f = fixture();
  f.prompt(1, "a");
  f.output.write(new TextEncoder().encode('{"id":1,"result":{}}\n'));
  assert.equal(f.bridge.context(), undefined);
  f.prompt(2, "b");
  await f.bridge.response(streamResponse([frame(status())])).text();
  assert.equal(f.notices().at(-1).params.sessionId, "b");
  f.bridge.uninstall();
});

test("SDK cancellation after protocol DONE is normal stream end, not interrupted", async () => {
  const f = fixture();
  f.prompt(1, "a");
  const response = f.bridge.response(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(frame(status()) + "data: [DONE]\n\n"),
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(
    f.notices().at(-1).params.update._meta.hark.status.reason,
    "stream_ended",
  );
  f.bridge.uninstall();
});

test("waiting survives SDK reader cancellation after protocol DONE", async () => {
  const f = fixture();
  f.prompt(1, "a");
  const response = f.bridge.response(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              frame(status(1, "waiting_for_user")) + "data: [DONE]\n\n",
            ),
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.deepEqual(
    f.notices().map((n) => n.params.update._meta.hark.status.status),
    ["waiting_for_user"],
  );
  f.bridge.uninstall();
});
