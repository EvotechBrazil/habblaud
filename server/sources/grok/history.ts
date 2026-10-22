// Histórico do terminal do Grok (o HistoryProvider 'grok', ver sources/source.ts): as conversas recentes de cada
// conta do Grok (abertas ou já encerradas), listadas a partir de sessions/<cwd>/<id>/updates.jsonl modificados nos
// últimos 7 dias. De cada sessão lê só o summary.json (projeto, título gerado, horários), com cache enquanto o
// mtime dele não muda; o updates.jsonl só é aberto pelo terminal, ao abrir a sessão.
import { realpathSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { RecentSession } from '../../../shared/types';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { isSessionId, listSessionDirs, readSummary, type GrokSummary, type SessionDirInfo } from './files';
import { createGrokTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

export interface GrokHistoryAccount {
  id: string;
  /** Pasta do Grok lida por este processo (no Docker, a montada). */
  dir: string;
}

export interface GrokHistoryOptions {
  accounts: () => readonly GrokHistoryAccount[];
  /** Agente principal da sessão, se ela ainda estiver aberta no escritório. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

interface Candidate extends SessionDirInfo {
  account: string;
  mtimeMs: number;
  size: number;
}

export class GrokHistory implements HistoryProvider {
  readonly provider = 'grok' as const;
  private cache = new Map<string, { mtimeMs: number; summary?: GrokSummary }>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: GrokHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  async list(): Promise<RecentSession[]> {
    const now = this.now();
    const all: Candidate[] = [];
    for (const acc of this.opts.accounts()) {
      for (const info of listSessionDirs(acc.dir)) {
        try {
          const st = await stat(info.path);
          if (!st.isFile() || now - st.mtimeMs > this.maxAgeMs) continue;
          all.push({ ...info, account: acc.id, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // sessão sem updates.jsonl (ainda) ou apagada no meio da listagem
        }
      }
    }
    all.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const picked = all.slice(0, this.limit);
    const keep = new Set(picked.map((c) => c.dir));
    for (const dir of this.cache.keys()) if (!keep.has(dir)) this.cache.delete(dir);

    const out: RecentSession[] = [];
    for (const c of picked) {
      const s = this.summaryOf(c);
      const agentId = this.opts.openAgentOf(c.account, c.sessionId);
      const cwd = s?.cwd ?? c.cwd;
      const r: RecentSession = {
        account: c.account,
        provider: 'grok',
        sessionId: c.sessionId,
        projectDir: cwd ? encodeCwd(cwd) : 'sessions',
        lastAt: s?.lastActiveAt ?? s?.updatedAt ?? c.mtimeMs,
        size: c.size,
        open: !!agentId,
      };
      if (cwd) r.project = cwd;
      if (s?.title) r.title = s.title;
      if (s?.createdAt !== undefined) r.firstAt = s.createdAt;
      if (agentId) r.agentId = agentId;
      out.push(r);
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  /**
   * updates.jsonl da sessão `sessionId` da conta, validado: conta conhecida, id com formato de UUID e o arquivo (com
   * links resolvidos) dentro da pasta da conta.
   */
  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!isSessionId(sessionId)) return { status: 400, error: tr('id de sessão inválido') };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: tr('conta desconhecida') };
    let root: string;
    try {
      root = realpathSync(acc.dir);
    } catch {
      return { status: 404, error: tr('sessão não encontrada') };
    }
    const id = sessionId.toLowerCase();
    for (const info of listSessionDirs(acc.dir)) {
      if (info.sessionId !== id) continue;
      try {
        const real = realpathSync(info.path);
        // Um link apontando para fora da pasta da conta não serve.
        if (!real.startsWith(root + sep)) continue;
        if (!statSync(real).isFile()) continue;
        return { path: real, createParser: createGrokTerminalParser };
      } catch {
        // sumiu entre a listagem e a leitura
      }
    }
    return { status: 404, error: tr('sessão não encontrada') };
  }

  private summaryOf(c: Candidate): GrokSummary | undefined {
    const file = join(c.dir, 'summary.json');
    let mtimeMs: number;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      this.cache.delete(c.dir);
      return undefined;
    }
    const hit = this.cache.get(c.dir);
    if (hit && hit.mtimeMs === mtimeMs) return hit.summary;
    const read = readSummary(c.dir);
    this.cache.set(c.dir, { mtimeMs, summary: read?.summary });
    return read?.summary;
  }
}
