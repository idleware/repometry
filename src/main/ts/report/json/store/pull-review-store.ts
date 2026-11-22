import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import metricCatalog from '../../../../resources/report/json/metric-catalog-v1.schema.json' with { type: 'json' };
import comparison from '../../../../resources/report/json/comparison-v1.schema.json' with { type: 'json' };
import diffCoverage from '../../../../resources/report/json/diff-coverage-v1.schema.json' with { type: 'json' };
import inspection from '../../../../resources/report/json/report-v1.schema.json' with { type: 'json' };
import currentInspection from '../../../../resources/report/json/report-v2.schema.json' with { type: 'json' };
import schema from '../../../../resources/report/json/pull-review-v1.schema.json' with { type: 'json' };
import type { PullReview } from '../wire/pull-review-model.js';

const ajv = new Ajv2020({ schemas: [metricCatalog, inspection, currentInspection, comparison, diffCoverage] });
const validate = ajv.compile<PullReview>(schema);

export async function savePullReview(output: string, review: PullReview): Promise<void> {
  if (!validate(review)) throw new Error(`Invalid pull request review: ${ajv.errorsText(validate.errors)}`);
  if (review.number === null) throw new Error('Saving a pull request review requires its number');
  const directory = join(output, 'reviews');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory()) throw new Error('Expected a directory for PR reviews');

  const temporary = join(directory, `.review-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(review, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(directory, `${review.number}.json`));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function listPullReviews(output: string): Promise<readonly PullReview[]> {
  const directory = join(output, 'reviews');
  try {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Expected a directory for PR reviews');
    const files = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && /^[1-9]\d*\.json$/.test(entry.name));
    const reviews = await Promise.all(files.map(async ({ name }) => {
      const value: unknown = JSON.parse(await readFile(join(directory, name), 'utf8'));
      if (!validate(value) || `${value.number}.json` !== name || !Number.isFinite(Date.parse(value.generatedAt))) {
        throw new Error(`Invalid pull request review: ${name}`);
      }
      return value;
    }));
    return reviews.sort((left, right) => right.generatedAt.localeCompare(left.generatedAt) || (right.number ?? 0) - (left.number ?? 0));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}
