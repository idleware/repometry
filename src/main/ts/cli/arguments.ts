import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';

interface Option {
  readonly type: 'string' | 'boolean';
  readonly description: string;
  readonly value?: string;
  readonly short?: string;
  readonly multiple?: boolean;
}

type Value = string | string[] | boolean | undefined;

export interface Invocation {
  readonly args: readonly string[];
  text(name: string): string | undefined;
  flag(name: string): boolean;
  many(name: string): readonly string[];
}

export interface Command {
  readonly description: string;
  readonly parameters?: string;
  readonly min?: number;
  readonly max?: number;
  readonly options?: Readonly<Record<string, Option>>;
  run(input: Invocation): Promise<number | void> | number | void;
}

export function option(value: string, description: string, props: { short?: string; multiple?: boolean } = {}): Option {
  return { type: 'string', value, description, ...props };
}

export function flag(description: string, short?: string): Option {
  return { type: 'boolean', description, short };
}

const globals = {
  help: flag('Show command help.', 'h'),
  version: flag('Show the installed version.', 'V'),
  repo: option('DIR', 'Run in the given repository.', { short: 'C' }),
  store: option('PATH|git:REF', 'Select a report store.'),
};

export async function dispatch(commands: Readonly<Record<string, Command>>, input: readonly string[], version: string): Promise<number> {
  const [name, ...rest] = placeGlobalOptions(input);
  if (name === '--version' || name === '-V') {
    process.stdout.write(version + '\n');
    return 0;
  }
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    showHelp(commands, name === 'help' ? rest[0] : undefined);
    return 0;
  }
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) throw new Error(`Unknown command: ${name}.${suggest(name, Object.keys(commands))}`);
  const options = { ...globals, ...command.options };
  const config = Object.fromEntries(Object.entries(options).map(([key, { type, short, multiple }]) => [key,
    { type, ...(short === undefined ? {} : { short }), ...(multiple === undefined ? {} : { multiple }) }]));
  let parsed: { values: Record<string, Value>; positionals: string[] };
  try {
    parsed = parseArgs({ args: rest, options: config as ParseArgsConfig['options'], allowPositionals: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const unknown = /'([^']+)'/.exec(error.message)?.[1] ?? '';
      const choices = Object.keys(options).map(value => '--' + value);
      throw new Error(`${unknown || 'Unknown option'} is not an option of ${name}.${suggest(unknown, choices)}`);
    }
    throw error;
  }
  if (parsed.values.version) {
    process.stdout.write(version + '\n');
    return 0;
  }
  if (parsed.values.help) {
    showHelp(commands, name);
    return 0;
  }
  const args = parsed.positionals;
  if (args.length < (command.min ?? 0) || args.length > (command.max ?? 0)) {
    throw new Error(`Usage: repometry ${name}${command.parameters ? ' ' + command.parameters : ''}`);
  }
  const result = await command.run({
    args,
    text: key => typeof parsed.values[key] === 'string' ? parsed.values[key] : undefined,
    flag: key => parsed.values[key] === true,
    many: key => Array.isArray(parsed.values[key]) ? parsed.values[key] : [],
  });
  return result ?? 0;
}

function placeGlobalOptions(input: readonly string[]): readonly string[] {
  const leading: string[] = [];
  let index = 0;
  while (index < input.length) {
    const next = input[index]!;
    if (/^(?:--repo|--store)=/.test(next)) leading.push(next);
    else if (next === '-C' || next === '--repo' || next === '--store') {
      if (input[index + 1] === undefined) throw new Error(`${next} needs a value`);
      leading.push(next, input[++index]!);
    } else break;
    index++;
  }
  return input[index] === undefined ? [] : [input[index]!, ...leading, ...input.slice(index + 1)];
}

function showHelp(commands: Readonly<Record<string, Command>>, name?: string): void {
  if (name === undefined) {
    process.stdout.write(['Usage: repometry <command> [options]', '', ...Object.entries(commands)
      .map(([id, command]) => `  ${id.padEnd(15)} ${command.description}`), '  help            Show help for any command.', ''].join('\n'));
    return;
  }
  const command = Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (!command) throw new Error(`Unknown command: ${name}.${suggest(name, Object.keys(commands))}`);
  const usage = `Usage: repometry ${name}${command.parameters ? ' ' + command.parameters : ''}`;
  const help = Object.entries({ ...globals, ...command.options }).map(([key, setting]) => {
    const flags = (setting.short ? `-${setting.short}, ` : '') + `--${key}` + (setting.value ? ' ' + setting.value : '');
    return `  ${flags.padEnd(28)} ${setting.description}`;
  });
  process.stdout.write([usage, '', command.description, '', ...help, ''].join('\n'));
}

function suggest(name: string, candidates: readonly string[]): string {
  const ranked = candidates.map(value => ({ value, score: distance(name, value) })).sort((a, b) => a.score - b.score);
  const nearest = ranked[0];
  return nearest && nearest.score <= Math.max(2, Math.floor(name.length / 3)) ? ` Did you mean ${nearest.value}?` : '';
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(row[j + 1]! + 1, next[j]! + 1, row[j]! + Number(a[i] !== b[j])));
    row = next;
  }
  return row[b.length]!;
}
