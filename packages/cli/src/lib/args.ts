// packages/cli/src/lib/args.ts
//
// Hand-rolled argument parser. No commander/yargs dep.
// Matches the flag syntax used in broker-receiver/src/cli.ts.
//
// Usage:
//   nova <command> [subcommand] [--flag value] [--bool-flag] [positional...]

export interface ParsedArgs {
  command: string;
  sub: string | undefined;
  flags: Record<string, string | boolean>;
  positional: string[];
  help: boolean;
  json: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  // If the first token is a flag (--help, --version), treat command as 'help'
  const firstIsFlag = (argv[0] ?? '').startsWith('--');
  const tokens = firstIsFlag ? ['help', ...argv] : argv;
  const [command = 'help', ...rest] = tokens;
  let sub: string | undefined;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  let i = 0;

  // First non-flag token after command is the subcommand (if it doesn't start with --)
  if (rest[0] && !rest[0].startsWith('--')) {
    sub = rest[0];
    i = 1;
  }

  for (; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[tok.slice(2)] = next;
          i++;
        } else {
          flags[tok.slice(2)] = true;
        }
      }
    } else {
      positional.push(tok);
    }
  }

  return {
    command,
    sub,
    flags,
    positional,
    help: flags['help'] === true || flags['h'] === true,
    json: flags['json'] === true,
  };
}

export function flag(flags: Record<string, string | boolean>, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = flags[name];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

export function flagBool(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  for (const name of names) {
    if (flags[name] === true || flags[name] === 'true') return true;
  }
  return false;
}

export function flagInt(flags: Record<string, string | boolean>, name: string, def: number): number {
  const v = flags[name];
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return def;
}
