// O registro das sessões abertas do Grok lido NO HOST pelo auxiliar (scripts/codex-bridge.ts, npm run bridge), para
// mandar ao Habblaud no Docker (POST /api/grok/registry): o container não vê o active_sessions.json (o Grok o troca de
// inode a cada escrita) e, mesmo que visse, os PIDs são do host. Aqui cada entrada é conferida antes de ir:
// - o PID precisa estar vivo (pidAlive, como no registro do Claude Code);
// - se o Grok gravou `pid_start` (µs desde a época), o início do processo precisa bater com o do `ps` (tolerância de
//   alguns segundos: o `ps` só tem segundos). Um PID reaproveitado por outro processo depois de um crash cai fora.
// Node puro, sem dependências do servidor. O `ps` roda no máximo a cada PS_CACHE_MS por processo.
import { execFileSync } from 'node:child_process';
import { pidAlive } from '../registry';
import { readActiveSessions, type ActiveSession } from './files';

/** Diferença aceita entre o `pid_start` do Grok e o início que o `ps` informa (o `ps` arredonda a segundos). */
export const PID_START_TOLERANCE_MS = 5_000;
/** O início de um processo é perguntado ao `ps` de novo só depois disto. */
export const PS_CACHE_MS = 30_000;

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "Thu Oct 22 14:41:43 2026" (coluna `lstart` do `ps`, hora local) → ms desde a época; undefined se não for isso. */
export function parseLstart(text: string): number | undefined {
  const m = /^(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (!m) return undefined;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return undefined;
  const t = new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Início (ms desde a época) de cada processo, pelo `ps -o pid=,lstart=`. PIDs que o `ps` não listou ficam de fora;
 * sem `ps` (Windows, erro), mapa vazio: a conferência cai só no PID vivo.
 */
export function processStartTimes(pids: readonly number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (!pids.length || process.platform === 'win32') return out;
  let text: string;
  try {
    text = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000 });
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const at = parseLstart(m[2]);
    if (at !== undefined) out.set(Number(m[1]), at);
  }
  return out;
}

export interface LivenessOptions {
  isAlive?: (pid: number) => boolean;
  startTimes?: (pids: readonly number[]) => Map<number, number>;
  now?: () => number;
}

/**
 * Conferidor de processos vivos: `live(entries)` devolve só as entradas cujo processo existe e, quando há `pidStart`,
 * começou na hora gravada. Lembra o início de cada PID por PS_CACHE_MS (um `ps` a cada rodada seria exagero).
 */
export function createLivenessCheck(opts: LivenessOptions = {}): (entries: readonly ActiveSession[]) => ActiveSession[] {
  const isAlive = opts.isAlive ?? pidAlive;
  const startTimes = opts.startTimes ?? processStartTimes;
  const now = opts.now ?? Date.now;
  const cache = new Map<number, { at: number; start?: number }>();
  return (entries) => {
    const alive = entries.filter((e) => isAlive(e.pid));
    const t = now();
    const ask = [...new Set(alive.filter((e) => e.pidStart !== undefined).map((e) => e.pid))].filter((pid) => {
      const c = cache.get(pid);
      return !c || t - c.at >= PS_CACHE_MS;
    });
    if (ask.length) {
      const starts = startTimes(ask);
      for (const pid of ask) cache.set(pid, { at: t, start: starts.get(pid) });
    }
    for (const pid of [...cache.keys()]) if (!alive.some((e) => e.pid === pid)) cache.delete(pid);
    return alive.filter((e) => {
      if (e.pidStart === undefined) return true;
      const start = cache.get(e.pid)?.start;
      return start === undefined || Math.abs(start - e.pidStart / 1_000) <= PID_START_TOLERANCE_MS;
    });
  };
}

/** Lê o active_sessions.json de uma pasta do Grok no host e devolve só as sessões com o processo vivo (sem arquivo: nenhuma). */
export function readLiveSessions(dir: string, live: (entries: readonly ActiveSession[]) => ActiveSession[]): ActiveSession[] {
  const read = readActiveSessions(dir);
  return read.entries ? live(read.entries) : [];
}
