/**
 * The manifest a Kickstart scenario produces: record ids, API tokens and
 * webhook paths for the data it seeded. `seedScenario()` returns one; these
 * types and helpers are how tests read it.
 */

/** Shape of the JSON manifest written by `mix lightning.kickstart --manifest`. */
export interface ManifestUser {
  email: string;
  id: string;
  superuser: boolean;
  api_token: string | null;
}

export interface ManifestTrigger {
  id: string;
  type: string;
  /** e.g. "/i/<trigger-id>" for webhook triggers, null otherwise. */
  webhook_path: string | null;
}

export interface ManifestWorkflow {
  id: string;
  name: string;
  triggers: ManifestTrigger[];
  jobs: { id: string; name: string }[];
}

export interface ManifestProject {
  id: string;
  name: string;
  credentials: { name: string; project_credential_id: string }[];
  workflows: ManifestWorkflow[];
}

export interface Manifest {
  users: ManifestUser[];
  credentials: { name: string; id: string; owner_id: string }[];
  projects: ManifestProject[];
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

/** The webhook path of a workflow's webhook trigger. */
export function webhookPath(wf: ManifestWorkflow): string {
  const trigger = wf.triggers.find(t => t.webhook_path);
  if (!trigger?.webhook_path) {
    throw new Error(`Workflow "${wf.name}" has no webhook trigger`);
  }
  return trigger.webhook_path;
}
