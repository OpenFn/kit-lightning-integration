import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = resolve(here, '..', 'tmp', 'manifest.json');

export interface WorkflowRef {
  name: string;
  project_id: string;
  workflow_id: string;
  trigger_id: string | null;
  webhook_path: string | null;
}

export interface Manifest {
  api_token: string;
  workflows: WorkflowRef[];
}

/** Read the manifest written by scripts/provision.exs during globalSetup. */
export function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
}

export function workflow(manifest: Manifest, name: string): WorkflowRef {
  const found = manifest.workflows.find(w => w.name === name);
  if (!found) {
    const available = manifest.workflows.map(w => w.name).join(', ');
    throw new Error(`No workflow "${name}" in manifest. Available: ${available}`);
  }
  return found;
}
