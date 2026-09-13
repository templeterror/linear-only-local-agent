// Model lists for the setup UI. Cursor's list is read live from the CLI when it is logged in.
import { run } from './proc.ts';

export const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'];
export const CURSOR_MODELS_STATIC = ['auto', 'sonnet-4.5', 'sonnet-4.5-thinking', 'opus-4.1', 'gpt-5', 'gpt-5-codex', 'grok-4', 'composer-1'];

let cursorCache: { at: number; models: string[] } | null = null;
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

export async function listModels(kind: 'cursor' | 'claude'): Promise<{ models: string[]; source: 'live' | 'static' }> {
  if (kind === 'claude') return { models: CLAUDE_MODELS, source: 'static' };
  if (cursorCache && Date.now() - cursorCache.at < 10 * 60_000) return { models: cursorCache.models, source: 'live' };
  const r = await run('cursor-agent', ['--list-models'], { timeoutMs: 30_000 });
  const lines = stripAnsi(r.stdout + '\n' + r.stderr).split('\n').map((s) => s.trim()).filter(Boolean);
  const models = lines
    .map((l) => l.match(/^[-*•]?\s*([a-z0-9][a-z0-9._-]*[a-z0-9])\b/i)?.[1])
    .filter((m): m is string => !!m && !/^(loading|no|models|available|error|usage|options|please|run)$/i.test(m));
  if (r.code === 0 && models.length) {
    cursorCache = { at: Date.now(), models: [...new Set(models)] };
    return { models: cursorCache.models, source: 'live' };
  }
  return { models: CURSOR_MODELS_STATIC, source: 'static' };
}
