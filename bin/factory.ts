#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '../..');
const require = createRequire(import.meta.url);

function resolvePiCliEntry(): string {
  let dir = packageRoot;
  while (true) {
    const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate @earendil-works/pi-coding-agent/dist/cli.js');
}

function isPackageConfiguredInPiSettings(pkgName: string): boolean {
  const candidates = [
    join(homedir(), '.pi', 'agent', 'settings.json'),
    join(process.cwd(), '.pi', 'settings.json'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        packages?: Array<string | { source?: string }>;
      };
      for (const entry of parsed.packages ?? []) {
        const src = typeof entry === 'string' ? entry : entry.source ?? '';
        if (src === pkgName || src.endsWith(`/${pkgName}`) || src.endsWith(`:${pkgName}`)) {
          return true;
        }
      }
    } catch {
      // Ignore malformed settings.json
    }
  }
  return false;
}

function resolveDefaultExtensions(): string[] {
  const extensions: string[] = [];

  const factoryExt = join(packageRoot, 'dist', 'src', 'extension', 'index.js');
  if (existsSync(factoryExt)) {
    extensions.push(factoryExt);
  }

  // Ensure pi-web-access and pi-durable-subagents are loaded by default
  // unless already configured in pi's settings.json packages list.
  for (const pkgName of ['pi-web-access', 'pi-durable-subagents']) {
    if (isPackageConfiguredInPiSettings(pkgName)) continue;
    try {
      const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
      const pkgRoot = dirname(pkgJsonPath);
      const pkg = require(pkgJsonPath) as { pi?: { extensions?: string[] } };
      for (const rel of pkg.pi?.extensions ?? []) {
        const full = resolve(pkgRoot, rel);
        if (existsSync(full)) extensions.push(full);
      }
      continue;
    } catch {
      // Fall through to pi's git package directory.
    }

    if (pkgName === 'pi-durable-subagents') {
      const gitPkgRoot = join(homedir(), '.pi', 'agent', 'git', 'github.com', 'anasalqoyyum', 'pi-durable-subagents');
      const gitPkgJson = join(gitPkgRoot, 'package.json');
      if (existsSync(gitPkgJson)) {
        try {
          const pkg = JSON.parse(readFileSync(gitPkgJson, 'utf8')) as { pi?: { extensions?: string[] } };
          for (const rel of pkg.pi?.extensions ?? []) {
            const full = resolve(gitPkgRoot, rel);
            if (existsSync(full)) extensions.push(full);
          }
        } catch {
          // Ignore malformed manifest; pi's own package loader will report if configured.
        }
      }
    }
  }

  return extensions;
}

function buildLaunchArgs(userArgs: string[]): string[] {
  const firstArg = userArgs[0];
  // Pass subcommands (e.g., `install`, `remove`, `list`, `update`) straight through to `pi`.
  const passthroughSubcommands = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config']);
  if (firstArg && passthroughSubcommands.has(firstArg)) {
    return userArgs;
  }

  const extraFlags: string[] = [];
  for (const extPath of resolveDefaultExtensions()) {
    extraFlags.push('-e', extPath);
  }

  // Default to factory-llama/lfm-aa1 (Singleton placeholder) unless the user explicitly passed --provider or --model
  const hasProviderFlag = userArgs.some((a) => a === '--provider' || a.startsWith('--provider='));
  const hasModelFlag = userArgs.some((a) => a === '--model' || a.startsWith('--model='));
  if (!hasProviderFlag && !hasModelFlag) {
    extraFlags.push('--provider', process.env.FACTORY_PROVIDER ?? 'factory-llama');
    extraFlags.push('--model', process.env.FACTORY_ORCHESTRATOR_MODEL ?? 'lfm-aa1');
  }

  return [...extraFlags, ...userArgs];
}

const piCli = resolvePiCliEntry();
const launchArgs = buildLaunchArgs(process.argv.slice(2));
const nodeArgs = piCli.endsWith('.ts') ? ['--experimental-strip-types', piCli, ...launchArgs] : [piCli, ...launchArgs];

const child = spawn(process.execPath, nodeArgs, {
  stdio: 'inherit',
  env: {
    ...process.env,
    FACTORY_ACTIVE: '1',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
