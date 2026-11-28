import { createRepometry } from './runtime.js';

const { inspect, measureDiffCoverage, review } = createRepometry();
export { inspect, measureDiffCoverage, review };
export type { InspectRequest, DiffCoverageRequest, ReviewRequest } from './runtime.js';

export { reviewExitCode } from './compose/review.js';
export type { DiffCoveragePorts, DiffCoverageSource } from '@repometry/core/internal/usecases/diff-coverage.js';
export type { ReviewOptions } from '@repometry/core/internal/usecases/review.js';
export type { FindingInput } from './api/import/finding-import.js';
export type { FindingIgnoreRule as IgnoreEntry } from '@repometry/core/internal/model/ignore-rule.js';
