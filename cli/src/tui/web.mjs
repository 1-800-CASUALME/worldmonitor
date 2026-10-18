// `worldmonitor web`: open the original web dashboard. Inside a WorldMonitor
// repository checkout this starts the Vite dev server and opens it; elsewhere
// it opens the hosted dashboard in the default browser.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openExternal } from './video.mjs';

export const HOSTED_DASHBOARD_URL = 'https://www.worldmonitor.app/dashboard';

function isWorldMonitorRoot(dir) {
  try {
    if (!existsSync(join(dir, 'vite.config.ts'))) return false;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return pkg && pkg.name === 'world-monitor' && pkg.scripts && typeof pkg.scripts.dev === 'string';
  } catch {
    return false;
  }
}

// Walk up from `start` looking for the repository root; also try the CLI's own
// parent directory (the CLI lives in <repo>/cli when run from a checkout).
export function findRepoRoot(start = process.cwd(), selfUrl = import.meta.url) {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (isWorldMonitorRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const here = resolve(dirname(fileURLToPath(selfUrl)), '..', '..', '..');
    if (isWorldMonitorRoot(here)) return here;
  } catch {
    // not a file URL
  }
  return null;
}

export async function runWeb({ options = {}, stdout = (s) => process.stdout.write(s), stderr = (s) => process.stderr.write(s), env = process.env, spawnImpl = spawn, open = openExternal, cwd = process.cwd() } = {}) {
  const root = options.hosted ? null : findRepoRoot(cwd);
  if (!root) {
    const url = options.url || HOSTED_DASHBOARD_URL;
    stdout(`Opening ${url}\n`);
    if (!options.noOpen) open(url);
    return 0;
  }
  const port = String(options.port || env.PORT || 5173);
  stdout(`WorldMonitor checkout found at ${root}\nStarting the web dashboard: npm run dev -- --port ${port}\n`);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawnImpl(npm, ['run', 'dev', '--', '--port', port, '--strictPort'], { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], env });
  let opened = options.noOpen === true;
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout(text);
    if (!opened) {
      const m = /(https?:\/\/(?:localhost|127\.0\.0\.1)[^\s]*)/.exec(text.replace(/\x1b\[[0-9;]*m/g, ''));
      if (m) {
        opened = true;
        open(m[1]);
      }
    }
  });
  return new Promise((resolveExit) => {
    child.on('error', (err) => {
      stderr(`Could not start the dev server: ${err.message}\n`);
      resolveExit(1);
    });
    child.on('exit', (code) => resolveExit(code === null ? 1 : code));
    const forward = () => child.kill('SIGINT');
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
  });
}
