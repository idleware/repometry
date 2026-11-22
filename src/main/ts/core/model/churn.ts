export const churnSettings = {
  method: 'first-parent-path-touches/v1',
  lookbackDays: 90,
  maxCommits: 512,
} as const;

export interface ChurnWindow {
  readonly endingAt: string;
  readonly commits: number;
  readonly shallow: boolean;
  readonly capReached: boolean;
}
