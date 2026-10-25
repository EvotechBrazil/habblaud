// Histórico do terminal do Grok: listagem das sessões recentes (pelo summary.json) e a sessão resolvida com segurança.
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../../log';
import { FIXTURE_CWD, G, grokHome, sessionId } from '../../test/grok-fixtures';
import { symlinkOrSkip } from '../../test/fixtures';
import { GrokHistory } from './history';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const [A, B, OLD] = [1, 2, 3].map(sessionId);

function setup() {
  const home = grokHome();
  cleanups.push(home.cleanup);
  const now = Date.now();
  const open = new Set<string>();
  const history = new GrokHistory({
    accounts: () => [{ id: '.grok', dir: home.dir }],
    openAgentOf: (acc, sid) => (open.has(sid) ? `${acc}:${sid}` : undefined),
    now: () => now,
  });
  return { home, history, now, open };
}

describe('histórico do Grok', () => {
  it('lista as sessões dos últimos 7 dias com título, projeto e horários do summary.json; a aberta leva o agente', async () => {
    const { home, history, now, open } = setup();
    home.session(A, [G.user(A, 'a', { at: now - 60_000 })], { summary: { title: 'Testes da loja', createdAt: now - 120_000, lastActiveAt: now - 5_000 } });
    home.session(B, [G.user(B, 'b', { at: now - 3_600_000 })], { cwd: '/projetos/outro', summary: { title: 'Outro', cwd: '/projetos/outro', createdAt: now - 7_200_000, lastActiveAt: now - 3_600_000 }, mtime: now - 3_600_000 });
    home.session(OLD, [G.user(OLD, 'velha', { at: now - 30 * 86_400_000 })], { mtime: now - 30 * 86_400_000 });
    // Sessão sem summary.json: entra com o que a pasta diz.
    const C = sessionId(4);
    home.session(C, [G.user(C, 'c', { at: now - 10_000 })], { summary: false, mtime: now - 10_000 });
    open.add(A);
    const list = await history.list();
    expect(list.map((s) => [s.sessionId, s.provider, s.project, s.title, s.open, s.agentId])).toEqual([
      [A, 'grok', FIXTURE_CWD, 'Testes da loja', true, `.grok:${A}`],
      [C, 'grok', FIXTURE_CWD, undefined, false, undefined],
      [B, 'grok', '/projetos/outro', 'Outro', false, undefined],
    ]);
    expect(list[0]).toMatchObject({ account: '.grok', firstAt: now - 120_000, lastAt: now - 5_000, projectDir: '-projetos-loja' });
    expect(list[1].lastAt).toBeCloseTo(now - 10_000, -3);
    expect(history.hasAccount('.grok')).toBe(true);
    expect(history.hasAccount('.claude')).toBe(false);
  });

  it('resolve: id inválido 400; conta ou sessão desconhecida 404; link para fora da pasta não vale', (t) => {
    const { home, history, now } = setup();
    const path = home.session(A, [G.user(A, 'a', { at: now })]);
    expect(history.resolve('.grok', 'nope')).toEqual({ status: 400, error: 'id de sessão inválido' });
    expect(history.resolve('.claude', A)).toEqual({ status: 404, error: 'conta desconhecida' });
    expect(history.resolve('.grok', B)).toEqual({ status: 404, error: 'sessão não encontrada' });
    const r = history.resolve('.grok', A.toUpperCase());
    expect('path' in r && r.path).toBe(realpathSync(path));
    expect('createParser' in r && r.createParser()).toBeDefined();
    // Um updates.jsonl que é link para fora da pasta da conta: 404.
    const outside = join(home.home, 'fora.jsonl');
    writeFileSync(outside, G.user(B, 'x'));
    const dir = home.sessionDir(B);
    mkdirSync(dir, { recursive: true });
    symlinkOrSkip(t.skip, outside, join(dir, 'updates.jsonl'));
    expect(history.resolve('.grok', B)).toEqual({ status: 404, error: 'sessão não encontrada' });
  });
});
