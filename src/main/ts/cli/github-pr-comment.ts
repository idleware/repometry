import { pathToFileURL } from 'node:url';
import { publishPullCoverageComment } from '../api/gh/github-pr-comment.js';

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const outcome = await publishPullCoverageComment(process.env);
    process.stdout.write(`Repometry PR coverage comment: ${outcome}\n`);
  } catch (error) {
    process.stderr.write(`repometry: ${error instanceof Error ? error.message : 'PR coverage comment failed'}\n`);
    process.exitCode = 1;
  }
}
