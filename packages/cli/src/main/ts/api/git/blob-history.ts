import { textLineCount } from '@repometry/core/internal/model/snapshot.js';

export interface BlobRequest {
  readonly id: string;
  readonly estimatedBytes: number;
  readonly contents: boolean;
}

interface BlobFacts {
  readonly lines: number | null;
  readonly bytes?: Buffer;
}

type ReadBlobs = (ids: readonly string[]) => Promise<ReadonlyMap<string, Buffer>>;

export const gitBlobBatchBytes = 64 * 1024 * 1024;

/** Keeps only inventory facts and requested bytes from the preceding snapshot. */
export class GitBlobHistory {
  private previous = new Map<string, BlobFacts>();

  constructor(private readonly maxBatchBytes = gitBlobBatchBytes) {}

  async read(requests: readonly BlobRequest[], read: ReadBlobs): Promise<ReadonlyMap<string, BlobFacts>> {
    const current = new Map<string, BlobFacts>();
    const missing = this.missingRequests(requests, current);
    for (const batch of blobBatches(missing, this.maxBatchBytes)) await readBatch(batch, read, current);
    this.previous = current;
    return current;
  }

  private missingRequests(requests: readonly BlobRequest[], current: Map<string, BlobFacts>): BlobRequest[] {
    const missing: BlobRequest[] = [];
    for (const request of requests) {
      const facts = this.previous.get(request.id);
      if (!facts || (request.contents && facts.bytes === undefined)) missing.push(request);
      else current.set(request.id, request.contents ? facts : { lines: facts.lines });
    }
    return missing;
  }
}

async function readBatch(requests: readonly BlobRequest[], read: ReadBlobs, current: Map<string, BlobFacts>): Promise<void> {
  const blobs = await read(requests.map(({ id }) => id));
  for (const { id, contents } of requests) {
    const bytes = blobs.get(id);
    if (!bytes) throw new Error(`Git blob unavailable: ${id}`);
    current.set(id, { lines: textLineCount(bytes), ...(contents ? { bytes: Buffer.from(bytes) } : {}) });
  }
}

function* blobBatches(requests: readonly BlobRequest[], maxBytes: number): Generator<readonly BlobRequest[]> {
  let batch: BlobRequest[] = [];
  let estimatedBytes = 0;
  for (const request of requests) {
    if (batch.length && estimatedBytes + request.estimatedBytes > maxBytes) {
      yield batch;
      batch = [];
      estimatedBytes = 0;
    }
    batch.push(request);
    estimatedBytes += request.estimatedBytes;
  }
  if (batch.length) yield batch;
}
