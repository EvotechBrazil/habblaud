// Contas do Grok: descoberta das pastas, letra (alias de shell ou derivada), cor, nome e os metadados vindos do host.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS, parseToolAliases } from '../../accounts/detect';
import { tempDir } from '../../test/fixtures';
import { detectGrokAccounts, discoverGrokDirs, isGrokHome } from './accounts';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function home() {
  const tmp = tempDir();
  cleanups.push(tmp.cleanup);
  const grok = (name: string, marker: 'active' | 'sessions' | 'config' | 'none' = 'active') => {
    const dir = join(tmp.dir, name);
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    if (marker === 'active') writeFileSync(join(dir, 'active_sessions.json'), '[]');
    if (marker === 'sessions') mkdirSync(join(dir, 'sessions', '%2FUsers%2Ffulano%2Floja'));
    if (marker === 'config') writeFileSync(join(dir, 'config.toml'), '');
    return dir;
  };
  return { dir: tmp.dir, grok };
}

describe('contas do Grok', () => {
  it('descoberta: ~/.grok* com cara de Grok (a padrão primeiro), GROK_HOME e HABBLAUD_GROK_DIRS', () => {
    const h = home();
    const main = h.grok('.grok');
    const work = h.grok('.grok-trabalho', 'sessions');
    const cfg = h.grok('.grok-config', 'config');
    h.grok('.grok-vazia', 'none');
    // Pasta do Claude Code (projects/) e do Codex (thread-writer-locks/, sessions/AAAA) nunca são do Grok.
    const claude = join(h.dir, '.grok-claude');
    mkdirSync(join(claude, 'projects'), { recursive: true });
    writeFileSync(join(claude, 'active_sessions.json'), '[]');
    const codex = join(h.dir, '.grok-codex');
    mkdirSync(join(codex, 'sessions', '2026'), { recursive: true });
    expect(isGrokHome(main)).toBe(true);
    expect(isGrokHome(work)).toBe(true);
    expect(isGrokHome(cfg)).toBe(true);
    expect(isGrokHome(claude)).toBe(false);
    expect(isGrokHome(codex)).toBe(false);
    expect(isGrokHome(join(h.dir, '.grok-vazia'))).toBe(false);
    expect(discoverGrokDirs({}, h.dir)).toEqual([main, cfg, work]);
    const other = h.grok('outra');
    // GROK_HOME primeiro; as ~/.grok* continuam entrando (cada uma é uma conta).
    expect(discoverGrokDirs({ GROK_HOME: other }, h.dir)).toEqual([other, main, cfg, work]);
    expect(discoverGrokDirs({ HABBLAUD_GROK_DIRS: `${work}, ~/nao-existe` }, h.dir)).toEqual([work]);
  });

  it('letra: alias de shell com GROK_HOME (ou a pasta padrão), senão derivada sem colidir com as outras ferramentas', () => {
    const h = home();
    const main = h.grok('.grok');
    const work = h.grok('.grok-trabalho');
    writeFileSync(join(h.dir, '.zshrc'), `alias k='grok --model x'\nalias w="GROK_HOME=${work} grok"\nalias c='claude'\n`);
    expect(parseToolAliases(`alias w="GROK_HOME=${work} grok"`, h.dir, 'grok')).toEqual([{ name: 'w', configDir: work }]);
    const accs = detectGrokAccounts([main, work], { home: h.dir, env: {}, taken: { shorts: ['C', 'X'], colors: [ACCOUNT_COLORS[0]] } });
    expect(accs.map((a) => [a.id, a.short, a.name, a.color, a.provider])).toEqual([
      ['.grok', 'K', 'Grok K', ACCOUNT_COLORS[1], 'grok'],
      ['.grok-trabalho', 'W', 'Grok W', ACCOUNT_COLORS[2], 'grok'],
    ]);
    // Sem alias: G para a padrão, a inicial do sufixo para as outras; uma conta só se chama "Grok".
    const plain = detectGrokAccounts([main], { home: h.dir, env: { HOME: '/nao/existe' }, taken: { shorts: ['G'] } });
    expect(plain[0]).toMatchObject({ short: 'K', name: 'Grok' });
    expect(detectGrokAccounts([main, work], { home: '/nao/existe', env: {} }).map((a) => a.short)).toEqual(['G', 'T']);
  });

  it('HABBLAUD_ACCOUNTS (Docker): só os overrides com provider grok, casados pela pasta montada', () => {
    const h = home();
    const mounted = h.grok('.grok');
    const env = {
      HABBLAUD_ACCOUNTS: JSON.stringify([
        { id: '.grok', provider: 'grok', configDir: '/Users/fulano/.grok', mountDir: mounted, short: 'GK', name: 'Grok do Mac', color: '#123456' },
        { id: '.codex', provider: 'codex', configDir: '/Users/fulano/.codex', mountDir: '/codex/.codex', short: 'X' },
      ]),
    };
    expect(detectGrokAccounts([mounted], { home: h.dir, env })).toEqual([{ id: '.grok', provider: 'grok', configDir: '/Users/fulano/.grok', short: 'GK', name: 'Grok do Mac', color: '#123456' }]);
  });
});
