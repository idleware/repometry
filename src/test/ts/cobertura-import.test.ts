import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { coberturaToLcov } from '../../main/ts/api/import/cobertura.js';
import { readCoverageFiles } from '../../main/ts/api/import/lcov-files.js';
import { readInputs } from '../../main/ts/cli/imports.js';
import { analyzeSnapshot } from '../../main/ts/compose/analyze-snapshot.js';
import { lcovLines } from '../../main/ts/core/model/line-coverage.js';
import { definitions } from '../../main/ts/core/model/measurement.js';
import type { Report } from '../../main/ts/core/model/report.js';
import { digest, sourceLineCounts, workingSnapshot } from '../../main/ts/core/model/snapshot.js';
import { mapCoverage } from '../../main/ts/plugins/coverage/coverage.js';
import { inspectionDetails } from '../../main/ts/report/json/projections/inspection-details.js';
import { LocalReportStore } from '../../main/ts/report/json/store/local-store.js';

const source = Buffer.from('1;\n'.repeat(8));
const cli = resolve('target/main/ts/cli/main.js');

function context(paths: readonly string[], root = '/repo') {
  return { root, snapshot: workingSnapshot(paths.map(path => ({ path, bytes: source }))) };
}

function document(classes: string, sources = ''): string {
  return '<coverage>\n' + sources + '<packages><package><classes>\n' + classes + '\n</classes></package></packages>\n</coverage>';
}

function record(filename: string, lines: string, methods = '', name = 'Component'): string {
  return '<class filename="' + filename + '" name="' + name + '">' + methods + '<lines>' + lines + '</lines></class>';
}

function convert(xml: string, paths: readonly string[], root = '/repo') {
  const input = context(paths, root);
  const text = coberturaToLcov(xml, 'coverage.xml', input);
  return mapCoverage({ root, text, sourceLines: sourceLineCounts(input.snapshot.files) });
}

async function workspace(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'repometry-cobertura-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('readInputs supports repeatable Cobertura imports and names the format in errors', () => {
  const root = process.cwd();
  assert.deepEqual(readInputs(root, ['cobertura=first.xml', 'lcov=lcov.info', 'go-cover=cover.out', 'cobertura=second.xml']), {
    lcov: [join(root, 'lcov.info')], goCover: [join(root, 'cover.out')],
    cobertura: [join(root, 'first.xml'), join(root, 'second.xml')], findings: [],
  });
  assert.throws(() => readInputs(root, ['unknown=report']), /Choose lcov, go-cover, cobertura,/);
});

const functionMetrics = new Set<string>([definitions.functionCoverage, definitions.coveredFunctions, definitions.coverableFunctions]);
const coverageMetrics = new Set<string>([...functionMetrics, definitions.coverage, definitions.coveredLines,
  definitions.coverableLines, definitions.branchCoverage, definitions.coveredBranches, definitions.coverableBranches]);

// Both reporters ran over the same coverage from c8 12.0.0 and coverage.py 7.10.6 respectively.
for (const [writer, file, functions] of [['c8', 'src/math.js', true], ['coverage-py', 'src/pkg/mod.py', false]] as const) {
  test(writer + ' LCOV and Cobertura agree on their shared coverage measures', async t => {
    const root = await workspace(t);
    const fixtures = resolve('src/test/resources/coverage', writer);
    const bytes = await readFile(join(fixtures, file.split('/').at(-1)!));
    const snapshot = workingSnapshot([{ path: file, bytes }]);
    const xml = await readFile(join(fixtures, 'cobertura.xml'), 'utf8');
    const cobertura = join(root, 'cobertura.xml');
    await writeFile(cobertura, functions ? xml : xml.replace('/build/project/src', join(root, 'src')));
    const options = { snapshot, root };
    const lcov = await readCoverageFiles({ lcov: join(fixtures, 'lcov.info') }, options);
    const converted = await readCoverageFiles({ cobertura }, options);
    const map = (text: string) => mapCoverage({ text, root, sourceLines: sourceLineCounts(snapshot.files) });
    const original = map(lcov.text);
    const parsed = map(converted.text);
    assert.deepEqual(parsed.files, original.files);
    const branchCounts = (coverage: typeof parsed) => {
      const hits = [...coverage.branches.get(file)!.values()];
      return { total: hits.length, covered: hits.filter(hit => hit > 0).length };
    };
    assert.deepEqual(branchCounts(parsed), branchCounts(original));
    assert.ok(original.functionCalls.has(file));
    assert.deepEqual(parsed.functionCalls.get(file), functions ? original.functionCalls.get(file) : undefined);
    assert.equal(parsed.gaps.size, 0);

    const analyze = (text: string) => analyzeSnapshot({ snapshot, excludedOutput: null, coverage: { text, sourceRoot: root } });
    const [lcovReport, xmlReport] = await Promise.all([analyze(lcov.text), analyze(converted.text)]);
    const metrics = (report: Report) => report.measurements.filter(row => coverageMetrics.has(row.definition));
    assert.ok(lcovReport.measurements.some(row => functionMetrics.has(row.definition)));
    assert.deepEqual(metrics(xmlReport), metrics(lcovReport).filter(row => functions || !functionMetrics.has(row.definition)));
    const originalLines = inspectionDetails(lcovReport).lineCoverage![file]!;
    const convertedLines = inspectionDetails(xmlReport).lineCoverage![file]!;
    const { functionCalls, ...lines } = originalLines;
    assert.ok(functionCalls);
    assert.deepEqual(convertedLines, functions ? originalLines : lines);
  });
}

test('source candidates handle several roots, trailing slashes, empty sources and bare paths', () => {
  const lines = '<line number="1" hits="3"/>';
  const paths = ['second/file.js', 'bare.js'];
  const withSources = document(record('file.js', lines) + record('bare.js', lines),
    '<sources><source>/repo/first</source><source>/repo/second/</source><source> </source></sources>');
  assert.deepEqual([...convert(withSources, paths).files],
    [['bare.js', new Map([[1, 3]])], ['second/file.js', new Map([[1, 3]])]]);
  assert.deepEqual([...convert(document(record('bare.js', lines)), paths).files], [['bare.js', new Map([[1, 3]])]]);
});

test('distinct known source candidates are an error', () => {
  const xml = document(record('a.js', '<line number="1" hits="1"/>'),
    '<sources><source>first</source><source>second</source><source>first</source></sources>');
  assert.throws(() => convert(xml, ['first/a.js', 'second/a.js']), /Ambiguous Cobertura source "a\.js": first\/a\.js, second\/a\.js/);
  assert.throws(() => convert(xml, ['first/a.js', 'a.js']), /Ambiguous Cobertura source "a\.js": a\.js, first\/a\.js/);
});

test('repeated classes and lines keep the greatest hit count in one file', () => {
  const first = record('a.js', '<line number="1" hits="4"/><line number="1" hits="2"/><line number="2" hits="3"/>');
  const second = record('./a.js', '<line number="1" hits="5"/><line number="3" hits="1"/>');
  const mapped = convert(document(first + second), ['a.js']);
  assert.deepEqual([...mapped.files], [['a.js', new Map([[1, 5], [2, 3], [3, 1]])]]);
});

test('method calls use the earliest declaration line and stay separate from line hits', () => {
  const methods = '<methods><method name="run" signature="(I)V" hits="44"><lines>'
    + '<line number="3" hits="9"/><line number="2" hits="1"/></lines></method>'
    + '<method name="run" signature="(I)V"><lines><line number="5" hits="0"/></lines></method>'
    + '<method name="empty"><lines/></method></methods>';
  const xml = document(record('a.js', '<line number="2" hits="7"/><line number="5" hits="4"/>', methods));
  const result = convert(xml, ['a.js']);
  assert.deepEqual(result.files.get('a.js'), new Map([[2, 7], [5, 4]]));
  assert.deepEqual(result.functionCalls.get('a.js'), [[2, 1], [5, 0]]);
  assert.deepEqual([...result.functions.get('a.js')!.keys()], ['Component.run(I)V#1', 'Component.run(I)V#2']);
});

test('branches take the greatest total then covered count and retain partial lines', async () => {
  const first = record('a.js', '<line number="1" hits="1" branch="True" condition-coverage="0% (0/2)"/>'
    + '<line number="2" hits="1" branch="True" condition-coverage="50.0%(1/2)"/>'
    + '<line number="3" hits="1" condition-coverage="100% (2/2)"/>'
    + '<line number="4" hits="1" condition-coverage="100%"/>');
  const second = record('a.js', '<line number="2" hits="1" condition-coverage="100% (1/1)"/>'
    + '<line number="3" hits="1" condition-coverage="50% (1/2)"/>');
  const xml = document(first + second);
  const input = context(['a.js']);
  const text = coberturaToLcov(xml, 'coverage.xml', input);
  const branches = convert(xml, ['a.js']).branches.get('a.js')!;
  assert.deepEqual([...branches.values()], [0, 0, 1, 0, 1, 1]);
  const report = await analyzeSnapshot({
    snapshot: input.snapshot, excludedOutput: null, coverage: { text, sourceRoot: input.root },
  });
  assert.deepEqual(inspectionDetails(report).lineCoverage?.['a.js']?.partial, [[2, 2]]);
});

test('multiple Cobertura inputs are ordered by original digest and sum hits across files', async t => {
  const root = await workspace(t);
  const files = [join(root, 'one.xml'), join(root, 'two.xml')];
  const inputs = [2, 6].map(hits => document(record('a.js', '<line number="1" hits="' + hits + '"/>')));
  await Promise.all(files.map((file, index) => writeFile(file, inputs[index]!)));
  const source = context(['a.js'], root);
  const read = await readCoverageFiles({ cobertura: files }, source);
  assert.deepEqual(await readCoverageFiles({ cobertura: files.toReversed() }, source), read);
  assert.deepEqual(read.inputDigests, inputs.map(digest).sort());
  assert.deepEqual(mapCoverage({ root, text: read.text, sourceLines: new Map([['a.js', 1]]) }).files.get('a.js'), new Map([[1, 8]]));
  await assert.rejects(() => readCoverageFiles({ cobertura: [] }, source), /Provide at least one Cobertura file/);
});

test('absolute filenames map inside the root and retain outside paths and Source Link URLs as gaps', () => {
  const line = '<line number="1" hits="1"/>';
  const xml = document(record('/repo/a.js', line) + record('/foreign/a.js', line) + record('https://example.test/shipped.js', line));
  const result = convert(xml, ['a.js']);
  assert.deepEqual([...result.files.keys()], ['a.js']);
  assert.equal(result.gaps.size, 2);
  assert.ok(result.gaps.has('../foreign/a.js'));
  assert.ok([...result.gaps.keys()].some(path => path.endsWith('example.test/shipped.js')));
  assert.ok([...result.gaps.values()].every(gap => gap === 'LCOV source is outside the inspected file set'));
});

test('path normalization follows the source root platform', () => {
  const line = '<line number="1" hits="2"/>';
  const windows = document(record('pkg\\mod.py', line), '<sources><source>C:\\repo\\src\\</source></sources>');
  assert.deepEqual([...convert(windows, ['src/pkg/mod.py'], 'C:\\repo').files.keys()], ['src/pkg/mod.py']);
  const posix = document(record('pkg\\mod.py', line));
  assert.deepEqual([...convert(posix, ['pkg\\mod.py']).files.keys()], ['pkg\\mod.py']);
});

test('XML supports a BOM, declarations, comments, CDATA and named and numeric entities', () => {
  const xml = '\uFEFF<?xml version="1.0" encoding="ignored"?>\r\n<!-- sample -->\r\n'
    + '<!DOCTYPE coverage SYSTEM "https://example.test/a[dtd].xml">\r\n'
    + document("<class filename='a&amp;&#x3b1;&#46;js'><lines><line number='1' hits='1'/></lines></class>",
      '<sources><source><![CDATA[/repo/src/]]></source></sources>');
  assert.deepEqual([...convert(xml, ['src/a&α.js']).files.keys()], ['src/a&α.js']);
});

test('invalid XML and coverage values report the source file and line', () => {
  const cases = [
    ['', 1, 'expected a <coverage> root element'],
    ['<root/>', 1, 'expected a <coverage> root element'],
    ['<coverage>\n<packages>', 2, 'unclosed <packages>'],
    ['<coverage>\n<packages></coverage>', 2, 'unexpected </coverage>'],
    ['<coverage>\n<1bad/></coverage>', 2, 'malformed tag'],
    ['<coverage>\n<packages name=no/></coverage>', 2, 'malformed attribute'],
    ['<coverage>\n<packages name="a" name="b"/></coverage>', 2, 'duplicate attribute name'],
    ['<?xml version="1.0"?>\n<!DOCTYPE coverage [<!ENTITY word "text">]><coverage/>', 2, 'DOCTYPE with an internal subset is not supported'],
    [document(record('a&unknown;.js', '')), 3, 'unknown entity &unknown;'],
    [document('<class/>'), 3, '<class> has no filename'],
    [document(record('a.js', '<line number="0" hits="1"/>')), 3, 'line number must be a positive integer'],
    [document(record('a.js', '<line number="1.5" hits="1"/>')), 3, 'line number must be a positive integer'],
    [document(record('a.js', '<line number="1" hits="-1"/>')), 3, 'hits must be a non-negative integer'],
    [document(record('a.js', '<line number="1" hits="x"/>')), 3, 'hits must be a non-negative integer'],
    [document(record('a.js', '<line number="1" hits="9007199254740992"/>')), 3, 'hit count exceeds the supported integer range'],
    [document(record('a.js', '<line number="1" hits="1" condition-coverage="50% (3/2)"/>')), 3, 'invalid condition-coverage "50% (3/2)"'],
    [document(record('a.js', '<line number="1" hits="1" condition-coverage="0% (0/9007199254740991)"/>')), 3, 'too many branches'],
    [document(record('a.js', '<line number="1" hits="1" condition-coverage="50% (1/17000000)"/>')), 3, 'too many branches'],
    [document(record('a.js', '<line number="1" hits="1" condition-coverage="0% (0/8388608)"/>\n'
      + '<line number="2" hits="1" condition-coverage="0% (0/8388609)"/>')), 4, 'too many branches'],
    ['<coverage>\n<packages\n  name="p"\n  bad\n></packages></coverage>', 4, 'malformed attribute'],
    ['<coverage>\n<packages\n  name="p"\n\n  name="q"/></coverage>', 5, 'duplicate attribute name'],
    ['<coverage/>\n\n\njunk', 4, 'expected a <coverage> root element'],
    ['<coverage><sources><source>\n\n  &nbsp;/x</source></sources></coverage>', 3, 'unknown entity &nbsp;'],
    ['<!DOCTYPE coverage SYSTEM "unclosed><coverage/>', 1, 'malformed tag'],
    ['<!DOCTYPE coverage SYSTEM "a" [<!ENTITY a "b">]><coverage/>', 1, 'DOCTYPE with an internal subset is not supported'],
  ] as const;
  for (const [xml, line, reason] of cases) {
    assert.throws(() => convert(xml, ['a.js']), { message: 'Invalid Cobertura report coverage.xml at line ' + line + ': ' + reason });
  }
});

test('long DOCTYPE declarations and processing instructions are skipped', () => {
  const body = document(record('a.js', '<line number="1" hits="1"/>'));
  const xml = '<?xml version="1.0"?>\n<?xml-stylesheet href="x"?>\n<!DOCTYPE coverage ' + 'a "b" '.repeat(2_000_000) + '>\n<?foo bar?>' + body;
  assert.deepEqual([...convert(xml, ['a.js']).files.keys()], ['a.js']);
});

test('a huge branch count is rejected before any expansion', () => {
  const start = process.hrtime.bigint();
  const xml = document(record('a.js', '<line number="1" hits="1" condition-coverage="50% (1/17000000)"/>'));
  assert.throws(() => convert(xml, ['a.js']), /at line 3: too many branches/);
  assert.ok(process.hrtime.bigint() - start < 1_000_000_000n);
});

test('a non-UTF-8 Cobertura file has a coverage-specific error', async t => {
  const root = await workspace(t);
  const cobertura = join(root, 'invalid.xml');
  await writeFile(cobertura, Buffer.from([0xc0, 0xaf]));
  await assert.rejects(() => readCoverageFiles({ cobertura }, context([], root)),
    { message: 'Invalid Cobertura report ' + cobertura + ' at line 1: invalid UTF-8' });
});

test('the CLI persists the same line coverage for LCOV and Cobertura and applies exclusions', async t => {
  const root = await workspace(t);
  const fixtures = resolve('src/test/resources/coverage/c8');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src/math.js'), await readFile(join(fixtures, 'math.js')));
  const scan = async (name: string, input: string, extra: string[] = []) => {
    const store = join(root, '.repometry', name);
    const result = spawnSync(process.execPath, [cli, 'analyze', '--working-tree', '--store', store, '--import', input, ...extra],
      { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return new LocalReportStore(store).read(JSON.parse(result.stdout).subject);
  };
  const cobertura = 'cobertura=' + join(fixtures, 'cobertura.xml');
  const [lcov, xml] = await Promise.all([scan('lcov', 'lcov=' + join(fixtures, 'lcov.info')), scan('cobertura', cobertura)]);
  const product = (report: Report) => report.pluginData?.products[lcovLines.id];
  assert.ok(product(lcov)?.length);
  assert.deepEqual(product(xml), product(lcov));
  const local = join(root, 'local.xml');
  const xmlText = await readFile(join(fixtures, 'cobertura.xml'), 'utf8');
  await writeFile(local, xmlText.replace('/build/project', await realpath(root)));
  const excluded = await scan('excluded', 'cobertura=' + local, ['--exclude', 'src/math.js']);
  assert.deepEqual(excluded.diagnostics, []);
  assert.equal(inspectionDetails(excluded).lineCoverage?.['src/math.js'], undefined);
  const foreign = join(root, 'foreign.xml');
  await writeFile(foreign, xmlText.replace('/build/project', '/nonexistent/build/project'));
  const skipped = await scan('foreign', 'cobertura=' + foreign, ['--exclude', 'src/math.js']);
  const lcovSkipped = await scan('lcov-excluded', 'lcov=' + join(fixtures, 'lcov.info'), ['--exclude', 'src/math.js']);
  assert.deepEqual(skipped.diagnostics, lcovSkipped.diagnostics);
  assert.deepEqual(inspectionDetails(skipped).lineCoverage, inspectionDetails(lcovSkipped).lineCoverage);
});

test('an unknown relative filename keeps its own path as a gap', () => {
  const xml = document(record('src/a.js', '<line number="1" hits="1"/>'), '<sources><source>/nonexistent/build</source></sources>');
  assert.deepEqual([...convert(xml, ['b.js']).gaps.keys()], ['src/a.js']);
});
