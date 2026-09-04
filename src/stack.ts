/**
 * Boots and stops the stack as local processes, the same way Lightning and
 * kit developers run them.
 *
 * Lightning: prepare the checkout (deps, assets, db create + migrate), run
 * `mix phx.server` detached, wait for /health_check.
 *
 * Worker: from a kit checkout (pnpm install + build, run dist/start.js) or a
 * published @openfn/ws-worker version (npx); wait for its /livez. It connects
 * to Lightning's /worker channel with the dev-mode WORKER_SECRET, exactly as
 * Lightning's own RuntimeManager would (RTM stays off so the worker under test
 * is always ours).
 *
 * PIDs land in tmp/harness-state.json so `down` can stop everything.
 *
 * Host prerequisites: Elixir/Erlang matching Lightning's .tool-versions (asdf
 * picks them up), node, pnpm (for kit checkouts), Rust on ARM (rambo), and a
 * postgres reachable at DATABASE_URL.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type { CheckoutSource, WorkerSource } from './source.js';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PORT = process.env.PORT ?? '4003';
export const BASE_URL = `http://localhost:${PORT}`;
export const WORKER_PORT = process.env.WORKER_PORT ?? '2222';
// A database of our own: never the dev DB, and not shared with Lightning's
// bin/e2e either — harness runs can't touch anyone else's data.
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost/lightning_integration_e2e';
const HEALTH_TIMEOUT_MS = Number(process.env.HARNESS_BOOT_TIMEOUT_MS ?? 600_000);

// Shared secret for the /worker channel, pinned on BOTH processes: a checkout
// may carry a .env that overrides Lightning's dev default, so relying on
// config/dev.exs alone can desync the two sides (system env wins over .env).
// The default is Lightning's dev-mode value — test-only, not a real credential.
const WORKER_SECRET =
  process.env.WORKER_SECRET ?? 'ZOr2sjacHZnql7WYETL2x61d6RDdecnyLWieoG+bX6Q=';

export const STATE_FILE = resolve(root, 'tmp', 'harness-state.json');
const LIGHTNING_LOG = resolve(root, 'tmp', 'lightning.log');
const WORKER_LOG = resolve(root, 'tmp', 'worker.log');

export interface State {
  lightning?: { pid: number; dir: string };
  worker?: { pid: number; label: string };
  port: string;
}

/** Env for every command we run inside the Lightning checkout. */
function lightningEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MIX_ENV: 'dev',
    PORT,
    DATABASE_URL,
    WORKER_SECRET,
    // Lightning must NOT spawn its own worker — the harness controls which
    // worker connects, so the worker under test is always an explicit choice.
    RTM: 'false',
    // Defaults on in dev and binds its own port (4007) — a collision with any
    // other Lightning on the machine takes the whole VM down mid-run.
    LIVE_DEBUGGER: 'false',
  };
}

function run(dir: string, env: NodeJS.ProcessEnv, cmd: string, ...args: string[]): void {
  execFileSync(cmd, args, { cwd: dir, stdio: 'inherit', env });
}

export function mix(dir: string, ...args: string[]): void {
  run(dir, lightningEnv(), 'mix', ...args);
}

export async function up(lightning: CheckoutSource, worker: WorkerSource): Promise<void> {
  // A leftover instance would answer our health checks and poison the run.
  for (const port of [PORT, WORKER_PORT]) {
    if (listeners(port).length > 0) {
      throw new Error(`Port ${port} is already in use — run \`bun run stack down\` (or stop whatever is listening) first`);
    }
  }

  mkdirSync(resolve(root, 'tmp'), { recursive: true });
  const state: State = { port: PORT };

  await upLightning(lightning, state);
  await upWorker(worker, state);
}

async function upLightning(source: CheckoutSource, state: State): Promise<void> {
  // Same sequence as Lightning's own bin/bootstrap; everything is idempotent
  // and cached, so re-runs on a warm checkout are quick.
  console.log(`[harness] preparing ${source.label}…`);
  mix(source.dir, 'deps.get');
  run(source.dir, lightningEnv(), 'npm', 'install', '--prefix', 'assets');
  mix(source.dir, 'assets.setup');
  if (process.arch === 'arm64') {
    // rambo ships no arm64 binary — build it from source (needs Rust, the same
    // prerequisite Lightning's own bin/bootstrap enforces on Apple Silicon).
    mix(source.dir, 'compile.rambo');
  }
  mix(source.dir, 'lightning.install_runtime');
  mix(source.dir, 'ecto.create', '--quiet');
  mix(source.dir, 'ecto.migrate', '--quiet');

  console.log(`[harness] starting Lightning (logs: ${LIGHTNING_LOG})…`);
  const pid = launch('mix', ['phx.server'], source.dir, lightningEnv(), LIGHTNING_LOG);
  state.lightning = { pid, dir: source.dir };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  await waitFor('Lightning', `${BASE_URL}/health_check`, pid, LIGHTNING_LOG);
  console.log(`[harness] Lightning up at ${BASE_URL} (${source.label})`);
}

async function upWorker(source: WorkerSource, state: State): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WORKER_SECRET,
    WORKER_PORT,
  };
  const args = ['--lightning', `ws://localhost:${PORT}/worker`, '--log', 'info'];

  let pid: number;
  if (source.kind === 'npm') {
    console.log(`[harness] starting ${source.label} (logs: ${WORKER_LOG})…`);
    pid = launch('npx', ['-y', `@openfn/ws-worker@${source.version}`, ...args], root, env, WORKER_LOG);
  } else {
    const entry = resolve(source.dir, 'packages', 'ws-worker', 'dist', 'start.js');
    // Local checkouts are the dev's to build (rebuild only if dist is missing);
    // .cache clones always rebuild, since dist may be stale from another ref.
    if (!source.local || !existsSync(entry)) {
      console.log(`[harness] building ${source.label}…`);
      run(source.dir, env, 'pnpm', 'install');
      run(source.dir, env, 'pnpm', 'run', 'build');
    }
    console.log(`[harness] starting ${source.label} (logs: ${WORKER_LOG})…`);
    pid = launch('node', [entry, ...args], source.dir, env, WORKER_LOG);
  }

  state.worker = { pid, label: source.label };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  await waitFor('worker', `http://localhost:${WORKER_PORT}/livez`, pid, WORKER_LOG);
  console.log(`[harness] worker up on :${WORKER_PORT} (${source.label})`);
}

export async function down(): Promise<void> {
  if (!existsSync(STATE_FILE)) {
    console.log('[harness] nothing to stop (no tmp/harness-state.json — was `up` run?)');
    return;
  }
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;

  for (const [name, proc] of [['worker', state.worker], ['Lightning', state.lightning]] as const) {
    if (!proc) continue;
    console.log(`[harness] stopping ${name} (pid ${proc.pid})…`);
    signal(proc.pid, 'SIGTERM');
    for (let i = 0; i < 10 && alive(proc.pid); i++) await sleep(500);
    if (alive(proc.pid)) {
      console.log(`[harness] ${name} still up after SIGTERM — killing.`);
      signal(proc.pid, 'SIGKILL');
    }
  }

  // The BEAM detaches into its own process group, so the group-kill above can
  // miss it — sweep anything still listening on our ports.
  for (const port of [WORKER_PORT, state.port ?? PORT]) {
    for (const pid of listeners(port)) {
      console.log(`[harness] killing leftover listener on :${port} (pid ${pid})…`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  // Drop the harness database so nothing bleeds over into the next run
  // (`up` recreates and migrates it). Best-effort: the checkout may be gone.
  const dir = state.lightning?.dir;
  if (dir && existsSync(dir)) {
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

/** Spawn detached (own process group) with output to a log file. */
function launch(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logFile: string,
): number {
  rmSync(logFile, { force: true });
  const log = openSync(logFile, 'a');
  const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  return child.pid!;
}

/** Signal a detached process group (the launcher and everything under it). */
function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
  } catch {
    // Already gone.
  }
}

/** PIDs listening on a local TCP port (macOS + linux via lsof). */
function listeners(port: string): number[] {
  try {
    return execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    // lsof exits 1 when nothing matches.
    return [];
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll a health URL until 200; fail fast if the process dies. */
async function waitFor(name: string, url: string, pid: number, logFile: string): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not accepting connections yet.
    }
    if (!alive(pid)) {
      throw new Error(`${name} exited during boot. Log tail:\n${logTail(logFile)}`);
    }
    await sleep(1_000);
  }
  throw new Error(`${name} not healthy after ${HEALTH_TIMEOUT_MS}ms. Log tail:\n${logTail(logFile)}`);
}

function logTail(logFile: string, lines = 40): string {
  try {
    return readFileSync(logFile, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log file)';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
