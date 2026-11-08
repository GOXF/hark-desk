import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const moduleUrl = new URL('./hark_short_confirmation.mjs', import.meta.url);
const contract = existsSync(moduleUrl)
  ? await import(moduleUrl.href)
  : undefined;
const proposal = '要我把这六句加进回归测试确认吗？';

const requestBody = (protocol, last = '要', preceding = proposal) => ({
  model: 'fixture-public-name',
  stream: true,
  ...(protocol === 'responses'
    ? {
        input: [
          { role: 'user', content: '把六句加进回归测试。' },
          { role: 'assistant', content: preceding },
          { role: 'user', content: last },
        ],
      }
    : {
        messages: [
          {
            role: 'system',
            content: 'Workspace: fixture; preserve tool receipts.',
          },
          { role: 'user', content: '把六句加进回归测试。' },
          { role: 'assistant', content: preceding },
          { role: 'user', content: last },
        ],
      }),
  tools:
    protocol === 'messages'
      ? [{ name: 'read_file', input_schema: { type: 'object' } }]
      : protocol === 'responses'
        ? [
            {
              type: 'function',
              name: 'read_file',
              parameters: { type: 'object' },
            },
          ]
        : [
            {
              type: 'function',
              function: { name: 'read_file', parameters: { type: 'object' } },
            },
          ],
  tool_choice: protocol === 'messages' ? { type: 'auto' } : 'auto',
  metadata: { fixture: true },
});

const captureRequest = async (body, protocol = 'chat', options = {}) => {
  const previous = globalThis.fetch;
  const response = new Response('{"error":{"code":"tool_call_missing"}}', {
    status: 422,
  });
  const captures = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    captures.push({ body: await request.text(), headers: request.headers });
    return response;
  };
  const uninstall = contract?.installHarkExecutionContract();
  try {
    const suffix = {
      chat: 'chat/completions',
      responses: 'responses',
      messages: 'messages',
    }[protocol];
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fixture-only',
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      ...options,
    };
    const result = await globalThis.fetch(
      `https://fixture.invalid/v1/${suffix}`,
      init
    );
    assert.equal(
      result,
      response,
      'the response must not be replaced or consumed'
    );
    assert.equal(captures.length, 1, 'never replay a submitted request');
    assert.equal(
      captures[0].headers.get('authorization'),
      'Bearer fixture-only'
    );
    assert.equal(await result.text(), '{"error":{"code":"tool_call_missing"}}');
    return captures[0].body;
  } finally {
    uninstall?.();
    globalThis.fetch = previous;
  }
};

for (const protocol of ['chat', 'responses', 'messages']) {
  test(`${protocol}: short approval requires a tool and preserves all task history`, async () => {
    const body = requestBody(protocol);
    const result = JSON.parse(await captureRequest(body, protocol));
    assert.deepEqual(result, {
      ...body,
      tool_choice: protocol === 'messages' ? { type: 'any' } : 'required',
    });
  });

  test(`${protocol}: replayed history resumes the proposal, not a completed tool action`, async () => {
    const body = requestBody(protocol);
    const history = protocol === 'responses' ? 'input' : 'messages';
    const completed = {
      ...body,
      [history]: [
        ...body[history].slice(0, -1),
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_fixture',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_fixture',
          content: 'actual receipt; exit=0',
        },
      ],
    };
    assert.equal(
      await captureRequest(completed, protocol),
      JSON.stringify(completed)
    );
  });
}

for (const acknowledgement of [
  '好',
  '好的',
  '可以',
  '行',
  '继续',
  '按这个做',
  'yes',
  'go ahead',
]) {
  test(`explicit execution approval: ${acknowledgement}`, async () => {
    const body = requestBody('chat', acknowledgement);
    assert.equal(
      JSON.parse(await captureRequest(body)).tool_choice,
      'required'
    );
  });
}

for (const [name, body] of [
  ['negative', requestBody('chat', '不要')],
  ['qualified approval', requestBody('chat', '要，但先解释一下')],
  ['identity question', requestBody('chat', '你是什么模型？')],
  [
    'explanation offer',
    requestBody('chat', '要', '要我解释这些测试怎么运行吗？'),
  ],
  ['examples offer', requestBody('chat', '要', '要我写一段示例代码吗？')],
  ['no proposal', requestBody('chat', '继续', '测试已经完成。')],
  [
    'nested explanation',
    requestBody(
      'chat',
      'yes',
      'Would you like me to first explain how to run the tests?'
    ),
  ],
  [
    'detailed introduction',
    requestBody('chat', '要', '要我给你详细介绍怎么运行这些测试吗？'),
  ],
  [
    'written summary',
    requestBody(
      'chat',
      'yes',
      'Would you like me to write a summary of the test results?'
    ),
  ],
  [
    'test results summary',
    requestBody('chat', '要', '要我根据测试结果写一段总结吗？'),
  ],
  [
    'tell how to run',
    requestBody(
      'chat',
      'yes',
      'Would you like me to tell you how to run the tests?'
    ),
  ],
  [
    'walk through tests',
    requestBody(
      'chat',
      'yes',
      'Would you like me to walk you through how to run the tests?'
    ),
  ],
  [
    'detailed walkthrough',
    requestBody('chat', '要', '要我给你详细讲讲怎么运行回归测试吗？'),
  ],
  ['explicit none', { ...requestBody('chat'), tool_choice: 'none' }],
  [
    'explicit named choice',
    {
      ...requestBody('chat'),
      tool_choice: { type: 'function', function: { name: 'read_file' } },
    },
  ],
  ['no declared tools', { ...requestBody('chat'), tools: [] }],
  ['missing history', { ...requestBody('responses'), input: '要' }],
  [
    'unknown tools',
    { ...requestBody('chat'), tools: [{ type: 'web_search' }] },
  ],
]) {
  test(`ordinary or ambiguous request stays byte-identical: ${name}`, async () => {
    const protocol = typeof body.input === 'string' ? 'responses' : 'chat';
    assert.equal(await captureRequest(body, protocol), JSON.stringify(body));
  });
}

test('valid transport failures propagate without replay or rewritten output', async () => {
  const previous = globalThis.fetch;
  const failure = new Error('fixture connection interrupted');
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw failure;
  };
  const uninstall = contract?.installHarkExecutionContract();
  try {
    await assert.rejects(
      globalThis.fetch('https://fixture.invalid/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(requestBody('chat')),
      }),
      (error) => error === failure
    );
    assert.equal(calls, 1);
  } finally {
    uninstall?.();
    globalThis.fetch = previous;
  }
});

for (const acknowledgement of ['要', '不要']) {
  test(`Request input preserves its body through adaptation: ${acknowledgement}`, async () => {
    const previous = globalThis.fetch;
    const body = requestBody('chat', acknowledgement);
    const response = new Response('fixture untouched');
    let received;
    globalThis.fetch = async (input, init) => {
      received = JSON.parse(await new Request(input, init).text());
      return response;
    };
    const uninstall = contract?.installHarkExecutionContract();
    try {
      const request = new Request(
        'https://fixture.invalid/v1/chat/completions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
      assert.equal(await globalThis.fetch(request), response);
      assert.deepEqual(
        received,
        acknowledgement === '要' ? { ...body, tool_choice: 'required' } : body
      );
    } finally {
      uninstall?.();
      globalThis.fetch = previous;
    }
  });
}

test('English execution offer requires a tool without changing message text', async () => {
  const body = requestBody(
    'chat',
    'yes please',
    'Would you like me to run the regression tests?'
  );
  assert.deepEqual(JSON.parse(await captureRequest(body)), {
    ...body,
    tool_choice: 'required',
  });
});

test('structured assistant tool use is not reinterpreted as a fresh pending action', async () => {
  const body = requestBody('messages');
  body.messages[2] = {
    role: 'assistant',
    content: [
      { type: 'text', text: proposal },
      { type: 'tool_use', id: 'call_fixture', name: 'read_file', input: {} },
    ],
  };
  assert.equal(await captureRequest(body, 'messages'), JSON.stringify(body));
});

test('native preload handles aliases, preserves npm handoff, and does not activate another agent', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hark preload scope '));
  try {
    const childSource = `
      import { spawnSync } from 'node:child_process';
      const active = typeof globalThis[Symbol.for('hark.clientToolConfirmationContract')] === 'function';
      const result = { active, marker: process.env.HARK_CLIENT_TOOL_CONTRACT ?? null };
      if (active) {
        const child = spawnSync(process.execPath, ['-e', "process.stdout.write(String(typeof globalThis[Symbol.for('hark.clientToolConfirmationContract')]))"], {
          env: { ...process.env, DSH_HOME: process.env.DSH_HOME + '-other' }, encoding: 'utf8'
        });
        if (child.status !== 0) throw new Error(child.stderr);
        result.childActive = child.stdout;
      }
      process.stdout.write(JSON.stringify(result));
    `;
    for (const [name, home, expected] of [
      [
        'renamed-acp.mjs',
        fixture,
        { active: true, marker: null, childActive: 'undefined' },
      ],
      [
        'unrelated-agent.mjs',
        fixture + '-other',
        { active: false, marker: '1' },
      ],
      ['npx-cli.js', fixture, { active: false, marker: '1' }],
    ]) {
      const entry = join(fixture, name);
      writeFileSync(entry, childSource);
      const run = spawnSync(process.execPath, [entry], {
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${moduleUrl.href}`,
          HARK_CLIENT_TOOL_CONTRACT: '1',
          HARK_CLIENT_TOOL_CONTRACT_HOME: fixture,
          DSH_HOME: home,
        },
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), expected);
    }
  } finally {
    assert.equal(resolve(dirname(fixture)), resolve(tmpdir()));
    rmSync(fixture, { recursive: true, force: true });
  }
});
