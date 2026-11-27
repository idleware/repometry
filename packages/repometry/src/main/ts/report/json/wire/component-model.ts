export interface Component {
  readonly name: string;
  readonly pathGlobs: readonly string[];
  readonly description?: string;
}

export interface ComponentMetrics {
  readonly component: Component;
  readonly paths: readonly string[];
}
