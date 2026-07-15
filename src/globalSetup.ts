import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildWebhookPassthrough } from './fixtures.js';
import { MANIFEST_PATH, type Manifest } from './manifest.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const LIGHTNING_BIN = process.env.LIGHTNING_BIN ?? '/app/bin/lightning';
const BASE_URL = process.env.HARNESS_BASE_URL ?? 'http://127.0.0.1:4000';

function compose(args: string[]): void {
  execFileSync('docker', ['compose', ...args], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
}

interface Seed {
  api_token: string;
  user_id: string;
}

/** rpc the minimal seed into the live web node; returns the token + user id. */
function seed(): Seed {
  const code = readFileSync(resolve(root, 'scripts', 'seed.exs'), 'utf8');
  compose(['exec', '-T', 'web', LIGHTNING_BIN, 'rpc', code]);

  const seedPath = resolve(root, 'tmp', 'seed.json');
  if (!existsSync(seedPath)) throw new Error('Seed did not produce tmp/seed.json');
  return JSON.parse(readFileSync(seedPath, 'utf8')) as Seed;
}

/** Create the workflow via the public provisioning API and write the manifest. */
async function provision({ api_token, user_id }: Seed): Promise<void> {
  const { spec, ref } = buildWebhookPassthrough(user_id);

  const res = await fetch(`${BASE_URL}/api/provision`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${api_token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(spec),
  });
  if (!res.ok) {
    throw new Error(`POST /api/provision returned ${res.status}: ${await res.text()}`);
  }

  const manifest: Manifest = { api_token, workflows: [ref] };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest));
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

  console.log('[harness] seeding superuser + token…');
  const s = seed();

  console.log('[harness] provisioning workflow via /api/provision…');
  await provision(s);

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
