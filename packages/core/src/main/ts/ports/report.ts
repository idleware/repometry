import type { Report } from '../model/report.js';
import type { Subject } from '../model/source.js';

export interface ReportReader {
  read(subject: Subject): Promise<Report>;
  list(): Promise<readonly Report[]>;
}

export interface ReportWriter {
  save(report: Report): Promise<void>;
}
