export const javaScriptExtensions = ['.js', '.mjs', '.cjs', '.jsx'] as const;
export const typeScriptExtensions = ['.ts', '.mts', '.cts', '.tsx'] as const;
export const jsTsExtensions = [...javaScriptExtensions, ...typeScriptExtensions] as const;
