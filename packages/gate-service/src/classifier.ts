/**
 * Step 5 — Injection Classification
 *
 * Stage A: Synchronous regex pattern matching.
 * Stage B: Async LLM classification (runs in queue worker, not here).
 */

export interface StringField {
  path: string;
  value: string;
}

export interface PatternMatchResult {
  matched: boolean;
  path?: string;
  pattern?: string;
}

// Injection patterns from spec
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(previous|all|prior|above|your)\s+instructions?/i,
  /forget\s+(everything|all|your|previous)/i,
  /system\s*prompt/i,
  /you\s+are\s+now\s+(a|an|the)/i,
  /act\s+as\s+(a\s+)?(different|new|another|unrestricted)/i,
  /pretend\s+(you\s+are|to\s+be)/i,
  /jailbreak/i,
  /DAN\s+(mode|prompt)/i,
  /\]\s*\[/,
  /<\s*script[\s>]/i,
  /\/\*[\s\S]*?\*\//,
  /--\s*\n/,
  /prompt\s+injection/i,
  /\x00/,
  // Test trigger for CI/CD acceptance tests
  /INJECTION_TEST_TRIGGER/,
];

/**
 * Recursively extract all string values from a nested object/array.
 */
export function extractStrings(obj: unknown, pathPrefix = ''): StringField[] {
  if (typeof obj === 'string') {
    return [{ path: pathPrefix || '(root)', value: obj }];
  }
  if (Array.isArray(obj)) {
    return obj.flatMap((v, i) => extractStrings(v, `${pathPrefix}[${i}]`));
  }
  if (obj && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      extractStrings(v, pathPrefix ? `${pathPrefix}.${k}` : k)
    );
  }
  return [];
}

/**
 * Stage A — synchronous pattern match against known injection patterns.
 */
export function patternMatch(strings: StringField[]): PatternMatchResult {
  for (const { path, value } of strings) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(value)) {
        return { matched: true, path, pattern: pattern.source };
      }
    }
  }
  return { matched: false };
}
