import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.ts';

let stream: fs.WriteStream | null = null;

function fileStream(): fs.WriteStream | null {
  if (stream) return stream;
  try {
    fs.mkdirSync(PATHS.logs, { recursive: true });
    stream = fs.createWriteStream(path.join(PATHS.logs, 'daemon.log'), { flags: 'a' });
  } catch {
    stream = null;
  }
  return stream;
}

export function log(scope: string, msg: string, extra?: unknown): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `${ts} [${scope}] ${msg}${extra !== undefined ? ' ' + safe(extra) : ''}`;
  console.log(line);
  fileStream()?.write(line + '\n');
}

function safe(x: unknown): string {
  try {
    return typeof x === 'string' ? x : JSON.stringify(x);
  } catch {
    return String(x);
  }
}
