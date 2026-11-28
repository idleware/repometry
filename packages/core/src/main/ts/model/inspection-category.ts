export const category = {
  language: 'language',
  source: 'source',
  maintainability: 'maintainability',
  coverage: 'coverage',
  security: 'security',
} as const;

export type PluginCategory = typeof category[keyof typeof category];
