import { pluginApi } from '../../core/engine/plugin.js';
import type { SourceContext, SourcePlugin } from '../../core/ports/source-provider.js';
import type { SourceLocator } from '../../core/model/source-locator.js';

const manifest = {
  api: pluginApi, version: '1.0.0', kinds: ['source'],
  operations: [], produces: [{ contract: 'repometry.source-locator/v1', persistence: 'report' }],
} as const;

export const localSource: SourcePlugin = {
  ...manifest, id: 'local',
  locate: () => ({ provider: 'local', url: './sources/{revision}/{path}' }),
};

export const githubSource: SourcePlugin = {
  ...manifest, id: 'github',
  locate(context): SourceLocator | undefined {
    const project = forgeProject(context, 'github.com', context.env.GITHUB_REPOSITORY, context.env.GITHUB_SERVER_URL, 2);
    if (!project) return undefined;
    const { origin, path } = project;
    const url = origin === 'https://github.com' ? `https://raw.githubusercontent.com/${path}/{revision}/{path}`
      : `${origin}/${path}/raw/{revision}/{path}`;
    return { provider: 'github', url, web: `${origin}/${path}/blob/{revision}/{path}#L{line}` };
  },
};

export const gitlabSource: SourcePlugin = {
  ...manifest, id: 'gitlab',
  locate(context): SourceLocator | undefined {
    const project = forgeProject(context, 'gitlab.com', context.env.CI_PROJECT_PATH, context.env.CI_SERVER_URL);
    if (!project) return undefined;
    const { origin, path } = project;
    return { provider: 'gitlab', url: `${origin}/api/v4/projects/${encodeURIComponent(path)}/repository/files/{path:component}/raw?ref={revision}`,
      web: `${origin}/${path}/-/blob/{revision}/{path}#L{line}` };
  },
};

function forgeProject(context: SourceContext, host: string, ciProject?: string, ciServer?: string, segments?: number) {
  if (context.option !== undefined && context.option !== '') {
    const explicit = remoteProject(context.option) ?? projectAt('https://' + host, context.option);
    return validProject(explicit, segments);
  }
  if (ciProject) return validProject(projectAt(ciServer ?? 'https://' + host, ciProject), segments);
  for (const remote of context.remotes) {
    const project = validProject(remoteProject(remote), segments);
    if (project && new URL(project.origin).hostname.toLowerCase() === host) return project;
  }
  return undefined;
}

interface Project { readonly origin: string; readonly path: string }

function validProject(project: Project | undefined, segments?: number): Project | undefined {
  if (!project) return undefined;
  const parts = project.path.split('/');
  return parts.length >= 2 && (segments === undefined || parts.length === segments) ? project : undefined;
}

function projectAt(server: string, path: string): Project | undefined {
  try {
    const url = new URL(server);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    const project = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    return project.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')
      ? { origin: url.origin, path: project } : undefined;
  } catch {
    return undefined;
  }
}

function remoteProject(remote: string): Project | undefined {
  const scp = /^(?:[^@/]+@)?([a-z\d.-]+):([^/][^?#]*)$/i.exec(remote);
  if (scp) return projectAt(`https://${scp[1]}`, scp[2]!);
  try {
    const url = new URL(remote);
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) return undefined;
    return projectAt((url.protocol === 'ssh:' ? 'https://' + url.hostname : url.origin), url.pathname);
  } catch {
    return undefined;
  }
}
