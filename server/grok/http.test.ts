// Rota dos eventos dos hooks do Grok (POST /api/grok/events) pelas rotas de verdade (guard e app): repassa à fonte do
// Grok ao vivo (um falso) com a conta certa (pela pasta GROK_HOME), só com Host local, só POST com JSON; sem a fonte,
// {ok: false}. Dados sintéticos.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { GrokLive } from '../sources/grok/live';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { grokAccountOf, parseGrokEvent } from './http';

setQuiet(true);

const EVENT = { session_id: '0199b0c0-1234-7abc-8def-0123456789ab', hook_event_name: 'UserPromptSubmit', cwd: '/p/loja', prompt: 'oi' };

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(live?: GrokLive): Promise<{ base: string; accounts: AccountsService }> {
  const tmp = tempDir();
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10 });
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  // Conta do Grok desambiguada (".grok~2"): o caminho do host é o que vale.
  accounts.setProviderAccounts('grok', [
    { dir: '/montada/a', detected: { id: '.grok', configDir: '/Users/x/.grok', short: 'G', name: 'Grok G', color: '#000' } },
    { dir: '/montada/b', detected: { id: '.grok', configDir: '/Volumes/y/.grok', short: 'K', name: 'Grok K', color: '#111' } },
  ]);
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, grokLive: live });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  close = () =>
    new Promise((ok) => {
      hub.stop();
      server.closeAllConnections();
      server.close(() => {
        tmp.cleanup();
        ok();
      });
    });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, accounts };
}

describe('POST /api/grok/events', () => {
  it('repassa o evento à fonte do Grok com a conta da pasta GROK_HOME (ou a do hook) e devolve {ok}', async () => {
    const calls: Array<[string | undefined, Record<string, unknown>]> = [];
    const { base } = await serve({
      applyHookEvent(account, input) {
        calls.push([account, input]);
        return input.hook_event_name !== 'Nada';
      },
    });
    let r = await request(base, '/api/grok/events', { method: 'POST', body: { account: '.grok', grokHome: '/Volumes/y/.grok', event: EVENT } });
    expect([r.status, r.json]).toEqual([200, { ok: true }]);
    expect(calls[0]).toEqual(['.grok~2', EVENT]);
    r = await request(base, '/api/grok/events', { method: 'POST', body: { account: '.grok', event: { ...EVENT, hook_event_name: 'Nada' } } });
    expect([r.status, r.json]).toEqual([200, { ok: false }]);
    expect(calls[1][0]).toBe('.grok');
    // Sem conta nem pasta: a fonte decide.
    r = await request(base, '/api/grok/events', { method: 'POST', body: { event: EVENT } });
    expect(r.status).toBe(200);
    expect(calls[2][0]).toBeUndefined();
  });

  it('sem a fonte do Grok: {ok: false}; corpo inválido: 400; só POST; só Host local; /api/health conta a rota', async () => {
    const { base } = await serve();
    let r = await request(base, '/api/grok/events', { method: 'POST', body: { event: EVENT } });
    expect([r.status, r.json]).toEqual([200, { ok: false }]);
    r = await request(base, '/api/grok/events', { method: 'POST', body: { event: { nada: 1 } } });
    expect(r.status).toBe(400);
    r = await request(base, '/api/grok/events');
    expect(r.status).toBe(405);
    r = await request(base, '/api/grok/events', { method: 'POST', body: { event: EVENT }, headers: { host: 'habblaud.lan' } });
    expect(r.status).toBe(403);
    r = await request(base, '/api/health');
    expect(r.json).toMatchObject({ grokEvents: false, codexEvents: false });
  });

  it('parseGrokEvent e grokAccountOf (funções puras)', () => {
    expect(parseGrokEvent({ account: '.grok', grokHome: '/Users/x/.grok', event: EVENT })).toEqual({ account: '.grok', grokHome: '/Users/x/.grok', event: EVENT });
    expect(parseGrokEvent({ event: EVENT, account: '', grokHome: 'relativa' })).toEqual({ event: EVENT, grokHome: 'relativa' });
    expect(() => parseGrokEvent({ event: 'x' })).toThrow();
    const entries = [
      { id: '.grok', provider: 'grok' as const, dir: '/montada/a', detected: { id: '.grok', configDir: '/Users/x/.grok', short: 'G', name: 'Grok', color: '#000' } },
      { id: '.grok~2', provider: 'grok' as const, dir: '/montada/b', detected: { id: '.grok~2', configDir: '/Volumes/y/.grok', short: 'K', name: 'Grok K', color: '#111' } },
    ];
    expect(grokAccountOf(entries, '.grok', '/Volumes/y/.grok/')).toBe('.grok~2');
    expect(grokAccountOf(entries, '.grok', '/montada/a')).toBe('.grok');
    expect(grokAccountOf(entries, '.grok', 'relativa')).toBe('.grok');
    expect(grokAccountOf(entries, undefined, '/nao/existe')).toBeUndefined();
  });
});
