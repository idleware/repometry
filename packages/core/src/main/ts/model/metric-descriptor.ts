export type MetricScope = 'repository' | 'file' | 'function';

export interface MetricDescriptor {
  readonly id: string;
  readonly label: string;
  readonly short?: string;
  readonly description?: string;
  readonly unit: 'count' | 'ratio' | 'minutes';
  readonly scope: MetricScope;
  readonly aggregate: 'sum' | 'max' | 'none';
  readonly ratio?: { readonly of: string; readonly over: string };
  readonly better: 'lower' | 'higher' | 'none';
  readonly bands?: readonly [number, number, number, number];
  readonly group?: string;
}
