/**
 * Boots and stops Lightning as a local process, straight from a source
 * checkout — the same way a Lightning developer runs it.
 *
 * `up` prepares the checkout (deps, assets, db create + migrate) and runs
 * `mix phx.server` detached, waiting for /health_check; the PID lands in
 * tmp/harness-state.json so `down` can stop it.
 *
 * Prerequisites on the host: Elixir/Erlang matching Lightning's .tool-versions
 * (asdf picks them up), node, and a postgres reachable at DATABASE_URL.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { LightningSource } from './source.js';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PORT = process.env.PORT ?? '4003';
export const BASE_URL = `http://localhost:${PORT}`;
// A database of our own: never the dev DB, and not shared with Lightning's
// bin/e2e either — harness runs can't touch anyone else's data.
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost/lightning_integration_e2e';
const HEALTH_TIMEOUT_MS = Number(process.env.HARNESS_BOOT_TIMEOUT_MS ?? 600_000);

const STATE_FILE = resolve(root, 'tmp', 'harness-state.json');
const LOG_FILE = resolve(root, 'tmp', 'lightning.log');

/** Env for every command we run inside the Lightning checkout. */
function lightningEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MIX_ENV: 'dev',
    PORT,
    DATABASE_URL,
    // Lightning must NOT spawn its own worker — the harness controls which
    // worker connects, so the worker under test is always an explicit choice.
    RTM: 'false',
  };
}

function run(dir: string, cmd: string, ...args: string[]): void {
  execFileSync(cmd, args, { cwd: dir, stdio: 'inherit', env: lightningEnv() });
}

function mix(dir: string, ...args: string[]): void {
  run(dir, 'mix', ...args);
}

export async function up(source: LightningSource): Promise<void> {
  // Same sequence as Lightning's own bin/bootstrap; everything is idempotent
  // and cached, so re-runs on a warm checkout are quick.
  console.log(`[harness] preparing ${source.label}…`);
  mix(source.dir, 'deps.get');
  run(source.dir, 'npm', 'install', '--prefix', 'assets');
  mix(source.dir, 'assets.setup');
  if (process.arch === 'arm64') {
    // rambo ships no arm64 binary — build it from source (needs Rust, the same
    // prerequisite Lightning's own bin/bootstrap enforces on Apple Silicon).
    mix(source.dir, 'compile.rambo');
  }
  mix(source.dir, 'lightning.install_runtime');
  mix(source.dir, 'ecto.create', '--quiet');
  mix(source.dir, 'ecto.migrate', '--quiet');

  console.log(`[harness] starting Lightning (logs: ${LOG_FILE})…`);
  mkdirSync(resolve(root, 'tmp'), { recursive: true });
  rmSync(LOG_FILE, { force: true });
  const log = openSync(LOG_FILE, 'a');
  // Detached = its own process group, so `down` can kill mix and the BEAM it
  // spawns in one signal, and the harness can exit while Lightning keeps going.
  const child = spawn('mix', ['phx.server'], {
    cwd: source.dir,
    env: lightningEnv(),
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();

  writeFileSync(
    STATE_FILE,
    JSON.stringify({ pid: child.pid, dir: source.dir, port: PORT }, null, 2),
  );

  await waitForHealth(child.pid!);
  console.log(`[harness] Lightning up at ${BASE_URL} (${source.label})`);
}

export async function down(): Promise<void> {
  if (!existsSync(STATE_FILE)) {
    console.log('[harness] nothing to stop (no tmp/harness-state.json — was `up` run?)');
    return;
  }
  const { pid, dir } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { pid: number; dir: string };

  console.log(`[harness] stopping Lightning (pid ${pid})…`);
  signal(pid, 'SIGTERM');
  for (let i = 0; i < 10 && alive(pid); i++) await sleep(500);
  if (alive(pid)) {
    console.log('[harness] still up after SIGTERM — killing.');
    signal(pid, 'SIGKILL');
  }

  // Drop the harness database so nothing bleeds over into the next run
  // (`up` recreates and migrates it). Best-effort: the checkout may be gone.
  if (existsSync(dir)) {
    console.log('[harness] dropping the harness database…');
    try {
      mix(dir, 'ecto.drop', '--quiet');
    } catch {
      console.log('[harness] could not drop the database (continuing).');
    }
  }

  rmSync(STATE_FILE, { force: true });
  console.log('[harness] stopped.');
}

/** Signal the whole detached process group (mix + the BEAM under it). */
function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // Already gone.
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll /health_check until 200; fail fast if the server process dies. */
async function waitForHealth(pid: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health_check`);
      if (res.ok) return;
    } catch {
      // Not accepting connections yet (first boot compiles before serving).
    }
    if (!alive(pid)) {
      throw new Error(`Lightning exited during boot. Log tail:\n${logTail()}`);
    }
    await sleep(1_000);
  }
  throw new Error(`Lightning not healthy after ${HEALTH_TIMEOUT_MS}ms. Log tail:\n${logTail()}`);
}

function logTail(lines = 40): string {
  try {
    return readFileSync(LOG_FILE, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log file)';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
