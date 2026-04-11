/**
 * Shared classifier utilities — pure functions with no external dependencies.
 * Used by both gate-service (Stage A + B pattern+LLM) and agent-connector (Stage B legacy).
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
