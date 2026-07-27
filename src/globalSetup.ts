import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const LIGHTNING_BIN = process.env.LIGHTNING_BIN ?? '/app/bin/lightning';
const SCENARIO = process.env.SCENARIO ?? 'webhook-passthrough';

function compose(args: string[]): void {
  execFileSync('docker', ['compose', ...args], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}

/**
 * Provision via Lightning's own Lightning.Bootstrap, rpc'd into the live web
 * node. Reads a declarative scenario, and Bootstrap returns a manifest (ids,
 * api token, webhook paths) which lands on the ./tmp mount as manifest.json.
 */
function bootstrap(): void {
  const scenarioPath = resolve(root, 'scenarios', `${SCENARIO}.json`);
  const scenarioB64 = readFileSync(scenarioPath).toString('base64');

  const code = readFileSync(resolve(root, 'scripts', 'bootstrap.exs'), 'utf8').replaceAll(
    '__SCENARIO_B64__',
    scenarioB64,
  );

  compose(['exec', '-T', 'web', LIGHTNING_BIN, 'rpc', code]);

  if (!existsSync(resolve(root, 'tmp', 'manifest.json'))) {
    throw new Error('Bootstrap did not produce tmp/manifest.json (is ALLOW_BOOTSTRAP=true and does the image include Lightning.Bootstrap?)');
  }
}

export async function setup(): Promise<void> {
  if (!existsSync(resolve(root, '.env'))) {
    throw new Error('Missing .env — run `cp .env.example .env` or `./bin/gen-secrets.sh` first.');
  }

  if (process.env.HARNESS_BUILD) {
    // Build from local source (docker-compose.*-src.yml overlays via COMPOSE_FILE).
    console.log('[harness] building images from source…');
    compose(['build']);
  } else {
    console.log('[harness] pulling images (best effort)…');
    try {
      compose(['pull', '--quiet']);
    } catch {
      // Local-only tags may not be pullable; carry on with what's present.
    }
  }

  console.log('[harness] starting postgres…');
  compose(['up', '-d', '--wait', 'postgres']);

  console.log('[harness] running migrations…');
  // Idempotent; harmless if the image also migrates on boot.
  compose(['run', '--rm', '--no-deps', '-T', 'web', LIGHTNING_BIN, 'eval', 'Lightning.Release.migrate()']);

  console.log('[harness] starting web + worker…');
  compose(['up', '-d', '--wait', 'web', 'worker']);

  console.log(`[harness] bootstrapping scenario "${SCENARIO}"…`);
  bootstrap();

  console.log('[harness] ready.');
}

export async function teardown(): Promise<void> {
  if (process.env.KEEP_STACK) {
    console.log('[harness] KEEP_STACK set — leaving the stack up.');
    return;
  }
  console.log('[harness] tearing the stack down…');
  compose(['down', '-v']);
}
