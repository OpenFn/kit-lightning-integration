/**
 * Resolves a `--lightning <spec>` into a local docker build context.
 *
 * Spec grammar:
 *   /path/to/lightning          existing local checkout, used as-is
 *   main                        branch/tag/SHA on OpenFn/lightning
 *   owner/repo#ref              branch/tag/SHA on any GitHub repo (forks)
 *
 * Remote refs are fetched shallowly into .cache/lightning/ — GitHub allows
 * fetching arbitrary SHAs, so branches, tags and commits all take one path.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LightningSource {
  /** Absolute path to use as the docker build context. */
  dir: string;
  /** Resolved commit SHA (undefined for local paths — whatever's checked out). */
  sha?: string;
  /** Human-readable description for logs. */
  label: string;
}

const DEFAULT_REPO = 'OpenFn/lightning';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function resolveLightningSource(spec: string, root: string): LightningSource {
  // A local checkout: anything that exists on disk as a directory.
  const asPath = resolve(root, spec);
  if (existsSync(asPath)) {
    if (!existsSync(resolve(asPath, 'mix.exs'))) {
      throw new Error(`${asPath} exists but doesn't look like a Lightning checkout (no mix.exs)`);
    }
    return { dir: asPath, label: `local checkout ${asPath}` };
  }

  // A GitHub ref: [owner/repo#]ref
  const match = spec.match(/^(?:([\w.-]+\/[\w.-]+)#)?([\w./-]+)$/);
  const ref = match?.[2];
  if (!ref) {
    throw new Error(`Can't parse Lightning spec "${spec}" — expected a local path, a ref, or owner/repo#ref`);
  }
  const repo = match[1] ?? DEFAULT_REPO;
  const url = `https://github.com/${repo}.git`;

  // git can fetch a branch, tag, or FULL commit SHA — but not an abbreviation.
  if (/^[0-9a-f]{4,39}$/.test(ref)) {
    throw new Error(`"${ref}" looks like an abbreviated SHA — git can only fetch full 40-character SHAs (or branch/tag names)`);
  }

  const dir = resolve(root, '.cache', 'lightning');
  mkdirSync(dir, { recursive: true });
  if (!existsSync(resolve(dir, '.git'))) git(dir, 'init', '--quiet');

  console.log(`[harness] fetching ${repo}@${ref}…`);
  try {
    git(dir, 'fetch', '--depth', '1', '--quiet', url, ref);
  } catch {
    throw new Error(`Couldn't fetch "${ref}" from ${url} — check the branch/tag/SHA exists (and that the repo is public)`);
  }
  git(dir, 'checkout', '--force', '--quiet', 'FETCH_HEAD');
  git(dir, 'clean', '-fdq');

  const sha = git(dir, 'rev-parse', 'HEAD');
  return { dir, sha, label: `${repo}@${ref} (${sha.slice(0, 9)})` };
}
