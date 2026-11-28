import type * as api from '@repometry/cli';
import { createRepometry } from '@repometry/cli/internal/api';
import distribution from './distribution.js';

const configured = createRepometry(distribution);
const inspect: typeof api.inspect = configured.inspect;
const measureDiffCoverage: typeof api.measureDiffCoverage = configured.measureDiffCoverage;
const review: typeof api.review = configured.review;

export { inspect, measureDiffCoverage, review };
export { reviewExitCode } from '@repometry/cli';
export type { DiffCoveragePorts, DiffCoverageRequest, DiffCoverageSource, FindingInput, IgnoreEntry, InspectRequest,
  ReviewOptions, ReviewRequest } from '@repometry/cli';
