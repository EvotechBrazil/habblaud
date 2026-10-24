// A cota do Grok lida no fim do logs/unified.jsonl: a linha de cobrança (dados sintéticos no formato real), o
// leitor pelo fim do arquivo (sem carregar tudo) e o leitor com memória (só reabre quando o arquivo muda).
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { createBillingReader, latestBillingIn, parseBillingLine, parseGrokUsagePost, readLatestBilling, readTail, UNIFIED_LOG, usageFromBilling } from './billing';

const TS = '2026-10-24T22:26:59.302Z';
const AT = Date.parse(TS);
const START = '2026-10-21T20:05:38.827602+00:00';
const END = '2026-10-28T20:05:38.827602+00:00';

function billingLine(percent: number, o: { ts?: string; tier?: string | null; period?: boolean } = {}): string {
  const config: Record<string, unknown> = { creditUsagePercent: percent, onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 }, isUnifiedBillingUser: true, historyLen: 0 };
  if (o.period !== false) {
    config.currentPeriod = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: START, end: END };
    config.billingPeriodStart = START;
    config.billingPeriodEnd = END;
  }
  const ctx: Record<string, unknown> = { config, onDemandEnabled: null };
  if (o.tier !== null) ctx.subscriptionTier = o.tier ?? 'SuperGrok Heavy';
  return JSON.stringify({ ts: o.ts ?? TS, src: 'shell', pid: 77150, ver: '1.0.67', lvl: 'info', msg: 'billing: fetched credits config', ctx });
}

const OTHER = JSON.stringify({ ts: TS, src: 'grok-pager', pid: 77150, lvl: 'info', msg: 'prompt.drain', ctx: { kind: 'prompt', remaining_in_queue: 0 } });

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function home(): string {
  const tmp = tempDir('habblaud-grok-billing-');
  cleanups.push(tmp.cleanup);
  mkdirSync(join(tmp.dir, 'logs'), { recursive: true });
  return tmp.dir;
}

describe('parseBillingLine', () => {
  it('a linha de cobrança vira a cota: percentual preso a 0–100, período e plano quando existem', () => {
    expect(parseBillingLine(billingLine(15))).toEqual({ fetchedAt: AT, weeklyUsedPercent: 15, periodStart: Date.parse(START), periodEnd: Date.parse(END), plan: 'SuperGrok Heavy' });
    expect(parseBillingLine(billingLine(130, { tier: null, period: false }))).toEqual({ fetchedAt: AT, weeklyUsedPercent: 100 });
    expect(parseBillingLine(billingLine(-3))?.weeklyUsedPercent).toBe(0);
  });

  it('outras linhas, JSON quebrado, sem percentual ou sem horário: nada', () => {
    expect(parseBillingLine(OTHER)).toBeUndefined();
    expect(parseBillingLine('')).toBeUndefined();
    expect(parseBillingLine('{"msg":"billing: fetched credits config"')).toBeUndefined();
    expect(parseBillingLine(JSON.stringify({ ts: TS, msg: 'billing: fetched credits config', ctx: { config: {} } }))).toBeUndefined();
    expect(parseBillingLine(JSON.stringify({ ts: 'ontem', msg: 'billing: fetched credits config', ctx: { config: { creditUsagePercent: 1 } } }))).toBeUndefined();
    // A mensagem como texto de outra linha não engana.
    expect(parseBillingLine(JSON.stringify({ ts: TS, msg: 'x', note: 'billing: fetched credits config' }))).toBeUndefined();
  });
});

describe('parseGrokUsagePost e usageFromBilling', () => {
  it('valida o campo `usage` do auxiliar (textos curtos, números) e monta só a janela semanal', () => {
    const post = parseGrokUsagePost({ fetchedAt: AT, weeklyUsedPercent: 15.5, periodStart: 1, periodEnd: 2, plan: 'SuperGrok Heavy', extra: 'x' });
    expect(post).toEqual({ fetchedAt: AT, weeklyUsedPercent: 15.5, periodStart: 1, periodEnd: 2, plan: 'SuperGrok Heavy' });
    expect(parseGrokUsagePost({ fetchedAt: AT, weeklyUsedPercent: 250, plan: 'x'.repeat(200) })).toEqual({ fetchedAt: AT, weeklyUsedPercent: 100 });
    expect(parseGrokUsagePost({ weeklyUsedPercent: 1 })).toBeUndefined();
    expect(parseGrokUsagePost({ fetchedAt: 0, weeklyUsedPercent: 1 })).toBeUndefined();
    expect(parseGrokUsagePost('x')).toBeUndefined();
    expect(usageFromBilling({ fetchedAt: AT, weeklyUsedPercent: 15, periodEnd: 2 })).toEqual({ source: 'grok', sevenDay: { utilization: 15, resetsAt: 2 }, fetchedAt: AT });
    expect(usageFromBilling({ fetchedAt: AT, weeklyUsedPercent: 15 })).toEqual({ source: 'grok', sevenDay: { utilization: 15 }, fetchedAt: AT });
  });
});

describe('leitura pelo fim do arquivo', () => {
  it('readTail lê só os últimos bytes; latestBillingIn pega a linha de cobrança mais recente, ignorando a cortada no início', () => {
    const h = home();
    const path = join(h, UNIFIED_LOG);
    writeFileSync(path, [billingLine(12, { ts: '2026-10-23T10:00:00.000Z' }), OTHER, billingLine(13, { ts: '2026-10-23T11:00:00.000Z' }), OTHER, ''].join('\n'));
    expect(readTail(path, 5)).toBe(OTHER.slice(-4) + '\n');
    expect(readTail(join(h, 'nao-existe'), 5)).toBeUndefined();
    // Trecho que começa no meio da primeira linha de cobrança: ela não conta; a segunda, inteira, sim.
    const text = ['a' + billingLine(12).slice(10), billingLine(13, { ts: '2026-10-23T11:00:00.000Z' }), OTHER].join('\n');
    expect(latestBillingIn(text)?.weeklyUsedPercent).toBe(13);
    expect(latestBillingIn([OTHER, OTHER].join('\n'))).toBeUndefined();
  });

  it('readLatestBilling: a última cota do log da pasta (ou nada sem o log); lendo só o fim', () => {
    const h = home();
    expect(readLatestBilling(h)).toBeUndefined();
    const path = join(h, UNIFIED_LOG);
    writeFileSync(path, billingLine(12, { ts: '2026-10-23T10:00:00.000Z' }) + '\n');
    // Muito ruído depois: com um trecho curto demais, a linha de cobrança fica fora do alcance.
    appendFileSync(path, Array.from({ length: 50 }, () => OTHER).join('\n') + '\n');
    expect(readLatestBilling(h)?.weeklyUsedPercent).toBe(12);
    expect(readLatestBilling(h, 200)).toBeUndefined();
    appendFileSync(path, billingLine(15) + '\n');
    expect(readLatestBilling(h, 2_000)).toMatchObject({ weeklyUsedPercent: 15, fetchedAt: AT });
  });

  it('createBillingReader: só reabre quando o arquivo muda e lembra a última cota vista', () => {
    const h = home();
    const path = join(h, UNIFIED_LOG);
    const read = createBillingReader(2_000);
    expect(read(h)).toBeUndefined();
    writeFileSync(path, billingLine(12, { ts: '2026-10-23T10:00:00.000Z' }) + '\n');
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    expect(read(h)?.weeklyUsedPercent).toBe(12);
    // Mesmo tamanho e mtime: não relê (o conteúdo trocado por baixo não é visto).
    writeFileSync(path, billingLine(99, { ts: '2026-10-23T10:00:00.000Z' }) + '\n');
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    expect(read(h)?.weeklyUsedPercent).toBe(12);
    // Arquivo cresceu: relê. Só ruído no fim do trecho lido: fica a última cota conhecida.
    appendFileSync(path, billingLine(15) + '\n');
    utimesSync(path, 1_700_000_100, 1_700_000_100);
    expect(read(h)?.weeklyUsedPercent).toBe(15);
    appendFileSync(path, Array.from({ length: 40 }, () => OTHER).join('\n') + '\n');
    utimesSync(path, 1_700_000_200, 1_700_000_200);
    expect(read(h)?.weeklyUsedPercent).toBe(15);
  });
});
