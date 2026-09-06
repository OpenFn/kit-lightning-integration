/**
 * CI niceties that are no-ops everywhere else.
 *
 * GitHub Actions renders anything appended to $GITHUB_STEP_SUMMARY on the run's
 * summary page. We put failure explanations there — a run's log tail, a
 * toolchain mismatch — so a reviewer learns *why* without downloading the log
 * artifact.
 */

import { appendFileSync } from 'node:fs';

/** Append a titled, preformatted block to the job summary (if we're in Actions). */
export function stepSummary(title: string, body: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, `### ${title}\n\n\`\`\`\n${body}\n\`\`\`\n\n`);
  } catch {
    // Never let reporting break the run.
  }
}
