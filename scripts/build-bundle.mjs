import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const outDir = join(root, 'dist-bundle');
const stageName = `factory-${pkg.version}`;
const stageDir = join(outDir, stageName);
const archivePath = join(outDir, `${stageName}.tar.gz`);

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md']) {
  const src = join(root, file);
  if (existsSync(src)) copyFileSync(src, join(stageDir, file));
}

for (const dir of ['bin', 'src', 'dist', 'scripts']) {
  const src = join(root, dir);
  if (existsSync(src)) cpSync(src, join(stageDir, dir), { recursive: true });
}

execFileSync('tar', ['-czf', archivePath, '-C', outDir, stageName], { stdio: 'inherit' });
rmSync(stageDir, { recursive: true, force: true });

console.log(`Created installer bundle: ${archivePath}`);
