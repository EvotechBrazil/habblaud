// Hook do Grok (mod/habblaud-grok/hook.mjs) rodado como processo de verdade contra as rotas de verdade (guard e app)
// e uma fonte do Grok falsa: eventos de observação (nunca nada no stdout), a conta pelo GROK_HOME (ou ~/.grok), a
// configuração em ~/.habblaud/grok-hook.json e o Habblaud fora do ar. HOME e GROK_HOME sempre em pastas temporárias;
// stdin sintético.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from './fixtures';

setQuiet(true);

const HOOK = resolve(__dirname, '../../mod/habblaud-grok/hook.mjs');
const SESSION = '0199b0c0-1234-7abc-8def-0123456789ab';

interface HookModule {
  readConfig(env: NodeJS.ProcessEnv): { port: number };
  grokHomeOf(env: NodeJS.ProcessEnv): string;
  accountOf(grokHome: string): string;
  eventBody(input: Record<string, unknown>, account: string, grokHome: string): Record<string, unknown>;
  OBSERVED: Set<string>;
}
const hook = (await import(pathToFileURL(HOOK).href)) as HookModule;

class FakeLive {
  calls: Array<{ account: string | undefined; input: Record<string, unknown> }> = [];
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    this.calls.push({ account, input });
    return true;
  }
}

let tmp: ReturnType<typeof tempDir>;
let home: string;
let live: FakeLive;
let close: (() => Promise<void>) | undefined;
let port = 0;

async function serve(): Promise<void> {
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10 });
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, grokLive: live });
  const guard = createRequestGuard({ allowedHosts: new Set() });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  port = (server.address() as AddressInfo).port;
  close = () =>
    new Promise((ok) => {
      hub.stop();
      server.closeAllConnections();
      server.close(() => ok());
    });
}

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.dir, 'home');
  mkdirSync(home, { recursive: true });
  live = new FakeLive();
});

afterEach(async () => {
  await close?.();
  close = undefined;
  tmp.cleanup();
});

function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(join(home, '.habblaud', 'grok-hook.json'), JSON.stringify(cfg));
}

function runHook(stdin: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((ok, fail) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const kill = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(kill);
      ok({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.end(stdin);
  });
}

/** JSON (sintético) de um evento de hook do Grok, com as duas grafias que ele grava. */
function grokEvent(event: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { hookEventName: event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(), hook_event_name: event, sessionId: SESSION, session_id: SESSION, cwd: '/p/loja', workspaceRoot: '/p/loja', permissionMode: 'auto', timestamp: '2026-10-19T12:00:00Z', ...over };
}

async function waitCalls(n: number): Promise<void> {
  for (let i = 0; i < 200 && live.calls.length < n; i++) await new Promise((ok) => setTimeout(ok, 25));
}

describe('hook do Grok', () => {
  it('evento de observação: vai para /api/grok/events com a conta e o GROK_HOME; nada no stdout; sai com 0', async () => {
    await serve();
    writeConfig({ port });
    const grokHome = join(tmp.dir, 'grok-casa');
    const r = await runHook(JSON.stringify(grokEvent('PreToolUse', { toolName: 'run_terminal_command', tool_name: 'run_terminal_command', tool_input: { command: 'npm test' }, toolUseId: 'call-1', tool_use_id: 'call-1' })), { GROK_HOME: grokHome });
    expect([r.code, r.stdout]).toEqual([0, '']);
    await waitCalls(1);
    expect(live.calls).toHaveLength(1);
    expect(live.calls[0].account).toBe('grok-casa');
    expect(live.calls[0].input).toMatchObject({ hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'run_terminal_command', tool_use_id: 'call-1', cwd: '/p/loja' });
  });

  it('sem GROK_HOME: a conta é ~/.grok; HABBLAUD_PORT vale como reserva; textos enormes vão cortados', async () => {
    await serve();
    const big = 'x'.repeat(3_000_000);
    const r = await runHook(JSON.stringify(grokEvent('PostToolUse', { tool_name: 'run_terminal_command', tool_response: { output: big } })), { HABBLAUD_PORT: String(port) });
    expect([r.code, r.stdout]).toEqual([0, '']);
    await waitCalls(1);
    expect(live.calls[0].account).toBe('.grok');
    const out = (live.calls[0].input.tool_response as { output: string }).output;
    expect(out.length).toBeLessThan(big.length);
    expect(out.length).toBeGreaterThan(0);
  });

  it('Habblaud fora do ar: sai rápido, com 0 e sem saída; stdin inválido ou evento não observado: nada é mandado', async () => {
    // Porta livre, sem ninguém ouvindo.
    const free = await new Promise<number>((ok) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => ok(p));
      });
    });
    writeConfig({ port: free });
    const down = await runHook(JSON.stringify(grokEvent('Stop')));
    expect([down.code, down.stdout]).toEqual([0, '']);
    expect(down.ms).toBeLessThan(10_000);
    await serve();
    writeConfig({ port });
    for (const stdin of ['{nope', JSON.stringify({ hook_event_name: 'Stop' }), JSON.stringify(grokEvent('PreCompactX')), '']) {
      const r = await runHook(stdin);
      expect([r.code, r.stdout]).toEqual([0, '']);
    }
    await new Promise((ok) => setTimeout(ok, 200));
    expect(live.calls).toHaveLength(0);
  });

  it('funções puras: readConfig, grokHomeOf, accountOf, eventBody e a lista de eventos', () => {
    writeConfig({ port: 4949 });
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4949 });
    expect(hook.readConfig({ HOME: join(tmp.dir, 'nada'), HABBLAUD_PORT: '5050' })).toEqual({ port: 5050 });
    expect(hook.readConfig({ HOME: join(tmp.dir, 'nada'), HABBLAUD_PORT: 'x' })).toEqual({ port: 4747 });
    expect(hook.grokHomeOf({ HOME: '/casa' })).toBe(resolve('/casa/.grok'));
    expect(hook.grokHomeOf({ HOME: '/casa', GROK_HOME: '~/.grok-trabalho/' })).toBe(resolve('/casa/.grok-trabalho'));
    expect(hook.accountOf('/casa/.grok-trabalho')).toBe('.grok-trabalho');
    const body = hook.eventBody({ hook_event_name: 'Stop', session_id: SESSION, big: 'y'.repeat(20_000) }, '.grok', '/casa/.grok');
    expect(body).toMatchObject({ account: '.grok', grokHome: '/casa/.grok' });
    expect((body.event as { big: string }).big).toHaveLength(8_000);
    for (const e of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'StopCancelled', 'SubagentStart', 'SubagentStop', 'SessionEnd']) expect(hook.OBSERVED.has(e)).toBe(true);
    expect(hook.OBSERVED.has('PermissionRequest')).toBe(false);
  });
});
