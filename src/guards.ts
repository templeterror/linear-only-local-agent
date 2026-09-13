// Post-run guardrails over the worker's diff. Pure functions; daemon fails the job on any violation.

export interface GuardViolation {
  rule: string;
  file?: string;
  detail: string;
}

const FORBIDDEN_PATHS: { re: RegExp; rule: string }[] = [
  { re: /(^|\/)\.env(\.[^/]*)?$/, rule: 'env-file' },
  { re: /^\.github\/workflows\//, rule: 'ci-workflow' },
  { re: /^\.linear-agent\.json$/, rule: 'agent-config' },
  { re: /(^|\/)\.git\//, rule: 'git-internals' },
];

const DESTRUCTIVE_SQL: { re: RegExp; rule: string }[] = [
  { re: /\bdrop\s+(table|database|schema)\b/i, rule: 'sql-drop' },
  { re: /\btruncate\s+(table\s+)?\w+/i, rule: 'sql-truncate' },
  { re: /\bdelete\s+from\s+[\w."]+\s*;/i, rule: 'sql-delete-without-where' },
  { re: /\balter\s+table\s+[\w."]+\s+drop\s+column\b/i, rule: 'sql-drop-column' },
];

const SECRET_PATTERNS: RegExp[] = [/\b(sk-[A-Za-z0-9]{20,})\b/, /\b(lin_api_[A-Za-z0-9]{20,})\b/, /\b(ghp_[A-Za-z0-9]{20,})\b/, /\b(AKIA[0-9A-Z]{16})\b/, /\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/];

/** Split a unified diff into per-file added lines. */
function addedLinesByFile(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const m = line.match(/^\+\+\+ (?:b\/)?(.*)$/);
      file = m && m[1] !== '/dev/null' ? m[1] : null;
      if (file) out.set(file, []);
      continue;
    }
    if (file && line.startsWith('+') && !line.startsWith('+++')) out.get(file)!.push(line.slice(1));
  }
  return out;
}

export function scanDiff(diff: string, files: string[]): GuardViolation[] {
  const v: GuardViolation[] = [];
  for (const f of files) {
    for (const { re, rule } of FORBIDDEN_PATHS) if (re.test(f)) v.push({ rule, file: f, detail: `worker modified protected path ${f}` });
  }
  for (const [file, lines] of addedLinesByFile(diff)) {
    const isSql = /\.sql$/i.test(file) || /migrations?\//i.test(file);
    for (const line of lines) {
      if (isSql) for (const { re, rule } of DESTRUCTIVE_SQL) if (re.test(line)) v.push({ rule, file, detail: line.trim().slice(0, 160) });
      for (const re of SECRET_PATTERNS) if (re.test(line)) v.push({ rule: 'secret-in-diff', file, detail: 'added line looks like a credential' });
    }
  }
  return dedupe(v);
}

export function scanSql(sql: string): GuardViolation[] {
  const v: GuardViolation[] = [];
  for (const line of sql.split('\n')) for (const { re, rule } of DESTRUCTIVE_SQL) if (re.test(line)) v.push({ rule, detail: line.trim().slice(0, 160) });
  return dedupe(v);
}

function dedupe(v: GuardViolation[]): GuardViolation[] {
  const seen = new Set<string>();
  return v.filter((x) => {
    const k = `${x.rule}|${x.file}|${x.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Extract added SQL from migration files in a diff (to post on the ticket). */
export function extractMigrationSql(diff: string): string {
  const parts: string[] = [];
  for (const [file, lines] of addedLinesByFile(diff)) {
    if (/\.sql$/i.test(file) && /migration/i.test(file)) parts.push(`-- ${file}\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}
