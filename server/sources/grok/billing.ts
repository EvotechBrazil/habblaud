// A cota do Grok. O Grok não grava um arquivo de uso, mas, enquanto alguma sessão roda, consulta a cobrança a cada
// poucos minutos e registra a resposta no log dele, <GROK_HOME>/logs/unified.jsonl, numa linha JSON com
// `"msg":"billing: fetched credits config"`:
//   ctx.config.creditUsagePercent   percentual usado do período (a ÚNICA janela: o plano do Grok é semanal, sem
//                                   sessão de 5 h);
//   ctx.config.currentPeriod        {type: "USAGE_PERIOD_TYPE_WEEKLY", start, end} (ISO);
//   ctx.subscriptionTier            o plano ("SuperGrok Heavy"...).
// Este módulo lê SÓ o fim do log (ele cresce sem rotação e tem de tudo) e só essa linha. Node puro, sem dependências
// do servidor: o auxiliar do host (scripts/codex-bridge.ts, npm run bridge) o usa para mandar a cota ao container,
// que não monta logs/ (POST /api/grok/registry, campo `usage`); fora do Docker a fonte do Grok lê o log direto.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountUsage } from '../../../shared/types';

/** Arquivo de log do Grok, relativo ao GROK_HOME. */
export const UNIFIED_LOG = join('logs', 'unified.jsonl');
/** Quanto do fim do log é lido por vez (a linha de cobrança sai a cada poucos minutos; 256 KB cobrem horas). */
export const BILLING_TAIL_BYTES = 256 * 1024;
const BILLING_MSG = '"billing: fetched credits config"';

/** A cota do Grok como vai pela rede (auxiliar → container) e como a fonte a guarda: só números e textos curtos. */
export interface GrokUsagePost {
  /** Horário da linha do log (epoch ms): quando o Grok leu a cota. */
  fetchedAt: number;
  /** Percentual usado do período, 0–100. */
  weeklyUsedPercent: number;
  /** Início e fim do período (epoch ms), quando o log os traz. */
  periodStart?: number;
  periodEnd?: number;
  /** O plano (ctx.subscriptionTier), quando o log o traz. */
  plan?: string;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown, max = 80): string | undefined {
  return typeof v === 'string' && v.trim() && v.trim().length <= max ? v.trim() : undefined;
}

/** ISO (ou epoch ms) → epoch ms; undefined se não for data. */
function epochMs(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : undefined;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Uma linha do unified.jsonl → a cota, se for a linha de cobrança com o percentual. Qualquer outra linha (ou JSON
 * quebrado) → undefined. O percentual é preso a 0–100.
 */
export function parseBillingLine(line: string): GrokUsagePost | undefined {
  if (!line.includes(BILLING_MSG)) return undefined;
  let j: Rec | undefined;
  try {
    j = rec(JSON.parse(line));
  } catch {
    return undefined;
  }
  if (!j || j.msg !== 'billing: fetched credits config') return undefined;
  const ctx = rec(j.ctx);
  const config = rec(ctx?.config);
  const percent = num(config?.creditUsagePercent);
  const fetchedAt = epochMs(j.ts);
  if (percent === undefined || fetchedAt === undefined) return undefined;
  const out: GrokUsagePost = { fetchedAt, weeklyUsedPercent: Math.min(100, Math.max(0, percent)) };
  const period = rec(config?.currentPeriod);
  const start = epochMs(period?.start ?? config?.billingPeriodStart);
  const end = epochMs(period?.end ?? config?.billingPeriodEnd);
  if (start !== undefined) out.periodStart = start;
  if (end !== undefined) out.periodEnd = end;
  const plan = str(ctx?.subscriptionTier);
  if (plan) out.plan = plan;
  return out;
}

/** O campo `usage` de POST /api/grok/registry (ou o que a fonte guardou) validado; inválido → undefined (nunca lança). */
export function parseGrokUsagePost(raw: unknown): GrokUsagePost | undefined {
  const r = rec(raw);
  const fetchedAt = num(r?.fetchedAt);
  const percent = num(r?.weeklyUsedPercent);
  if (!r || fetchedAt === undefined || fetchedAt <= 0 || percent === undefined) return undefined;
  const out: GrokUsagePost = { fetchedAt, weeklyUsedPercent: Math.min(100, Math.max(0, percent)) };
  const start = num(r.periodStart);
  const end = num(r.periodEnd);
  if (start !== undefined && start > 0) out.periodStart = start;
  if (end !== undefined && end > 0) out.periodEnd = end;
  const plan = str(r.plan);
  if (plan) out.plan = plan;
  return out;
}

/** A cota do Grok no formato das contas (só a janela semanal; `fetchedAt` = o horário da linha do log). */
export function usageFromBilling(b: GrokUsagePost): AccountUsage {
  const sevenDay: AccountUsage['sevenDay'] = { utilization: b.weeklyUsedPercent };
  if (b.periodEnd !== undefined) sevenDay.resetsAt = b.periodEnd;
  return { source: 'grok', sevenDay, fetchedAt: b.fetchedAt };
}

/** Os últimos `bytes` do arquivo como texto (ou tudo, se for menor); undefined sem o arquivo. */
export function readTail(path: string, bytes: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = statSync(path).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, size - len);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** A última linha de cobrança de um texto (a mais recente vence; uma linha cortada no início do trecho é ignorada). */
export function latestBillingIn(text: string): GrokUsagePost | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const b = parseBillingLine(lines[i]);
    if (b) return b;
  }
  return undefined;
}

/** A última cota registrada no unified.jsonl de uma pasta do Grok (lendo só o fim do arquivo); undefined sem ela. */
export function readLatestBilling(home: string, tailBytes = BILLING_TAIL_BYTES): GrokUsagePost | undefined {
  const text = readTail(join(home, UNIFIED_LOG), tailBytes);
  return text ? latestBillingIn(text) : undefined;
}

/**
 * Leitor com memória por pasta: só reabre o log quando o tamanho ou o mtime mudou (um `stat` por rodada, a cada 2 s,
 * é barato; reler 256 KB não seria). Devolve a última cota conhecida da pasta (ou undefined).
 */
export function createBillingReader(tailBytes = BILLING_TAIL_BYTES): (home: string) => GrokUsagePost | undefined {
  const memo = new Map<string, { size: number; mtimeMs: number; usage?: GrokUsagePost }>();
  return (home) => {
    const path = join(home, UNIFIED_LOG);
    let size: number;
    let mtimeMs: number;
    try {
      ({ size, mtimeMs } = statSync(path));
    } catch {
      memo.delete(home);
      return undefined;
    }
    const m = memo.get(home);
    if (m && m.size === size && m.mtimeMs === mtimeMs) return m.usage;
    const usage = readLatestBilling(home, tailBytes) ?? m?.usage;
    memo.set(home, { size, mtimeMs, usage });
    return usage;
  };
}
