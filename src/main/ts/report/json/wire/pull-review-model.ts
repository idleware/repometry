import type { PullReview } from '../../../core/model/pull-review.js';
export type { PullReview } from '../../../core/model/pull-review.js';

export const pullReviewsSchema = 'urn:repometry:schema:pull-reviews:1';

export interface PullReviews {
  readonly schema: typeof pullReviewsSchema;
  readonly reviews: readonly PullReview[];
}
