// Integração da fonte do Grok: um GROK_HOME temporário (active_sessions.json, sessões reais anonimizadas e linhas
// sintéticas), o AccountsService e o Office.
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo, Notice } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { FIXTURE_CWD, FIXTURE_IDS, G, grokHome, sessionId } from '../../test/grok-fixtures';
import { BILLING_POLL_MS, BRIDGE_REGISTRY_TTL_MS, FALLBACK_RECENT_MS, GrokSource, HOOK_PRESENCE_MS, SESSION_END_GRACE_MS, STALE_HOOK_MS, WORKING_QUIET_MS } from './source';

setQuiet(true);

const S = sessionId(1);
const KEY = `.grok:${S}`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function setup(opts: { names?: string[]; checkPid?: boolean; alive?: Set<number>; env?: (dirs: string[]) => NodeJS.ProcessEnv } = {}) {
  const homes = (opts.names ?? ['.grok']).map((n) => grokHome(n));
  const home = homes[0];
  cleanups.push(...homes.map((h) => h.cleanup));
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: home.home, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const dirs = homes.map((h) => h.dir);
  const alive = opts.alive ?? new Set([process.pid]);
  const source = new GrokSource({ accounts, office, dirs, env: opts.env?.(dirs) ?? {}, home: home.home, now, watch: false, checkPid: opts.checkPid ?? true, isAlive: (pid) => alive.has(pid) });
  cleanups.unshift(() => source.stop());
  const notices: Notice[] = [];
  return {
    home,
    homes,
    accounts,
    office,
    source,
    notices,
    alive,
    advance(ms: number) {
      clock += ms;
    },
    now,
    poll() {
      source.poll();
      office.tick();
      notices.push(...office.commit().notices);
    },
    agents(): AgentInfo[] {
      return office.commit().snapshot.agents;
    },
    agent(id = KEY): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
    hook(input: Record<string, unknown>, account?: string): boolean {
      return source.applyHookEvent(account, input);
    },
  };
}

describe('fonte do Grok: presença pelo active_sessions.json', () => {
  it('sessão registrada + updates.jsonl: agente principal na sala do projeto, com título, modelo, branch, tokens e status', async () => {
    const ctx = setup();
    const t0 = ctx.now();
    const path = ctx.home.session(S, [G.user(S, 'Rode os testes da loja', { at: t0 - 50_000 }), G.toolCall(S, 'c1', 'run_terminal_command', { command: 'npm test' }, { at: t0 - 49_000 }), G.toolDone(S, 'c1', { at: t0 - 48_000, exitCode: 0, command: 'npm test' })], {
      summary: { title: 'Testes da loja', model: 'grok-4.6', branch: 'feat/x', createdAt: t0 - 60_000 },
    });
    ctx.home.active([{ id: S, openedAt: t0 - 60_000 }]);
    ctx.source.boot();
    await ctx.source.idle();
    const a = ctx.agent()!;
    expect(a).toMatchObject({
      kind: 'main',
      provider: 'grok',
      account: '.grok',
      sessionId: S,
      roomId: FIXTURE_CWD,
      role: 'Agente principal (Grok)',
      status: 'working',
      title: 'Testes da loja',
      model: 'grok-4.6',
      gitBranch: 'feat/x',
      startedAt: t0 - 60_000,
    });
    expect(a.stats).toMatchObject({ toolCalls: 1, tokensIn: 0 });
    expect(a.activity?.text).toBe('Rodando testes');
    expect(ctx.source.sources()).toEqual([{ label: '.grok', provider: 'grok', path: ctx.home.dir, sessions: 1, ok: true }]);
    expect(ctx.source.transcriptPathOf(KEY)).toBe(path);
    expect(ctx.source.terminalParser(KEY)).toBeDefined();
    expect(ctx.accounts.list(new Map())[0]).toMatchObject({ id: '.grok', provider: 'grok', name: 'Grok', short: 'G' });

    // Turno concluído: ociosa, com os tokens do turno.
    ctx.advance(1_000);
    ctx.home.append(path, [G.agent(S, 'Todos passaram.', { at: ctx.now() }), G.turnCompleted(S, { at: ctx.now() + 1, input: 2_000, output: 300 })]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.agent()?.activity?.kind).toBe('done');
    expect(ctx.agent()?.stats).toMatchObject({ tokensIn: 2_000, tokensOut: 300 });

    // Fora do registro: fecha (depois da folga).
    ctx.home.active([]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
  });

  it('sessão real anonimizada: entra com os números do arquivo e o título do summary.json', async () => {
    const ctx = setup();
    const { id } = ctx.home.fixture('curta');
    ctx.home.active([{ id }]);
    ctx.source.boot();
    await ctx.source.idle();
    const a = ctx.agent(`.grok:${id}`)!;
    expect(a).toMatchObject({ provider: 'grok', roomId: FIXTURE_CWD, title: 'Rodar os testes da loja', model: 'grok-4.6-build', status: 'idle' });
    expect(a.stats).toMatchObject({ toolCalls: 2, tokensIn: 53_718, tokensOut: 499 });
    expect(a.recent.map((x) => x.kind)).toContain('read');
  });

  it('PID morto fora do Docker: a entrada não conta; no Docker (sem conferir PID) conta', () => {
    const dead = setup({ alive: new Set() });
    dead.home.session(S, [G.user(S, 'a', { at: dead.now() })]);
    dead.home.active([{ id: S, pid: 999_999 }]);
    dead.source.boot();
    expect(dead.agent()).toBeUndefined();
    expect(dead.source.sources()[0].sessions).toBe(0);
    const docker = setup({ alive: new Set(), checkPid: false });
    docker.home.session(S, [G.user(S, 'a', { at: docker.now() })]);
    docker.home.active([{ id: S, pid: 999_999 }]);
    docker.source.boot();
    expect(docker.agent()?.status).toBe('working');
  });

  it('sessão registrada sem pasta ainda: entra pelo cwd do registro; o summary.json chega depois', () => {
    const ctx = setup();
    ctx.home.active([{ id: S, cwd: '/projetos/outro' }]);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({ roomId: '/projetos/outro', status: 'idle' });
    expect(ctx.agent()?.title).toBeUndefined();
    ctx.advance(4_000);
    ctx.home.session(S, [G.user(S, 'Oi', { at: ctx.now() })], { cwd: '/projetos/outro', summary: { title: 'Conversa nova', cwd: '/projetos/outro' } });
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ roomId: '/projetos/outro', status: 'working', title: 'Conversa nova' });
  });

  it("'working' sem nenhuma notícia por muito tempo vira 'idle' (turno morto)", () => {
    const ctx = setup();
    const path = ctx.home.session(S, [G.user(S, 'a', { at: ctx.now() - 2 * WORKING_QUIET_MS })]);
    ctx.home.touch(path, ctx.now() - 2 * WORKING_QUIET_MS);
    ctx.home.active([{ id: S }]);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('duas contas (~/.grok e ~/.grok-trabalho): ids e letras próprios', () => {
    const ctx = setup({ names: ['.grok', '.grok-trabalho'] });
    const T = sessionId(2);
    ctx.homes[0].session(S, [G.user(S, 'a', { at: ctx.now() })]);
    ctx.homes[0].active([{ id: S }]);
    ctx.homes[1].session(T, [G.user(T, 'b', { at: ctx.now() })]);
    ctx.homes[1].active([{ id: T }]);
    ctx.source.boot();
    expect(ctx.agents().map((a) => [a.id, a.account]).sort()).toEqual([
      ['.grok-trabalho:' + T, '.grok-trabalho'],
      [KEY, '.grok'],
    ]);
    expect(ctx.accounts.list(new Map()).map((a) => [a.id, a.short, a.name])).toEqual([
      ['.grok', 'G', 'Grok G'],
      ['.grok-trabalho', 'T', 'Grok T'],
    ]);
  });
});

describe('fonte do Grok: sem o registro (Docker)', () => {
  it('updates.jsonl modificado há pouco = aberta; parado há mais de 30 min = fechada', () => {
    const ctx = setup({ checkPid: false });
    ctx.home.noActive();
    const path = ctx.home.session(S, [G.user(S, 'a', { at: ctx.now() - 5_000 })]);
    ctx.home.touch(path, ctx.now() - 5_000);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({ roomId: FIXTURE_CWD, status: 'working' });
    ctx.advance(FALLBACK_RECENT_MS + 15_000);
    ctx.poll();
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
  });

  it('sessão aberta por hook (SessionStart) fica sem o registro até o SessionEnd ou 12 h paradas', () => {
    const ctx = setup({ checkPid: false });
    ctx.home.noActive();
    ctx.home.session(S, [G.user(S, 'a', { at: ctx.now() - 3_600_000 })], { mtime: ctx.now() - 3_600_000 });
    ctx.source.boot();
    expect(ctx.agent()).toBeUndefined();
    expect(ctx.hook({ hook_event_name: 'SessionStart', session_id: S, cwd: FIXTURE_CWD })).toBe(true);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    // Muito depois do HOOK_PRESENCE_MS, ainda presente (aberta por hook).
    ctx.advance(HOOK_PRESENCE_MS * 5);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    ctx.hook({ hook_event_name: 'SessionEnd', session_id: S, cwd: FIXTURE_CWD });
    ctx.poll();
    ctx.advance(SESSION_END_GRACE_MS + 2_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
    // Sem SessionEnd: sai sozinha depois de STALE_HOOK_MS sem nada novo.
    const quiet = setup({ checkPid: false });
    quiet.home.noActive();
    quiet.hook({ hook_event_name: 'SessionStart', session_id: S, cwd: FIXTURE_CWD });
    quiet.poll();
    expect(quiet.agent()?.status).toBe('idle');
    quiet.advance(STALE_HOOK_MS + 60_000);
    quiet.poll();
    quiet.advance(2_000);
    quiet.poll();
    expect(quiet.agent()?.status).toBe('offline');
  });
});

describe('fonte do Grok: registro mandado pelo auxiliar do host (Docker)', () => {
  it('a lista do auxiliar vale como registro: sessão TUI parada há horas fica no escritório e sai quando some da lista', () => {
    const ctx = setup({ checkPid: false });
    ctx.home.noActive();
    const t0 = ctx.now();
    const quietFor = 20 * 3600_000; // fora dos 30 min do modo "recente" e das 12 h de uma sessão aberta por hook
    ctx.home.session(S, [G.user(S, 'a', { at: t0 - quietFor }), G.turnCompleted(S, { at: t0 - quietFor + 1_000, input: 10, output: 5 })], { mtime: t0 - quietFor });
    ctx.source.boot();
    expect(ctx.agent()).toBeUndefined();
    expect(ctx.source.applyRegistry('.grok', [{ sessionId: S, pid: 4242, pidStart: 1, cwd: FIXTURE_CWD, openedAt: t0 - quietFor - 60_000 }])).toBe(true);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ provider: 'grok', roomId: FIXTURE_CWD, status: 'idle' });
    expect(ctx.source.sources()[0]).toMatchObject({ sessions: 1, ok: true });
    // Horas depois, o auxiliar segue mandando a mesma lista: continua (nenhum arquivo mudou).
    ctx.advance(3 * 3600_000);
    ctx.source.applyRegistry(ctx.home.dir, [{ sessionId: S, pid: 4242, cwd: FIXTURE_CWD }]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    // O processo fechou: a lista vem sem ela e o agente sai depois da folga.
    ctx.source.applyRegistry('.grok', []);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
  });

  it('auxiliar parado: a lista expira e a presença volta ao modo sem registro (recente fica, antiga sai)', () => {
    const ctx = setup({ checkPid: false });
    ctx.home.noActive();
    const t0 = ctx.now();
    const old = sessionId(2);
    ctx.home.session(S, [G.user(S, 'a', { at: t0 - 5_000 })], { mtime: t0 - 5_000 });
    ctx.home.session(old, [G.user(old, 'b', { at: t0 - 20 * 3600_000 })], { mtime: t0 - 20 * 3600_000 });
    ctx.source.applyRegistry('.grok', [
      { sessionId: S, pid: 1, cwd: FIXTURE_CWD },
      { sessionId: old, pid: 2, cwd: FIXTURE_CWD },
    ]);
    ctx.source.boot();
    expect(ctx.agents().map((a) => a.sessionId).sort()).toEqual([S, old].sort());
    ctx.advance(BRIDGE_REGISTRY_TTL_MS + 1_000);
    ctx.poll();
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent()?.status).not.toBe('offline');
    expect(ctx.agent(`.grok:${old}`)?.status).toBe('offline');
  });

  it('o active_sessions.json lido aqui manda sobre a lista do auxiliar; conta desconhecida ou ausente é recusada', () => {
    const ctx = setup();
    ctx.home.session(S, [G.user(S, 'a', { at: ctx.now() })]);
    ctx.home.active([]);
    expect(ctx.source.applyRegistry('.grok', [{ sessionId: S, pid: 1, cwd: FIXTURE_CWD }])).toBe(true);
    ctx.source.boot();
    expect(ctx.agent()).toBeUndefined();
    expect(ctx.source.applyRegistry(undefined, [{ sessionId: S, pid: 1, cwd: FIXTURE_CWD }])).toBe(false);
    expect(ctx.source.applyRegistry('.grok-outra', [])).toBe(false);
    expect(ctx.source.applyRegistry('/pasta/que/nao/existe/.grok', [])).toBe(false);
    ctx.poll();
    expect(ctx.agent()).toBeUndefined();
  });
});

describe('fonte do Grok: eventos dos hooks', () => {
  it('UserPromptSubmit/PreToolUse/Stop mudam o status na hora; a ferramenta vira atividade com o mesmo id do arquivo', () => {
    const ctx = setup();
    const path = ctx.home.session(S, [G.user(S, 'a', { at: ctx.now() - 10_000 }), G.turnCompleted(S, { at: ctx.now() - 9_000 })]);
    ctx.home.active([{ id: S }]);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('idle');
    ctx.advance(1_000);
    expect(ctx.hook({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: FIXTURE_CWD, prompt: 'Suba' })).toBe(true);
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(1_000);
    expect(ctx.hook({ hook_event_name: 'PreToolUse', session_id: S, cwd: FIXTURE_CWD, tool_name: 'run_terminal_command', tool_input: { command: 'git push' }, tool_use_id: 'call-7' })).toBe(true);
    expect(ctx.agent()?.activity).toMatchObject({ id: `${KEY}#call-7`, kind: 'git' });
    // O arquivo grava a mesma chamada depois: não duplica.
    ctx.advance(1_000);
    ctx.home.append(path, [G.toolCall(S, 'call-7', 'run_terminal_command', { command: 'git push' }, { at: ctx.now() })]);
    ctx.poll();
    expect(ctx.agent()?.recent.filter((a) => a.id === `${KEY}#call-7`)).toHaveLength(1);
    // Chaves em camelCase (como o Grok também grava) valem.
    ctx.advance(1_000);
    expect(ctx.hook({ hook_event_name: 'PostToolUse', sessionId: S, cwd: FIXTURE_CWD, toolName: 'run_terminal_command', toolUseId: 'call-7' })).toBe(true);
    ctx.advance(1_000);
    expect(ctx.hook({ hook_event_name: 'Stop', session_id: S, cwd: FIXTURE_CWD })).toBe(true);
    expect(ctx.agent()?.status).toBe('idle');
    // Evento desconhecido, sessão inválida ou conta errada: ignorados.
    expect(ctx.hook({ hook_event_name: 'PreCompactX', session_id: S })).toBe(false);
    expect(ctx.hook({ hook_event_name: 'Stop', session_id: 'nope' })).toBe(false);
    expect(ctx.hook({ hook_event_name: 'Stop', session_id: S }, '/nao/existe')).toBe(true); // uma conta só: ela
  });

  it('Notification permission_prompt levanta a mão; idle_prompt baixa; uma ferramenta concluída também', () => {
    const ctx = setup();
    const path = ctx.home.session(S, [G.user(S, 'a', { at: ctx.now() - 1_000 })]);
    ctx.home.active([{ id: S }]);
    ctx.source.boot();
    ctx.advance(1_000);
    expect(ctx.hook({ hook_event_name: 'Notification', session_id: S, cwd: FIXTURE_CWD, notification_type: 'permission_prompt', message: 'Allow?' })).toBe(true);
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'aprovar uma permissão' });
    ctx.advance(1_000);
    ctx.home.append(path, [G.toolCall(S, 'c1', 'read_file', { target_file: '/p/a.ts' }, { at: ctx.now() }), G.toolDone(S, 'c1', { at: ctx.now() + 1 })]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(1_000);
    expect(ctx.hook({ hook_event_name: 'Notification', session_id: S, cwd: FIXTURE_CWD, notificationType: 'idle_prompt' })).toBe(true);
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('hook de uma sessão fora do registro (ex.: grok -p) segura o agente por um minuto; SessionEnd fecha', () => {
    const ctx = setup();
    ctx.home.active([]);
    ctx.source.boot();
    expect(ctx.hook({ hook_event_name: 'UserPromptSubmit', session_id: S, cwd: '/projetos/headless' })).toBe(true);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ roomId: '/projetos/headless', status: 'working' });
    ctx.advance(HOOK_PRESENCE_MS + 2_000);
    ctx.poll();
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
    // Registrada e com SessionEnd: fecha mesmo com a entrada ainda lá, depois da folga.
    const T = sessionId(2);
    ctx.home.session(T, [G.user(T, 'a', { at: ctx.now() })]);
    ctx.home.active([{ id: T }]);
    ctx.poll();
    expect(ctx.agent(`.grok:${T}`)?.status).toBe('working');
    ctx.hook({ hook_event_name: 'SessionEnd', session_id: T, cwd: FIXTURE_CWD });
    ctx.poll();
    expect(ctx.agent(`.grok:${T}`)?.status).toBe('working');
    ctx.advance(SESSION_END_GRACE_MS + 2_000);
    ctx.poll();
    expect(ctx.agent(`.grok:${T}`)?.status).toBe('offline');
  });

  it('SubagentStart conta um subagente e mostra a delegação', () => {
    const ctx = setup();
    ctx.home.session(S, [G.user(S, 'a', { at: ctx.now() - 1_000 })]);
    ctx.home.active([{ id: S }]);
    ctx.source.boot();
    ctx.advance(1_000);
    expect(ctx.hook({ hook_event_name: 'SubagentStart', session_id: S, cwd: FIXTURE_CWD, subagent_type: 'explore' })).toBe(true);
    expect(ctx.agent()?.stats.subagents).toBe(1);
    expect(ctx.agent()?.activity).toMatchObject({ kind: 'delegate', text: 'Delegando: explore' });
  });
});

describe('fonte do Grok: arquivos grandes', () => {
  it('a janela do fim entra no boot; o começo vem depois, em segundo plano, com os números e a linha do tempo longa', async () => {
    const ctx = setup();
    const t0 = ctx.now();
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(G.user(S, `Pedido ${i} ${'x'.repeat(2_000)}`, { at: t0 - 1_000_000 + i * 3_000, promptId: `p${i}` }));
      lines.push(G.toolCall(S, `c${i}`, 'read_file', { target_file: `/p/${i}.ts` }, { at: t0 - 1_000_000 + i * 3_000 + 1 }));
      lines.push(G.toolDone(S, `c${i}`, { at: t0 - 1_000_000 + i * 3_000 + 2 }));
      lines.push(G.turnCompleted(S, { at: t0 - 1_000_000 + i * 3_000 + 3, input: 10, output: 1, promptId: `p${i}` }));
    }
    ctx.home.session(S, lines, { summary: { title: 'Grande' } });
    ctx.home.active([{ id: S }]);
    const small = new GrokSource({ accounts: ctx.accounts, office: ctx.office, dirs: [ctx.home.dir], env: {}, home: ctx.home.home, now: ctx.now, watch: false, isAlive: () => true, tailBytes: 64 * 1024 });
    cleanups.unshift(() => small.stop());
    small.boot();
    const before = ctx.agent()!;
    expect(before.stats.toolCalls).toBeLessThan(300);
    expect(before.status).toBe('idle');
    await small.idle();
    const after = ctx.agent()!;
    expect(after.stats).toMatchObject({ toolCalls: 300, tokensIn: 3_000, tokensOut: 300 });
    expect(after.title).toBe('Grande');
    expect(ctx.office.detail(KEY)!.history.length).toBeGreaterThan(before.recent.length);
  });
});

describe('fonte do Grok: registro ilegível e sessão das fixtures', () => {
  it('active_sessions.json inválido = lista vazia (sem erro); ausente = modo sem registro', () => {
    const ctx = setup({ checkPid: false });
    ctx.home.session(S, [G.user(S, 'a', { at: ctx.now() })]);
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(`${ctx.home.dir}/active_sessions.json`, '{nope');
    ctx.source.boot();
    expect(ctx.source.sources()[0]).toMatchObject({ ok: true, sessions: 0 });
    expect(ctx.agent()).toBeUndefined();
  });

  it('a sessão média real: comandos e busca viram atividades com as ferramentas certas', async () => {
    const ctx = setup();
    const { id } = ctx.home.fixture('media');
    ctx.home.active([{ id }]);
    ctx.source.boot();
    await ctx.source.idle();
    const a = ctx.agent(`.grok:${id}`)!;
    expect(a.stats.toolCalls).toBe(6);
    const tools = ctx.office.detail(`.grok:${id}`)!.history.map((x) => x.tool).filter(Boolean);
    expect(tools).toEqual(expect.arrayContaining(['Bash', 'Grep', 'LS', 'Read']));
    expect(FIXTURE_IDS.media).toBe(id);
  });
});

describe('fonte do Grok: a cota semanal (log do Grok e auxiliar do host)', () => {
  // O fim do período fica no futuro (relativo ao relógio do teste): uma janela já renovada sai da leitura (rollover).
  const LINE = (percent: number, ts: string, end: string, tier = 'SuperGrok Heavy') =>
    JSON.stringify({ ts, src: 'shell', pid: 1, lvl: 'info', msg: 'billing: fetched credits config', ctx: { config: { creditUsagePercent: percent, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-21T20:05:38.827602+00:00', end } }, subscriptionTier: tier } });

  it('fora do Docker, lê a cota no fim de logs/unified.jsonl da conta (a cada BILLING_POLL_MS) e registra o plano', () => {
    const ctx = setup({ checkPid: false });
    ctx.home.noActive();
    ctx.source.boot();
    expect(ctx.accounts.usageView('.grok')).toEqual({ status: 'disabled' });
    const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    mkdirSync(join(ctx.home.dir, 'logs'), { recursive: true });
    const log = join(ctx.home.dir, 'logs', 'unified.jsonl');
    const t1 = new Date(ctx.now() - 60_000).toISOString();
    const end = new Date(ctx.now() + 3 * 86_400_000).toISOString();
    writeFileSync(log, LINE(15, t1, end) + '\n');
    // Ainda dentro do intervalo: não relê.
    ctx.advance(1_000);
    ctx.poll();
    expect(ctx.accounts.usageView('.grok').status).toBe('disabled');
    ctx.advance(BILLING_POLL_MS);
    ctx.poll();
    expect(ctx.accounts.usageView('.grok')).toMatchObject({ status: 'ok', usage: { source: 'grok', sevenDay: { utilization: 15, resetsAt: Date.parse(end) }, fetchedAt: Date.parse(t1) } });
    expect(ctx.accounts.usageView('.grok').usage?.fiveHour).toBeUndefined();
    expect(ctx.accounts.find('.grok')?.detected.plan).toBe('SuperGrok Heavy');
    // Linha nova no log: o número acompanha.
    const t2 = new Date(ctx.now()).toISOString();
    appendFileSync(log, LINE(16, t2, end) + '\n');
    ctx.advance(BILLING_POLL_MS);
    ctx.poll();
    expect(ctx.accounts.usageView('.grok').usage?.sevenDay?.utilization).toBe(16);
  });

  it('applyUsage (auxiliar, Docker): só a conta nomeada; vale a leitura mais recente, de onde vier', () => {
    const ctx = setup({ checkPid: false });
    ctx.home.noActive();
    ctx.source.boot();
    const at = ctx.now() - 30_000;
    expect(ctx.source.applyUsage(undefined, { fetchedAt: at, weeklyUsedPercent: 15 })).toBe(false);
    expect(ctx.source.applyUsage('.grok-outra', { fetchedAt: at, weeklyUsedPercent: 15 })).toBe(false);
    expect(ctx.source.applyUsage(ctx.home.dir, { fetchedAt: at, weeklyUsedPercent: 15, periodEnd: at + 3_600_000, plan: 'SuperGrok' })).toBe(true);
    expect(ctx.accounts.usageView('.grok')).toMatchObject({ status: 'ok', usage: { source: 'grok', sevenDay: { utilization: 15, resetsAt: at + 3_600_000 }, fetchedAt: at } });
    expect(ctx.accounts.find('.grok')?.detected.plan).toBe('SuperGrok');
    // Uma leitura mais velha não volta o número; uma mais nova, sim (e o plano muda junto).
    expect(ctx.source.applyUsage('.grok', { fetchedAt: at - 1, weeklyUsedPercent: 90 })).toBe(true);
    expect(ctx.accounts.usageView('.grok').usage?.sevenDay?.utilization).toBe(15);
    ctx.source.applyUsage('.grok', { fetchedAt: at + 1, weeklyUsedPercent: 17, plan: 'SuperGrok Heavy' });
    expect(ctx.accounts.usageView('.grok').usage?.sevenDay?.utilization).toBe(17);
    expect(ctx.accounts.find('.grok')?.detected.plan).toBe('SuperGrok Heavy');
    expect(ctx.accounts.list(new Map()).find((a) => a.id === '.grok')).toMatchObject({ provider: 'grok', plan: 'SuperGrok Heavy', usageStatus: 'ok' });
  });
});
