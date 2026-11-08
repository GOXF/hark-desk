import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { installHarkExecutionRuntime } from './install-hark-execution-runtime.mjs';

test('compatibility bootstrap affects Hark only, is idempotent, and preserves original entrypoint', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hark execution contract '));
  try {
    const runtimeRoot = join(fixture, 'node_modules', 'deepseek-acp');
    const agentHome = join(fixture, 'hark home');
    const bin = join(runtimeRoot, 'lib', 'bin.js');
    mkdirSync(join(runtimeRoot, 'lib'), { recursive: true });
    writeFileSync(join(runtimeRoot, 'package.json'), JSON.stringify({ name: 'deepseek-acp', version: '0.9.0', type: 'module' }));
    const original = `#!/usr/bin/env node
globalThis.fetch = async (input, init) => new Response(await new Request(input, init).text());
const body = {
  messages: [{ role: 'assistant', content: '要我运行回归测试吗？' }, { role: 'user', content: '要' }],
  tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
  tool_choice: 'auto'
};
const result = await fetch('https://fixture.invalid/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
process.stdout.write(await result.text());
`;
    // The fetch fixture must exist before the injected bootstrap wraps it.
    const fixtureFetch = join(fixture, 'fetch-fixture.mjs');
    writeFileSync(fixtureFetch, "globalThis.fetch = async (input, init) => new Response(await new Request(input, init).text());\n");
    const entrypoint = original.replace('globalThis.fetch = async (input, init) => new Response(await new Request(input, init).text());\n', '');
    writeFileSync(bin, entrypoint);
    const first = installHarkExecutionRuntime({ runtimeRoot, agentHome, apply: true });
    const second = installHarkExecutionRuntime({ runtimeRoot, agentHome, apply: true });
    assert.equal(first.modified_sha256, second.modified_sha256);
    const modified = readFileSync(bin, 'utf8');
    assert.ok(modified.endsWith(entrypoint.slice(entrypoint.indexOf('\n') + 1)));
    assert.equal(modified.split('HARK_CLIENT_TOOL_CONTRACT_BOOTSTRAP_V1_BEGIN').length, 2);
    for (const [home, choice] of [[agentHome, 'required'], [join(fixture, 'deepseek home'), 'auto']]) {
      const env = { ...process.env, DSH_HOME: home, NODE_OPTIONS: '' };
      delete env.HARK_CLIENT_TOOL_CONTRACT;
      const run = spawnSync(process.execPath, ['--import', pathToFileURL(fixtureFetch).href, bin], { env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).tool_choice, choice);
    }
  } finally {
    assert.equal(resolve(dirname(fixture)), resolve(tmpdir()));
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('unverified runtime versions are preserved', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hark runtime version '));
  try {
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({ name: 'deepseek-acp', version: '9.9.9' }));
    assert.throws(() => installHarkExecutionRuntime({ runtimeRoot: fixture, agentHome: fixture, apply: true }), /verified deepseek-acp 0.9.0/u);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8')), { name: 'deepseek-acp', version: '9.9.9' });
  } finally {
    assert.equal(resolve(dirname(fixture)), resolve(tmpdir()));
    rmSync(fixture, { recursive: true, force: true });
  }
});
