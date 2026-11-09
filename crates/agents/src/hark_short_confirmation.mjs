// Hark-only request adaptation. History remains authoritative; no response text,
// tool receipt, execution status or retry is synthesized here.
import { resolve } from "node:path";

const GUARD = Symbol.for("hark.clientToolConfirmationContract");

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const messageText = (message) => {
  if (typeof message.content === "string") return message.content;
  if (
    !Array.isArray(message.content) ||
    !message.content.every(
      (part) =>
        isRecord(part) &&
        ["text", "input_text", "output_text"].includes(part.type) &&
        typeof part.text === "string",
    )
  )
    return undefined;
  return message.content.map((part) => part.text).join("");
};

const isShortApproval = (text) =>
  [
    "要",
    "好",
    "好的",
    "可以",
    "行",
    "继续",
    "开始吧",
    "按这个做",
    "照这个做",
    "就这样做",
    "yes",
    "yesplease",
    "goahead",
    "doit",
    "proceed",
    "ok",
    "okay",
  ].includes(text.replace(/[\s?？!！.。，,]/gu, "").toLowerCase());

const isExecutionOffer = (text) => {
  const chinese = text.match(
    /(?:要不要我|要我|需要我|是否要我|是否让我)([^？?\n]{1,600}?)(?:吗|么)?[？?]\s*$/u,
  )?.[1];
  if (chinese !== undefined) {
    if (
      /示例|例子|方案|建议|原理|解释|说明|介绍|总结|概述|列举|举例|讨论/u.test(
        chinese,
      ) ||
      /^(?:先|再|给你|为你|帮你)?(?:解释|说明|介绍|讲|列举|举例|分析|讨论)/u.test(
        chinese,
      )
    )
      return false;
    return /^(?:(?:先|再|现在|直接|帮你|为你|给你|替你|帮忙)\s*)*(?:(?:执行|运行|读取|检查|查找|搜索|修改|修复|更新|安装|删除|创建|写入|保存|提交|部署|测试|跑)|(?:把|将)[^，,？?\n]{1,300}(?:加进|加入|写入|保存|修改|修复|删除|创建|安装|提交|部署))/u.test(
      chinese,
    );
  }
  const english = text.match(
    /(?:would you like me to|do you want me to|shall i|should i)\s+([^?\n]{1,600})\?\s*$/iu,
  )?.[1];
  return (
    english !== undefined &&
    !/\b(?:explain|describe|discuss|outline|suggest|show|list|example|examples|sample|suggestion|summary|summarize|description|explanation|pseudocode)\b/iu.test(
      english,
    ) &&
    /^(?:(?:first|then|now|directly|please)\s+)*(?:run|read|inspect|search|edit|fix|update|install|delete|create|write|save|commit|deploy|test|add)\b/iu.test(
      english,
    )
  );
};

const hasDeclaredClientTool = (tool) =>
  isRecord(tool) &&
  ((tool.type === "function" &&
    (typeof tool.name === "string" ||
      (isRecord(tool.function) && typeof tool.function.name === "string"))) ||
    (tool.type === undefined &&
      typeof tool.name === "string" &&
      isRecord(tool.input_schema)) ||
    (tool.type === "custom" && typeof tool.name === "string") ||
    tool.type === "local_shell");

const hasToolCall = (message) =>
  (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
  message.function_call !== undefined ||
  (Array.isArray(message.content) &&
    message.content.some(
      (part) =>
        isRecord(part) &&
        [
          "tool_use",
          "tool_result",
          "function_call",
          "function_call_output",
        ].includes(part.type),
    ));

const executionConfirmation = (body, protocol) => {
  if (
    !isRecord(body) ||
    !Array.isArray(body.tools) ||
    !body.tools.some(hasDeclaredClientTool)
  )
    return false;
  const choice = body.tool_choice;
  if (
    choice !== undefined &&
    choice !== "auto" &&
    !(isRecord(choice) && choice.type === "auto")
  )
    return false;
  const history = protocol === "responses" ? body.input : body.messages;
  if (!Array.isArray(history) || history.length < 2) return false;
  const user = history.at(-1);
  const assistant = history.at(-2);
  if (
    !isRecord(user) ||
    user.role !== "user" ||
    !isRecord(assistant) ||
    assistant.role !== "assistant" ||
    hasToolCall(assistant)
  )
    return false;
  const confirmation = messageText(user);
  const offer = messageText(assistant);
  return (
    confirmation !== undefined &&
    offer !== undefined &&
    isShortApproval(confirmation) &&
    isExecutionOffer(offer)
  );
};

const protocolOf = (request) => {
  if (
    request.method !== "POST" ||
    !request.headers.get("content-type")?.includes("application/json")
  )
    return undefined;
  const path = new URL(request.url).pathname.replace(/\/$/u, "");
  if (path.endsWith("/chat/completions")) return "chat";
  if (path.endsWith("/responses")) return "responses";
  if (path.endsWith("/messages")) return "messages";
  return undefined;
};

export const installHarkExecutionContract = ({
  input = process.stdin,
  output = process.stdout,
} = {}) => {
  if (globalThis[GUARD] !== undefined) return globalThis[GUARD];
  const previous = globalThis.fetch;
  const statuses = createHarkStatusBridge(input, output);
  const guarded = async (input, init) => {
    // A Request body belongs to the caller; inspect a clone, never transfer it
    // and then try to forward an already-consumed original on a no-change path.
    if (
      init?.body !== undefined &&
      init.body !== null &&
      typeof init.body !== "string"
    )
      return previous(input, init);
    const request = new Request(
      input instanceof Request ? input.clone() : input,
      init,
    );
    const protocol = protocolOf(request);
    if (protocol === undefined) return previous(input, init);
    const raw = await request.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return previous(input, init);
    }
    const required = executionConfirmation(body, protocol);
    const context = statuses.context();
    if (!required && context === undefined) return previous(input, init);
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const response = await previous(
      new Request(request, {
        headers,
        body: JSON.stringify({
          ...body,
          ...(required
            ? {
                tool_choice:
                  protocol === "messages" ? { type: "any" } : "required",
              }
            : {}),
          ...(context === undefined ? {} : { hark_status: true }),
        }),
      }),
    );
    return context === undefined
      ? response
      : statuses.response(response, context);
  };
  const uninstall = () => {
    statuses.uninstall();
    if (globalThis.fetch === guarded) globalThis.fetch = previous;
    if (globalThis[GUARD] === uninstall) delete globalThis[GUARD];
  };
  globalThis.fetch = guarded;
  globalThis[GUARD] = uninstall;
  return uninstall;
};

// Only the Hark launch installs this observer. It never changes ACP bytes or
// starts stdin flowing; an ambiguous multi-prompt connection stays unadapted.
export const createHarkStatusBridge = (input, output) => {
  const prompts = new Map();
  const activeStreams = new Set();
  const originalEmit = input.emit;
  const originalWrite = output.write;
  let inputTail = "";
  let outputTail = "";
  let ordinal = 0;
  const inputDecoder = new TextDecoder();
  const outputDecoder = new TextDecoder();
  let writingOutput = false;
  const pendingNotifications = [];
  const flushNotifications = () => {
    if (writingOutput || outputTail !== "") return;
    while (pendingNotifications.length)
      originalWrite.call(output, pendingNotifications.shift());
  };
  const inspectLines = (tail, chunk, visit, decoder) => {
    const text =
      tail +
      (typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true }));
    const lines = text.split("\n");
    const rest = lines.pop();
    for (const line of lines) {
      try {
        visit(JSON.parse(line));
      } catch {}
    }
    return rest.length > 1024 * 1024 ? "" : rest;
  };
  const context = () => {
    const owner =
      prompts.size === 1 ? prompts.values().next().value : undefined;
    return owner?.cancelled ? undefined : owner;
  };
  const observedEmit = function (event, ...args) {
    if (event === "data") {
      inputTail = inspectLines(
        inputTail,
        args[0],
        (message) => {
          if (
            message.method === "session/prompt" &&
            message.id !== undefined &&
            typeof message.params?.sessionId === "string"
          ) {
            prompts.set(String(message.id), {
              id: String(message.id),
              sessionId: message.params.sessionId,
            });
          }
          if (message.method === "session/cancel") {
            for (const stream of activeStreams)
              if (stream.owner.sessionId === message.params?.sessionId)
                stream.end("cancelled");
            for (const owner of prompts.values())
              if (owner.sessionId === message.params?.sessionId)
                owner.cancelled = true;
          }
        },
        inputDecoder,
      );
    }
    return originalEmit.call(this, event, ...args);
  };
  const observedWrite = function (chunk, ...args) {
    writingOutput = true;
    outputTail = inspectLines(
      outputTail,
      chunk,
      (message) => {
        if (message.id === undefined || message.method !== undefined) return;
        const owner = prompts.get(String(message.id));
        if (owner === undefined) return;
        for (const stream of activeStreams)
          if (stream.owner === owner)
            stream.end(message.error ? "error" : "stream_ended");
        prompts.delete(String(message.id));
      },
      outputDecoder,
    );
    const result = originalWrite.call(this, chunk, ...args);
    writingOutput = false;
    flushNotifications();
    return result;
  };
  input.emit = observedEmit;
  output.write = observedWrite;
  const response = (upstream, owner = context()) => {
    if (
      !owner ||
      !upstream.body ||
      !upstream.headers.get("content-type")?.includes("text/event-stream")
    )
      return upstream;
    const requestOrdinal = ++ordinal;
    let latest;
    let protocolEnded = false;
    let pending = "";
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const notify = (status) => {
      if (
        prompts.get(owner.id) !== owner ||
        prompts.size !== 1 ||
        owner.cancelled
      )
        return;
      pendingNotifications.push(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: owner.sessionId,
            update: {
              sessionUpdate: "session_info_update",
              _meta: { hark: { status, requestOrdinal } },
            },
          },
        }) + "\n",
      );
      flushNotifications();
    };
    const accept = (status) => {
      if (
        !isRecord(status) ||
        status.type !== "hark.status" ||
        !["processing", "waiting_for_user", "ended"].includes(status.status) ||
        typeof status.request_id !== "string" ||
        !status.request_id ||
        typeof status.conversation_id !== "string" ||
        !Number.isSafeInteger(status.sequence) ||
        status.sequence < 0 ||
        (status.line !== undefined && typeof status.line !== "string") ||
        (status.line?.length ?? 0) > 4096
      )
        return;
      if (
        latest &&
        (status.request_id !== latest.request_id ||
          status.sequence <= latest.sequence ||
          latest.status === "ended" ||
          (latest.status === "waiting_for_user" &&
            !(
              status.status === "ended" &&
              ["error", "cancelled"].includes(status.reason)
            )))
      )
        return;
      latest = status;
      notify(status);
    };
    const state = {
      owner,
      end(reason) {
        if (
          latest &&
          (latest.status === "processing" ||
            (latest.status === "waiting_for_user" &&
              ["error", "cancelled"].includes(reason)))
        ) {
          latest = {
            ...latest,
            status: "ended",
            line: "",
            line_key: "",
            sequence: latest.sequence + 1,
            reason,
          };
          notify(latest);
        }
      },
    };
    activeStreams.add(state);
    const filter = (block) => {
      const lines = block.split(/\r?\n/u);
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      const custom = lines.some((line) =>
        /^event:\s*hark\.status\s*$/u.test(line),
      );
      try {
        if (data === "[DONE]") {
          protocolEnded = true;
          state.end("stream_ended");
        } else {
          const value = JSON.parse(data);
          if (custom) accept(value);
          else if (value.type === "response.failed" || value.error)
            state.end("error");
          else if (
            value.type === "response.completed" ||
            value.type === "message_stop"
          ) {
            protocolEnded = true;
            state.end("stream_ended");
          }
        }
      } catch {}
      return custom ? "" : block;
    };
    const reader = upstream.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        try {
          while (true) {
            const item = await reader.read();
            pending += decoder.decode(item.value, { stream: !item.done });
            let delimiter;
            let emitted = false;
            while ((delimiter = /\r?\n\r?\n/u.exec(pending)) !== null) {
              const end = delimiter.index + delimiter[0].length;
              const block = pending.slice(0, end);
              pending = pending.slice(end);
              const kept = filter(block);
              if (kept) {
                controller.enqueue(encoder.encode(kept));
                emitted = true;
              }
            }
            if (item.done) {
              if (pending) {
                const kept = filter(pending);
                if (kept) controller.enqueue(encoder.encode(kept));
              }
              state.end("stream_ended");
              activeStreams.delete(state);
              controller.close();
              return;
            }
            if (pending.length > 1024 * 1024)
              throw new Error("Status stream frame exceeds limit");
            if (emitted) return;
          }
        } catch (error) {
          state.end("error");
          activeStreams.delete(state);
          controller.error(error);
        }
      },
      async cancel(reason) {
        state.end(protocolEnded ? "stream_ended" : "cancelled");
        activeStreams.delete(state);
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  };
  return {
    context,
    response,
    uninstall() {
      if (input.emit === observedEmit) input.emit = originalEmit;
      if (output.write === observedWrite) output.write = originalWrite;
      prompts.clear();
      activeStreams.clear();
      pendingNotifications.length = 0;
    },
  };
};

// A launch-scoped marker survives npm/npx, then is consumed by the ACP process.
// Tool subprocesses inherit NODE_OPTIONS but not activation for another agent.
if (
  process.env.HARK_CLIENT_TOOL_CONTRACT === "1" &&
  process.env.HARK_CLIENT_TOOL_CONTRACT_HOME &&
  process.env.DSH_HOME &&
  resolve(process.env.HARK_CLIENT_TOOL_CONTRACT_HOME) ===
    resolve(process.env.DSH_HOME) &&
  !/(?:^|[\\/])(?:npm-cli|npx-cli)\.(?:c?js|mjs)$/u.test(process.argv[1] ?? "")
) {
  installHarkExecutionContract();
  delete process.env.HARK_CLIENT_TOOL_CONTRACT;
  delete process.env.HARK_CLIENT_TOOL_CONTRACT_HOME;
}
