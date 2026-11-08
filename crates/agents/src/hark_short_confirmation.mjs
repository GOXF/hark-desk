// Hark-only request adaptation. History remains authoritative; no response text,
// tool receipt, execution status or retry is synthesized here.
import { resolve } from 'node:path';

const GUARD = Symbol.for('hark.clientToolConfirmationContract');

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const messageText = (message) => {
  if (typeof message.content === 'string') return message.content;
  if (
    !Array.isArray(message.content) ||
    !message.content.every(
      (part) =>
        isRecord(part) &&
        ['text', 'input_text', 'output_text'].includes(part.type) &&
        typeof part.text === 'string'
    )
  )
    return undefined;
  return message.content.map((part) => part.text).join('');
};

const isShortApproval = (text) =>
  [
    '要',
    '好',
    '好的',
    '可以',
    '行',
    '继续',
    '开始吧',
    '按这个做',
    '照这个做',
    '就这样做',
    'yes',
    'yesplease',
    'goahead',
    'doit',
    'proceed',
    'ok',
    'okay',
  ].includes(text.replace(/[\s?？!！.。，,]/gu, '').toLowerCase());

const isExecutionOffer = (text) => {
  const chinese = text.match(
    /(?:要不要我|要我|需要我|是否要我|是否让我)([^？?\n]{1,600}?)(?:吗|么)?[？?]\s*$/u
  )?.[1];
  if (chinese !== undefined) {
    if (
      /示例|例子|方案|建议|原理|解释|说明|介绍|总结|概述|列举|举例|讨论/u.test(
        chinese
      ) ||
      /^(?:先|再|给你|为你|帮你)?(?:解释|说明|介绍|讲|列举|举例|分析|讨论)/u.test(
        chinese
      )
    )
      return false;
    return /^(?:(?:先|再|现在|直接|帮你|为你|给你|替你|帮忙)\s*)*(?:(?:执行|运行|读取|检查|查找|搜索|修改|修复|更新|安装|删除|创建|写入|保存|提交|部署|测试|跑)|(?:把|将)[^，,？?\n]{1,300}(?:加进|加入|写入|保存|修改|修复|删除|创建|安装|提交|部署))/u.test(
      chinese
    );
  }
  const english = text.match(
    /(?:would you like me to|do you want me to|shall i|should i)\s+([^?\n]{1,600})\?\s*$/iu
  )?.[1];
  return (
    english !== undefined &&
    !/\b(?:explain|describe|discuss|outline|suggest|show|list|example|examples|sample|suggestion|summary|summarize|description|explanation|pseudocode)\b/iu.test(
      english
    ) &&
    /^(?:(?:first|then|now|directly|please)\s+)*(?:run|read|inspect|search|edit|fix|update|install|delete|create|write|save|commit|deploy|test|add)\b/iu.test(
      english
    )
  );
};

const hasDeclaredClientTool = (tool) =>
  isRecord(tool) &&
  ((tool.type === 'function' &&
    (typeof tool.name === 'string' ||
      (isRecord(tool.function) && typeof tool.function.name === 'string'))) ||
    (tool.type === undefined &&
      typeof tool.name === 'string' &&
      isRecord(tool.input_schema)) ||
    (tool.type === 'custom' && typeof tool.name === 'string') ||
    tool.type === 'local_shell');

const hasToolCall = (message) =>
  (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
  message.function_call !== undefined ||
  (Array.isArray(message.content) &&
    message.content.some(
      (part) =>
        isRecord(part) &&
        [
          'tool_use',
          'tool_result',
          'function_call',
          'function_call_output',
        ].includes(part.type)
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
    choice !== 'auto' &&
    !(isRecord(choice) && choice.type === 'auto')
  )
    return false;
  const history = protocol === 'responses' ? body.input : body.messages;
  if (!Array.isArray(history) || history.length < 2) return false;
  const user = history.at(-1);
  const assistant = history.at(-2);
  if (
    !isRecord(user) ||
    user.role !== 'user' ||
    !isRecord(assistant) ||
    assistant.role !== 'assistant' ||
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
    request.method !== 'POST' ||
    !request.headers.get('content-type')?.includes('application/json')
  )
    return undefined;
  const path = new URL(request.url).pathname.replace(/\/$/u, '');
  if (path.endsWith('/chat/completions')) return 'chat';
  if (path.endsWith('/responses')) return 'responses';
  if (path.endsWith('/messages')) return 'messages';
  return undefined;
};

export const installHarkExecutionContract = () => {
  if (globalThis[GUARD] !== undefined) return globalThis[GUARD];
  const previous = globalThis.fetch;
  const guarded = async (input, init) => {
    // A Request body belongs to the caller; inspect a clone, never transfer it
    // and then try to forward an already-consumed original on a no-change path.
    if (
      init?.body !== undefined &&
      init.body !== null &&
      typeof init.body !== 'string'
    )
      return previous(input, init);
    const request = new Request(
      input instanceof Request ? input.clone() : input,
      init
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
    if (!executionConfirmation(body, protocol)) return previous(input, init);
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    return previous(
      new Request(request, {
        headers,
        body: JSON.stringify({
          ...body,
          tool_choice: protocol === 'messages' ? { type: 'any' } : 'required',
        }),
      })
    );
  };
  const uninstall = () => {
    if (globalThis.fetch === guarded) globalThis.fetch = previous;
    if (globalThis[GUARD] === uninstall) delete globalThis[GUARD];
  };
  globalThis.fetch = guarded;
  globalThis[GUARD] = uninstall;
  return uninstall;
};

// A launch-scoped marker survives npm/npx, then is consumed by the ACP process.
// Tool subprocesses inherit NODE_OPTIONS but not activation for another agent.
if (
  process.env.HARK_CLIENT_TOOL_CONTRACT === '1' &&
  process.env.HARK_CLIENT_TOOL_CONTRACT_HOME &&
  process.env.DSH_HOME &&
  resolve(process.env.HARK_CLIENT_TOOL_CONTRACT_HOME) ===
    resolve(process.env.DSH_HOME) &&
  !/(?:^|[\\/])(?:npm-cli|npx-cli)\.(?:c?js|mjs)$/u.test(process.argv[1] ?? '')
) {
  installHarkExecutionContract();
  delete process.env.HARK_CLIENT_TOOL_CONTRACT;
  delete process.env.HARK_CLIENT_TOOL_CONTRACT_HOME;
}
