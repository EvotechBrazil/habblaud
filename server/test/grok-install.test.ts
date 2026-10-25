// Instalador do hook do Grok (scripts/grok-install.ts): o arquivo <GROK_HOME>/hooks/habblaud.json (funções puras) e o
// comando de verdade em pastas temporárias (HOME e GROK_HOME FALSOS: nunca toca em ~/.grok). Os outros arquivos de
// hooks/ nunca são tocados.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonical, EVENTS, fileState, HOOK_SCRIPT, hookCommand, hooksFile, NOTIFICATION_MATCHER, parseArgs, run, scriptPathOf, type RunOptions } from '../../scripts/grok-install';
import { tempDir } from './fixtures';

const CMD = hookCommand('/repo/habblaud/mod/habblaud-grok/hook.mjs');

function fakeHome(names: string[] = ['.grok']) {
  const tmp = tempDir();
  for (const n of names) {
    mkdirSync(join(tmp.dir, n, 'sessions'), { recursive: true });
    writeFileSync(join(tmp.dir, n, 'active_sessions.json'), '[]');
  }
  return tmp;
}

async function exec(home: string, opts: Partial<RunOptions> & { command: RunOptions['command'] }, extra: { health?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const lines: string[] = [];
  const code = await run(
    { dryRun: false, port: 4747, ...opts },
    {
      env: { HOME: home, ...extra.env },
      home,
      now: new Date('2026-10-19T12:00:00Z'),
      hookPath: '/repo/habblaud/mod/habblaud-grok/hook.mjs',
      out: (l) => lines.push(l),
      health: async () => (extra.health === undefined ? undefined : { grokEvents: extra.health }),
    },
  );
  return { code, lines, text: lines.join('\n') };
}

describe('grok-install: o arquivo de hooks', () => {
  it('um grupo por evento, comando sem opções, prazos curtos e o matcher do Notification', () => {
    const file = hooksFile(CMD);
    const hooks = file.hooks as Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
    expect(Object.keys(hooks).sort()).toEqual([...EVENTS].sort());
    for (const event of EVENTS) {
      expect(hooks[event]).toHaveLength(1);
      const h = hooks[event][0].hooks[0];
      expect(h).toMatchObject({ type: 'command', command: CMD, timeout: event === 'SessionEnd' ? 1 : 3 });
      // Nada que o Grok não aceite (async, statusMessage...) e nada que decida.
      expect(Object.keys(h).sort()).toEqual(['command', 'timeout', 'type']);
      if (event === 'Notification') expect(hooks[event][0].matcher).toBe(NOTIFICATION_MATCHER);
      else expect(hooks[event][0].matcher).toBeUndefined();
    }
    expect(NOTIFICATION_MATCHER).toBe('permission_prompt|idle_prompt');
    expect(hookCommand('/a b/hook.mjs')).toBe('node "/a b/hook.mjs"');
    expect(hookCommand('/a/hook.mjs', '/opt/homebrew/bin/node')).toBe('"/opt/homebrew/bin/node" "/a/hook.mjs"');
    expect(scriptPathOf(CMD)).toBe('/repo/habblaud/mod/habblaud-grok/hook.mjs');
    expect(scriptPathOf('node /outro/mod/habblaud-grok/hook.mjs')).toBe('/outro/mod/habblaud-grok/hook.mjs');
    expect(scriptPathOf('node /x/outro.mjs')).toBeUndefined();
    expect(HOOK_SCRIPT.endsWith(join('mod', 'habblaud-grok', 'hook.mjs'))).toBe(true);
  });

  it('fileState: ausente, igual, desatualizado (outro caminho) e estranho (não é do Habblaud)', () => {
    const expected = hooksFile(CMD);
    expect(fileState(undefined, expected)).toEqual({ state: 'missing', paths: [] });
    expect(fileState(JSON.stringify(expected), expected)).toEqual({ state: 'ok', paths: ['/repo/habblaud/mod/habblaud-grok/hook.mjs'] });
    // A ordem das chaves não importa.
    expect(fileState(canonical(expected), expected).state).toBe('ok');
    const old = hooksFile(hookCommand('/antigo/mod/habblaud-grok/hook.mjs'));
    expect(fileState(JSON.stringify(old), expected)).toEqual({ state: 'outdated', paths: ['/antigo/mod/habblaud-grok/hook.mjs'] });
    expect(fileState('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo oi"}]}]}}', expected).state).toBe('foreign');
    expect(fileState('{nope', expected).state).toBe('foreign');
  });

  it('parseArgs: comandos, --conta, --port, --node e erros', () => {
    expect(parseArgs(['install'], {})).toEqual({ command: 'install', dryRun: false, account: undefined, port: 4747 });
    expect(parseArgs(['status', '--dry-run', '--conta', '.grok', '--port', '4848', '--node', '/usr/local/bin/node'], {})).toEqual({ command: 'status', dryRun: true, account: '.grok', port: 4848, node: '/usr/local/bin/node' });
    expect(parseArgs(['install'], { HABBLAUD_PORT: '5000' })).toMatchObject({ port: 5000 });
    expect(parseArgs(['--help'], {})).toBe('help');
    expect(() => parseArgs([], {})).toThrow(/install, uninstall ou status/);
    expect(() => parseArgs(['install', '--port', 'x'], {})).toThrow(/--port/);
    expect(() => parseArgs(['install', '--node', 'node'], {})).toThrow(/--node/);
    expect(() => parseArgs(['install', '--xyz'], {})).toThrow(/opção desconhecida/);
  });
});

describe('grok-install: o comando', () => {
  it('install grava hooks/habblaud.json e a configuração; de novo = nada muda; outros arquivos de hooks/ ficam', async () => {
    const tmp = fakeHome();
    try {
      const hooksDir = join(tmp.dir, '.grok', 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, 'outro.json'), '{"hooks":{}}');
      const r1 = await exec(tmp.dir, { command: 'install', port: 4848 });
      expect(r1.code).toBe(0);
      expect(r1.text).toContain('✓ .grok (~/.grok/hooks/habblaud.json): instalado (12 eventos)');
      expect(r1.text).toContain('configuração do hook gravada em ~/.habblaud/grok-hook.json (porta 4848)');
      expect(r1.text).toContain('nada para aprovar');
      const written = JSON.parse(readFileSync(join(hooksDir, 'habblaud.json'), 'utf8')) as Record<string, unknown>;
      expect(canonical(written)).toBe(canonical(hooksFile(CMD)));
      expect(JSON.parse(readFileSync(join(tmp.dir, '.habblaud', 'grok-hook.json'), 'utf8'))).toEqual({ port: 4848 });
      expect(readFileSync(join(hooksDir, 'outro.json'), 'utf8')).toBe('{"hooks":{}}');
      // De novo: nada muda, sem backup.
      const r2 = await exec(tmp.dir, { command: 'install', port: 4848 });
      expect(r2.text).toContain('= .grok (~/.grok/hooks/habblaud.json): já instalado');
      expect(readdirSync(hooksDir).sort()).toEqual(['habblaud.json', 'outro.json']);
      // Caminho antigo do repositório: atualiza com backup.
      writeFileSync(join(hooksDir, 'habblaud.json'), JSON.stringify(hooksFile(hookCommand('/antigo/mod/habblaud-grok/hook.mjs'))));
      const r3 = await exec(tmp.dir, { command: 'install', port: 4848 });
      expect(r3.text).toContain('atualizado · backup em ~/.grok/hooks/habblaud.json.habblaud-backup-');
      expect(readdirSync(hooksDir).some((n) => n.startsWith('habblaud.json.habblaud-backup-'))).toBe(true);
      // status: instalado, com o Habblaud respondendo.
      const st = await exec(tmp.dir, { command: 'status' }, { health: true });
      expect(st.text).toContain('• .grok (~/.grok/hooks/habblaud.json): instalado (12 eventos)');
      expect(st.text).toContain('porta 4848');
      expect(st.text).toContain('recebendo os eventos do Grok');
      // uninstall: apaga só o arquivo do Habblaud.
      const un = await exec(tmp.dir, { command: 'uninstall' });
      expect(un.code).toBe(0);
      expect(un.text).toContain('✓ .grok (~/.grok/hooks/habblaud.json): hook do Habblaud removido');
      expect(existsSync(join(hooksDir, 'habblaud.json'))).toBe(false);
      expect(existsSync(join(hooksDir, 'outro.json'))).toBe(true);
      expect((await exec(tmp.dir, { command: 'uninstall' })).text).toContain('não estava instalado');
    } finally {
      tmp.cleanup();
    }
  });

  it('dry-run não grava; arquivo estranho com o nome do Habblaud não é tocado; status sem o Habblaud no ar; --conta', async () => {
    const tmp = fakeHome(['.grok', '.grok-trabalho']);
    try {
      const dry = await exec(tmp.dir, { command: 'install', dryRun: true });
      expect(dry.code).toBe(0);
      expect(dry.text).toContain('~ .grok (~/.grok/hooks/habblaud.json): instalado (12 eventos) (simulação: nada gravado)');
      expect(dry.text).toContain('~ .grok-trabalho (~/.grok-trabalho/hooks/habblaud.json): instalado');
      expect(existsSync(join(tmp.dir, '.grok', 'hooks'))).toBe(false);
      expect(existsSync(join(tmp.dir, '.habblaud'))).toBe(false);
      mkdirSync(join(tmp.dir, '.grok', 'hooks'), { recursive: true });
      writeFileSync(join(tmp.dir, '.grok', 'hooks', 'habblaud.json'), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo oi"}]}]}}');
      const foreign = await exec(tmp.dir, { command: 'install', account: '.grok' });
      expect(foreign.code).toBe(1);
      expect(foreign.text).toContain('não é do Habblaud; renomeie-o');
      const only = await exec(tmp.dir, { command: 'install', account: '.grok-trabalho' });
      expect(only.code).toBe(0);
      expect(only.lines.filter((l) => l.startsWith('✓ .grok'))).toHaveLength(1);
      const st = await exec(tmp.dir, { command: 'status' });
      expect(st.text).toContain('! .grok (~/.grok/hooks/habblaud.json): existe, mas não é o hook do Habblaud');
      expect(st.text).toContain('fora do ar');
      expect((await exec(tmp.dir, { command: 'install', account: '.nada' })).text).toContain('Nenhuma pasta do Grok com o nome .nada');
    } finally {
      tmp.cleanup();
    }
  });

  it('sem pasta do Grok: código 1 e a dica da variável', async () => {
    const tmp = tempDir();
    try {
      const r = await exec(tmp.dir, { command: 'install' });
      expect(r.code).toBe(1);
      expect(r.text).toContain('HABBLAUD_GROK_DIRS');
    } finally {
      tmp.cleanup();
    }
  });
});
