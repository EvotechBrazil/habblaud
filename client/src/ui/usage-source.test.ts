import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../../shared/types';
import { cardState, codexUsageNote, grokUsageNote, showsUsageAge, sourceLabel, usageMessage, usageSubtitle } from './usage';

const MIN = 60_000;
type Acc = Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider' | 'email' | 'plan' | 'configDir'>;
const codex = (over: Partial<Acc> = {}): Acc => ({ provider: 'codex', usageStatus: 'ok', configDir: '~/.codex', plan: 'Team', ...over });
const win = { utilization: 42, resetsAt: 10 * 60 * MIN };

describe('sourceLabel', () => {
  it('diz quem gravou o uso ao vivo', () => {
    expect(sourceLabel({ source: 'statusline', via: 'mod', fetchedAt: 0 })).toBe('ao vivo (mod do Habblaud)');
    expect(sourceLabel({ source: 'statusline', via: 'tap', fetchedAt: 0 })).toBe('ao vivo (statusline do Claude Code)');
    expect(sourceLabel({ source: 'statusline', fetchedAt: 0 })).toBe('ao vivo (statusline do Claude Code)');
    expect(sourceLabel({ source: 'cache', fetchedAt: 0 })).toBe('cache do /usage do Claude Code');
    expect(sourceLabel({ source: 'codex', fetchedAt: 0 })).toBe('arquivos do Codex');
    expect(sourceLabel({ source: 'grok', fetchedAt: 0 })).toBe('log de cobrança do Grok');
  });
});

describe('cartão de uso de uma conta do Codex', () => {
  it('"sem cota" é um estado próprio (nunca 0% nem "sem dados")', () => {
    const noQuota = codex({ usage: { source: 'codex', noQuota: true, fetchedAt: 0 } });
    expect(cardState(noQuota)).toBe('noquota');
    expect(usageMessage(noQuota)).toEqual(['sem cota', 'sem cota']);
    expect(codexUsageNote(noQuota, 3 * MIN)).toMatch(/^Na última leitura \(há 3 min\), a conta estava sem cota nem créditos .*Não é 0%/);
    expect(cardState(codex({ usage: { source: 'codex', fiveHour: win, fetchedAt: 0 } }))).toBe('ok');
    expect(cardState(codex({ usage: { source: 'codex', fiveHour: win, fetchedAt: 0 }, usageStatus: 'stale' }))).toBe('stale');
    expect(cardState(codex())).toBe('empty');
  });

  it('a idade fica sempre à mostra no Codex (só se renova com sessão rodando); no Claude Code, só quando é antiga', () => {
    const fresh = { source: 'codex' as const, fiveHour: win, fetchedAt: 0 };
    expect(showsUsageAge(codex({ usage: fresh }))).toBe(true);
    expect(showsUsageAge(codex({ usage: { source: 'codex', noQuota: true, fetchedAt: 0 } }))).toBe(true);
    expect(showsUsageAge(codex())).toBe(false);
    expect(showsUsageAge({ usage: { ...fresh, source: 'statusline' }, usageStatus: 'ok' })).toBe(false);
    expect(showsUsageAge({ usage: { ...fresh, source: 'cache' }, usageStatus: 'stale' })).toBe(true);
    expect(codexUsageNote(codex({ usage: fresh }), 12 * MIN)).toBe('O Codex só grava o uso enquanto alguma sessão roda: estes números são da última leitura (há 12 min).');
  });

  it('sem números: não há o que instalar; embaixo do nome, o plano (sem e-mail)', () => {
    expect(usageMessage(codex())).toEqual(['sem dados ainda', 'sem dados']);
    expect(codexUsageNote(codex(), 0)).toBe('Não precisa instalar nada: os números chegam com a próxima sessão do Codex.');
    expect(usageSubtitle(codex())).toBe('plano Team');
    expect(usageSubtitle(codex({ plan: undefined }))).toBe('Codex');
    // Claude Code: como antes.
    expect(usageMessage({ usageStatus: 'disabled' })).toEqual(['sem dados de uso', 'sem dados']);
    expect(usageSubtitle({ email: 'a@b.c', configDir: '~/.claude' })).toBe('a@b.c');
    expect(usageSubtitle({ configDir: '~/.claude' })).toBe('~/.claude');
    expect(codexUsageNote({ usageStatus: 'ok' }, 0)).toBe('');
  });
});

describe('cartão de uso de uma conta do Grok', () => {
  const grok = (over: Partial<Acc> = {}): Acc => ({ provider: 'grok', usageStatus: 'ok', configDir: '~/.grok', ...over });
  const weekly = { source: 'grok' as const, sevenDay: { utilization: 15, resetsAt: 7 * 24 * 60 * MIN }, fetchedAt: 0 };

  it('só a semana: com a cota é "ok"/"stale" e a idade fica à mostra; sem ela, "sem dados ainda" e nada a instalar', () => {
    expect(cardState(grok({ usage: weekly }))).toBe('ok');
    expect(cardState(grok({ usage: weekly, usageStatus: 'stale' }))).toBe('stale');
    expect(cardState(grok())).toBe('empty');
    expect(showsUsageAge(grok({ usage: weekly }))).toBe(true);
    expect(showsUsageAge(grok())).toBe(false);
    expect(usageMessage(grok())).toEqual(['sem dados ainda', 'sem dados']);
    expect(grokUsageNote(grok(), 0)).toBe('Não precisa instalar nada: a cota semanal vem do log do Grok e chega com a próxima sessão dele (no Docker, pelo `npm run bridge`).');
    expect(grokUsageNote(grok({ usage: weekly }), 12 * MIN)).toBe('O Grok só tem a cota semanal (o plano dele não tem sessão de 5 h) e só a registra enquanto alguma sessão roda: este número é da última leitura (há 12 min).');
    expect(grokUsageNote(codex(), 0)).toBe('');
    expect(usageSubtitle(grok({ plan: 'SuperGrok Heavy' }))).toBe('plano SuperGrok Heavy');
    expect(usageSubtitle(grok())).toBe('Grok');
  });
});
