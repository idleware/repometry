import { gitText } from '../api/git/git.js';
import { readCoverageFiles } from '../api/import/lcov-files.js';
import type { CoverageInputs } from '../api/import/lcov-files.js';
import type { SourceSnapshot } from '../core/model/source.js';

export function readInspectionCoverage(inputs: CoverageInputs, { root, snapshot }: { root: string; snapshot: SourceSnapshot }) {
  const { subject } = snapshot;
  const readCommittedManifest = subject.kind === 'commit'
    ? (path: string) => gitText(root, ['cat-file', 'blob', `${subject.id}:${path}`]) : undefined;
  return readCoverageFiles(inputs, { root, snapshot, readCommittedManifest });
}
