/**
 * Preflight: does the host's Erlang/Elixir match what the Lightning checkout
 * pins in `.tool-versions`?
 *
 * Without this, a version gap surfaces as `mix deps.get` dying with exit 126
 * (asdf refusing to pick a binary) or as a compile explosion against the
 * wrong OTP — neither says "install Erlang 28.5". This does.
 *
 * Erlang and Elixir are hard requirements. Node is advisory: Lightning's
 * assets and runtime tolerate a major-version skew (v22 vs the pinned v24
 * works fine), so a mismatch there only warns.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { stepSummary } from './ci.js';

export interface ToolVersions {
  erlang?: string;
  /** e.g. `1.18.4-otp-28` — the `-otp-N` suffix names the OTP it was built for. */
  elixir?: string;
  nodejs?: string;
}

/** Parse asdf's `.tool-versions` (`<tool> <version>` per line). Missing file → {}. */
export function readToolVersions(dir: string): ToolVersions {
  const file = resolve(dir, '.tool-versions');
  if (!existsSync(file)) return {};
  const pins: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [tool, version] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (tool && version) pins[tool] = version;
  }
  return pins;
}

/**
 * Run a command from inside the checkout — that's where asdf resolves shims
 * from `.tool-versions`. Returns stdout, or the failure text when it can't run.
 */
function probe(dir: string, cmd: string, args: string[]): { ok: true; out: string } | { ok: false; error: string } {
  try {
    const out = execFileSync(cmd, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: out.trim() };
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, error: (err.stderr ?? err.message).trim() };
  }
}

// `erlang:system_info(otp_release)` is only the major ("28"); the full version
// lives in the release's OTP_VERSION file.
const OTP_VERSION_EVAL =
  'F = filename:join([code:root_dir(), "releases", erlang:system_info(otp_release), "OTP_VERSION"]),' +
  '{ok, B} = file:read_file(F), io:format("~s", [string:trim(B)]), halt().';

/**
 * Throws (with an actionable message) when the host's Erlang or Elixir don't
 * match the checkout's pins; warns on a node major mismatch.
 */
export function checkToolchain(dir: string, label: string): void {
  const pins = readToolVersions(dir);
  const problems: string[] = [];

  if (pins.erlang) {
    const erl = probe(dir, 'erl', ['-noshell', '-eval', OTP_VERSION_EVAL]);
    if (!erl.ok) {
      problems.push(`erlang ${pins.erlang} pinned, but \`erl\` won't run here:\n    ${erl.error.split('\n').join('\n    ')}`);
    } else if (erl.out !== pins.erlang) {
      problems.push(`erlang ${pins.erlang} pinned, but \`erl\` here is ${erl.out}`);
    }
  }

  if (pins.elixir) {
    // "1.18.4-otp-28" → version 1.18.4 built for OTP 28.
    const [wantVersion, wantOtp] = pins.elixir.split('-otp-');
    const elixir = probe(dir, 'elixir', ['--version']);
    const match = elixir.ok ? elixir.out.match(/Elixir (\S+) \(compiled with Erlang\/OTP (\d+)\)/) : null;
    if (!elixir.ok) {
      problems.push(`elixir ${pins.elixir} pinned, but \`elixir\` won't run here:\n    ${elixir.error.split('\n').join('\n    ')}`);
    } else if (!match) {
      problems.push(`elixir ${pins.elixir} pinned, but couldn't read the version from: ${elixir.out}`);
    } else if (match[1] !== wantVersion || (wantOtp && match[2] !== wantOtp)) {
      problems.push(`elixir ${pins.elixir} pinned, but \`elixir\` here is ${match[1]} (compiled for OTP ${match[2]})`);
    }
  }

  if (pins.nodejs) {
    const node = probe(dir, 'node', ['--version']);
    const have = node.ok ? node.out.replace(/^v/, '') : undefined;
    if (have && have.split('.')[0] !== pins.nodejs.split('.')[0]) {
      console.warn(`[harness] note: ${label} pins nodejs ${pins.nodejs}; using ${have} (usually fine)`);
    }
  }

  if (problems.length === 0) return;

  const message =
    `${label} pins a toolchain (.tool-versions) this host doesn't provide:\n` +
    problems.map(p => `  - ${p}`).join('\n') +
    `\n\nFix: \`asdf install\` inside ${dir} (or asdf install erlang/elixir <version>).` +
    `\nIn CI, use erlef/setup-beam with \`version-file: <checkout>/.tool-versions\` and \`version-type: strict\`.`;
  stepSummary(`Toolchain mismatch for ${label}`, message);
  throw new Error(message);
}
