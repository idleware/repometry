export interface SourceLocator {
  readonly provider: string;
  /** A fetch URL with {revision} and either {path} or {path:component}. */
  readonly url: string;
  /** An optional forge page URL, which can also use {line}. */
  readonly web?: string;
}
