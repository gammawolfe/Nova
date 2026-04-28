// packages/cli/src/lib/fmt.ts
//
// Terminal output helpers. No external deps — ANSI codes inline.
// All colour is disabled when stdout is not a TTY (piped / CI).

const isTTY = process.stdout.isTTY ?? false;

const c = {
  reset:   isTTY ? '\x1b[0m'  : '',
  bold:    isTTY ? '\x1b[1m'  : '',
  dim:     isTTY ? '\x1b[2m'  : '',
  cyan:    isTTY ? '\x1b[36m' : '',
  green:   isTTY ? '\x1b[32m' : '',
  yellow:  isTTY ? '\x1b[33m' : '',
  red:     isTTY ? '\x1b[31m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
  blue:    isTTY ? '\x1b[34m' : '',
  grey:    isTTY ? '\x1b[90m' : '',
};

export function bold(s: string)    { return `${c.bold}${s}${c.reset}`; }
export function dim(s: string)     { return `${c.dim}${s}${c.reset}`; }
export function cyan(s: string)    { return `${c.cyan}${s}${c.reset}`; }
export function green(s: string)   { return `${c.green}${s}${c.reset}`; }
export function yellow(s: string)  { return `${c.yellow}${s}${c.reset}`; }
export function red(s: string)     { return `${c.red}${s}${c.reset}`; }
export function magenta(s: string) { return `${c.magenta}${s}${c.reset}`; }
export function blue(s: string)    { return `${c.blue}${s}${c.reset}`; }
export function grey(s: string)    { return `${c.grey}${s}${c.reset}`; }

// ── Status badges ──────────────────────────────────────────────────────────

export function agentStatus(status: string): string {
  switch (status) {
    case 'active':       return green('● active');
    case 'pending':      return yellow('◌ pending');
    case 'deregistered': return grey('○ deregistered');
    case 'suspended':    return red('✕ suspended');
    default:             return dim(status);
  }
}

export function taskStatus(status: string): string {
  switch (status) {
    case 'completed':     return green('✓ completed');
    case 'working':       return cyan('⟳ working');
    case 'queued':        return blue('· queued');
    case 'input_required':return yellow('? input_required');
    case 'failed':        return red('✕ failed');
    case 'canceled':      return grey('— canceled');
    default:              return dim(status);
  }
}

export function trustTier(tier: number): string {
  switch (tier) {
    case 1: return dim('T1');
    case 2: return cyan('T2');
    case 3: return green('T3');
    default: return yellow(`T${tier}`);
  }
}

export function eventType(type: string): string {
  switch (type) {
    case 'task':   return cyan('task  ');
    case 'agent':  return magenta('agent ');
    case 'tenant': return blue('tenant');
    default:       return dim(type.padEnd(6));
  }
}

export function taskAction(action: string): string {
  switch (action) {
    case 'queued':      return blue('queued     ');
    case 'completed':   return green('completed  ');
    case 'failed':      return red('failed     ');
    case 'quarantined': return yellow('quarantined');
    default:            return dim(action.padEnd(11));
  }
}

export function agentAction(action: string): string {
  switch (action) {
    case 'created':      return cyan('created     ');
    case 'approved':     return green('approved    ');
    case 'deregistered': return grey('deregistered');
    default:             return dim(action.padEnd(12));
  }
}

// ── Table renderer ─────────────────────────────────────────────────────────

interface Column {
  header: string;
  key: string;
  width?: number;
  render?: (val: any, row: any) => string;
}

export function table(rows: any[], columns: Column[]): void {
  if (rows.length === 0) {
    console.log(dim('  (none)'));
    return;
  }

  // Compute column widths: max of header length and all rendered values
  const widths = columns.map(col => {
    const vals = rows.map(r => {
      const raw = r[col.key];
      const rendered = col.render ? col.render(raw, r) : String(raw ?? '');
      return stripAnsi(rendered).length;
    });
    return col.width ?? Math.max(col.header.length, ...vals);
  });

  // Header
  const header = columns.map((col, i) => bold(col.header.padEnd(widths[i]!))).join('  ');
  console.log('  ' + header);
  console.log('  ' + widths.map(w => '─'.repeat(w)).join('  '));

  // Rows
  for (const row of rows) {
    const cells = columns.map((col, i) => {
      const raw = row[col.key];
      const rendered = col.render ? col.render(raw, row) : String(raw ?? '');
      const visible = stripAnsi(rendered).length;
      const pad = Math.max(0, widths[i]! - visible);
      return rendered + ' '.repeat(pad);
    });
    console.log('  ' + cells.join('  '));
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Misc helpers ──────────────────────────────────────────────────────────

export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'in the future';
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function ts(): string {
  return grey(new Date().toISOString().slice(11, 23)); // HH:MM:SS.mmm
}

export function printError(err: unknown): void {
  if (err instanceof Error) {
    console.error(red('error: ') + err.message);
  } else {
    console.error(red('error: ') + String(err));
  }
}

export function printSuccess(msg: string): void {
  console.log(green('✓ ') + msg);
}

export function printWarn(msg: string): void {
  console.log(yellow('⚠ ') + msg);
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function section(title: string): void {
  console.log('\n' + bold(title));
}
