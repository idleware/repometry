import { isSensitiveFinding } from '../core/model/finding.js';
import { findingImportMethods } from '../core/model/scanner-import.js';
import { openMetabranchWorktree } from '../api/git/metabranch-worktree.js';
import { LocalReportStore } from '../report/json/store/local-store.js';
import type { Report } from '../report/json/validation/report.js';

interface MetabranchRequest {
  readonly repository: string;
  readonly worktree: string;
  readonly branch: string;
  readonly report: Report;
}

export async function prepareMetabranch({ repository, worktree, branch, report }: MetabranchRequest): Promise<readonly string[]> {
  if (report.subject.kind !== 'commit') throw new Error('Only reports for source commits can go into a metabranch');
  if (report.findings?.some(finding => isSensitiveFinding(finding.category))
    || report.ignoredFindings?.some(({ finding }) => isSensitiveFinding(finding.category))
    || findingImportMethods(report.appliedConfig.findingImports).some(method => isSensitiveFinding(method.category))) {
    throw new Error('Security scanner imports belong in the local report store');
  }
  const target = await openMetabranchWorktree(repository, worktree, branch, report.subject.id);
  await new LocalReportStore(target).save(report);
  return ['manifest.json', 'summary.json', 'objects', `commits/${report.subject.id}/report.json`];
}
