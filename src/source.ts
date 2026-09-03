/**
 * Resolves `--lightning` / `--worker` specs into something runnable.
 *
 * Spec grammar (both sides):
 *   /path/to/checkout           existing local checkout, used as-is
 *   main                        branch/tag/full SHA on the default repo
 *   owner/repo#ref              branch/tag/full SHA on any GitHub repo (forks)
 * The worker additionally accepts an npm version (e.g. 1.14.1, latest), since
 * @openfn/ws-worker is published — no checkout needed.
 *
 * Remote refs are fetched shallowly into .cache/ — GitHub allows fetching
 * arbitrary full SHAs, so branches, tags and commits all take one path.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CheckoutSource {
  /** Absolute path of the checkout. */
  dir: string;
  /** Resolved commit SHA (undefined for local paths — whatever's checked out). */
  sha?: string;
  /** Human-readable description for logs. */
  label: string;
  /** True when this is a user-managed local checkout (not our .cache clone). */
  local: boolean;
}

export type WorkerSource =
  | ({ kind: 'checkout' } & CheckoutSource)
  | { kind: 'npm'; version: string; label: string };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface RepoOptions {
  /** Default owner/repo when the spec is a bare ref. */
  repo: string;
  /** Cache directory name under .cache/. */
  cache: string;
  /** A file that must exist in a valid checkout (sanity check for local paths). */
  sanityFile: string;
}

function resolveRepoSource(spec: string, root: string, opts: RepoOptions): CheckoutSource {
  // A local checkout: anything that exists on disk as a directory.
  const asPath = resolve(root, spec);
  if (existsSync(asPath)) {
    if (!existsSync(resolve(asPath, opts.sanityFile))) {
      throw new Error(`${asPath} exists but doesn't look like a ${opts.repo} checkout (no ${opts.sanityFile})`);
    }
    return { dir: asPath, label: `local checkout ${asPath}`, local: true };
  }

  // A GitHub ref: [owner/repo#]ref
  const match = spec.match(/^(?:([\w.-]+\/[\w.-]+)#)?([\w./-]+)$/);
  const ref = match?.[2];
  if (!ref) {
    throw new Error(`Can't parse spec "${spec}" — expected a local path, a ref, or owner/repo#ref`);
  }
  const repo = match[1] ?? opts.repo;
  const url = `https://github.com/${repo}.git`;

  // git can fetch a branch, tag, or FULL commit SHA — but not an abbreviation.
  if (/^[0-9a-f]{4,39}$/.test(ref)) {
    throw new Error(`"${ref}" looks like an abbreviated SHA — git can only fetch full 40-character SHAs (or branch/tag names)`);
  }

  const dir = resolve(root, '.cache', opts.cache);
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
  return { dir, sha, label: `${repo}@${ref} (${sha.slice(0, 9)})`, local: false };
}

export function resolveLightningSource(spec: string, root: string): CheckoutSource {
  return resolveRepoSource(spec, root, {
    repo: 'OpenFn/lightning',
    cache: 'lightning',
    sanityFile: 'mix.exs',
  });
}

export function resolveWorkerSource(spec: string, root: string): WorkerSource {
  // Published @openfn/ws-worker: a semver version or npm dist-tag.
  if (/^(\d+\.\d+\.\d+(-[\w.]+)?|latest|next)$/.test(spec)) {
    return { kind: 'npm', version: spec, label: `@openfn/ws-worker@${spec}` };
  }
  // Otherwise a kit checkout: local path or GitHub ref.
  const checkout = resolveRepoSource(spec, root, {
    repo: 'OpenFn/kit',
    cache: 'kit',
    sanityFile: 'packages/ws-worker/package.json',
  });
  return { kind: 'checkout', ...checkout };
}
