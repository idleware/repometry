import { parseConfig } from './config.js';
import { inspectCommits, rangeInspector } from './range-inspection.js';
import type { CommitOutcome, RangeMessage } from './range-inspection.js';

let stopped = false;
let started = false;
const stop = () => { stopped = true; };
process.on('SIGINT', stop);
process.on('disconnect', stop);
process.on('message', (message: RangeMessage) => {
  if (message.kind === 'stop') stop();
  else if (!started) {
    started = true;
    void run(message);
  }
});

async function run({ commits, inspection, config }: Extract<RangeMessage, { kind: 'start' }>): Promise<void> {
  try {
    await inspectCommits(commits, rangeInspector(inspection, parseConfig(config)), () => stopped, send);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect!();
  }
}

function send(outcome: CommitOutcome): Promise<void> {
  if (!process.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    process.send!(outcome, error => error ? reject(error) : resolve());
  });
}
