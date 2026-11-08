import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const START = '// HARK_CLIENT_TOOL_CONTRACT_BOOTSTRAP_V1_BEGIN';
const END = '// HARK_CLIENT_TOOL_CONTRACT_BOOTSTRAP_V1_END';
const hash = value => createHash('sha256').update(value).digest('hex');

const writeAtomic = (path, content, mode) => {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, content, { mode });
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
};

// Compatibility installation for an already-running desktop host. New builds
// use the same source through hark_native.rs's Hark-only NODE_OPTIONS preload.
export const installHarkExecutionRuntime = ({ runtimeRoot, agentHome, apply = false }) => {
  const root = resolve(runtimeRoot);
  const home = resolve(agentHome);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'deepseek-acp' || pkg.version !== '0.9.0') {
    throw new Error('Expected the verified deepseek-acp 0.9.0 runtime; preserve other versions.');
  }
  const source = readFileSync(new URL('../crates/agents/src/hark_short_confirmation.mjs', import.meta.url), 'utf8');
  const modulePath = join(home, 'runtime', 'hark-execution-contract.mjs');
  const binPath = join(root, 'lib', 'bin.js');
  const original = readFileSync(binPath, 'utf8');
  const begin = original.indexOf(START);
  const end = original.indexOf(END);
  if ((begin === -1) !== (end === -1) || (begin >= 0 && end < begin)) {
    throw new Error('Incomplete previous Hark bootstrap; preserve the runtime for review.');
  }
  const clean = begin === -1 ? original : original.slice(0, begin) + original.slice(end + END.length).replace(/^\r?\n/u, '');
  const insertion = clean.startsWith('#!') ? clean.indexOf('\n') + 1 : 0;
  const bootstrap = `${START}
{
  const { resolve: harkResolve } = await import('node:path');
  if (process.env.DSH_HOME && harkResolve(process.env.DSH_HOME) === ${JSON.stringify(home)}) {
    const { installHarkExecutionContract } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    installHarkExecutionContract();
  }
}
${END}
`;
  const modified = clean.slice(0, insertion) + bootstrap + clean.slice(insertion);
  if (apply) {
    writeAtomic(modulePath, source, 0o600);
    if (modified !== original) writeAtomic(binPath, modified, statSync(binPath).mode);
  }
  return {
    applied: apply, runtime_version: pkg.version, bin_path: binPath,
    module_path: modulePath, original_sha256: hash(original), modified_sha256: hash(modified),
    module_sha256: hash(source),
  };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const runtimeRoot = args[args.indexOf('--runtime') + 1];
  const agentHome = args[args.indexOf('--home') + 1];
  if (!args.includes('--runtime') || !runtimeRoot || !args.includes('--home') || !agentHome) {
    throw new Error('Usage: node install-hark-execution-runtime.mjs --runtime PACKAGE_ROOT --home HARK_HOME [--apply]');
  }
  process.stdout.write(`${JSON.stringify(installHarkExecutionRuntime({ runtimeRoot, agentHome, apply: args.includes('--apply') }), null, 2)}\n`);
}
