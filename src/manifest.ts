import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = resolve(here, '..', 'tmp', 'manifest.json');

/** Shape emitted by Lightning.Bootstrap.manifest/1 (JSON-encoded). */
export interface ManifestUser {
  email: string;
  id: string;
  superuser: boolean;
  api_token: string | null;
}

export interface ManifestTrigger {
  id: string;
  type: string;
  webhook_path: string | null;
}

export interface ManifestWorkflow {
  id: string;
  name: string;
  trigger: ManifestTrigger | null;
  jobs: { id: string; name: string }[];
}

export interface ManifestProject {
  id: string;
  name: string;
  workflows: ManifestWorkflow[];
}

export interface Manifest {
  users: ManifestUser[];
  projects: ManifestProject[];
}

/** Read the manifest written by scripts/bootstrap.exs during globalSetup. */
export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
}

/** The API token to drive the instance with (first user that has one). */
export function apiToken(manifest: Manifest): string {
  const user = manifest.users.find(u => u.api_token);
  if (!user?.api_token) {
    throw new Error('No user with an api_token in the manifest (set api_token: true in the scenario)');
  }
  return user.api_token;
}

/** Find a workflow by name across all projects. */
export function workflow(manifest: Manifest, name: string): ManifestWorkflow {
  const all = manifest.projects.flatMap(p => p.workflows);
  const found = all.find(w => w.name === name);
  if (!found) {
    throw new Error(`No workflow "${name}" in manifest. Available: ${all.map(w => w.name).join(', ')}`);
  }
  return found;
}
