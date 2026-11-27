import type { InspectionDetails } from '../../json/wire/inspection-details-model.js';
import { diagnosticsView } from './viewer-diagnostics.js';
import { parentPath } from './viewer-dom.js';
import { fileView } from './viewer-file-source.js';
import { hotspotView } from './viewer-hotspots.js';
import type { Navigation, Preferences, View } from './viewer-inspection.js';
import { useDetails } from './viewer-inspection.js';
import { issuesView } from './viewer-issues.js';
import { metricsView } from './viewer-metrics-view.js';

/**
 * The finding categories Repometry counts as code smells, mirroring core's quality summary (structure and
 * duplication), so the Overview's smell count links to exactly the findings it counts.
 */
export const codeSmellCategories = ['structure', 'duplication'] as const;
/** The finding categories behind the security level, as the Overview's security column counts them. */
export const securityCategories = ['security', 'dependency', 'secret', 'infrastructure'] as const;

const preferences = new WeakMap<HTMLElement, Preferences>();

/** A reader's choices on these pages, kept per container while the viewer stays open. */
function preferencesOf(container: HTMLElement, details: InspectionDetails): Preferences {
  // A small codebase reads best as one flat list; a large one starts from its folders.
  const settings = preferences.get(container) ?? { mode: details.metrics.files.length <= 1000 ? 'list' : 'tree', sort: 0, ascending: true,
    hotspot: 'complexity', columns: new Map(), unanalysed: false };
  preferences.set(container, settings);
  return settings;
}

/** The pages that read one inspection: Metrics (or an open file), Hotspots, Findings and Diagnostics. */
export function renderFileView(container: HTMLElement, view: View, details: InspectionDetails, navigation: Navigation): void {
  useDetails(details);
  const settings = preferencesOf(container, details);
  const selectedFile = details.metrics.files.find(file => file.path === navigation.file);
  const requested = selectedFile && view === 'metrics' ? parentPath(selectedFile.path) : navigation.directory;
  const directory = details.metrics.directories.find(entry => entry.path === requested)?.path ?? '';
  const pages: Record<View, () => HTMLElement> = {
    metrics: () => selectedFile && navigation.source
      ? fileView(details, navigation, selectedFile, navigation.source)
      : metricsView(details, navigation, settings, directory, selectedFile),
    hotspots: () => hotspotView(details, navigation, settings, directory),
    issues: () => issuesView(details, navigation),
    diagnostics: () => diagnosticsView(details, navigation),
  };
  container.replaceChildren(pages[view]());
}
