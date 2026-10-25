// Instala (ou remove) o hook do Habblaud no Grok Build CLI (xAI). Roda no HOST, com tsx:
//
//   npm run grok:install     # grava <GROK_HOME>/hooks/habblaud.json (backup antes, se já existir)
//   npm run grok:uninstall   # apaga só esse arquivo (os outros hooks do Grok ficam)
//   npm run grok:status      # mostra, por pasta, se o arquivo está lá e se o Habblaud está respondendo
//   (opções: --dry-run, --conta <id>, --port <n>, --node <caminho>)
//
// O hook (mod/habblaud-grok/hook.mjs) manda ao escritório o que as sessões do Grok fazem (SessionStart,
// UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Notification, Stop, StopFailure, StopCancelled,
// SubagentStart, SubagentStop, SessionEnd) e NUNCA decide nada: só observa, fail-open, prazo curto.
//
// Pastas: as mesmas contas do Grok que o servidor acompanha: HABBLAUD_GROK_DIRS (lista separada por vírgula; substitui
// tudo) ou GROK_HOME e as pastas ~/.grok* do Grok (isGrokHome).
//
// O Grok lê todos os `<GROK_HOME>/hooks/*.json` (sempre confiáveis: não há passo de aprovação em /hooks) e junta os
// grupos de cada arquivo: por isso o Habblaud tem um arquivo SÓ dele (habblaud.json) e nunca mexe nos outros nem no
// config.toml. Porta fica em ~/.habblaud/grok-hook.json (o hook lê): mudar a porta não muda o hooks.
// Rodar de novo regrava o arquivo (igual = nada muda).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { discoverGrokDirs } from '../server/sources/grok/accounts';
import { chooseNode, MIN_NODE_MAJOR, nodeMajor } from './codex-install';
import { quotePath, tildify } from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SCRIPT = join(ROOT, 'mod', 'habblaud-grok', 'hook.mjs');
/** O arquivo de hooks do Habblaud dentro de <GROK_HOME>/hooks/. */
export const HOOKS_FILE = 'habblaud.json';
export const DEFAULT_PORT = 4747;
/** Eventos só de observação. O Grok roda todo hook em primeiro plano: o tempo limite é curto. */
export const OBSERVE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'StopFailure', 'StopCancelled', 'SubagentStart', 'SubagentStop'] as const;
/** Todos os eventos em que o Habblaud entra. */
export const EVENTS = [...OBSERVE_EVENTS, 'Notification', 'SessionEnd'] as const;
/** Tempo limite dos eventos de observação (o hook manda o evento com prazo de 1,5 s). */
export const OBSERVE_TIMEOUT_S = 3;
/** SessionEnd: o Grok dá 1,5 s para a fila toda ao sair. */
export const SESSION_END_TIMEOUT_S = 1;
/** Notification: só os tipos que mudam o personagem (mão levantada e de volta ao normal). */
export const NOTIFICATION_MATCHER = 'permission_prompt|idle_prompt';
/** Configuração lida pelo hook (porta), em ~/.habblaud. */
export const CONFIG_NAME = 'grok-hook.json';

const USAGE = tr('Uso: npm run grok:<install|uninstall|status> [-- opções]\n\n  install     grava o arquivo de hooks do Habblaud em <GROK_HOME>/hooks/habblaud.json (faz backup se já existir)\n  uninstall   apaga só esse arquivo (os outros hooks do Grok ficam)\n  status      mostra se o arquivo está lá e se o Habblaud está respondendo\n\nOpções:\n  --dry-run        mostra o que mudaria, sem gravar nada\n  --conta <id>     só a pasta desta conta (o nome da pasta, ex.: .grok)\n  --port <n>       porta do Habblaud (padrão: HABBLAUD_PORT ou {0})\n  --node <caminho> o Node {1}+ que roda o hook (padrão: o `node` do shell de login, se for {2}+;\n                   senão o primeiro {3}+ entre /opt/homebrew/bin, /usr/local/bin e o deste comando)\n  -h, --help       mostra esta ajuda\n\nPastas: HABBLAUD_GROK_DIRS (lista separada por vírgula) ou GROK_HOME e as pastas ~/.grok* do Grok.\nOs hooks globais do Grok são sempre confiáveis: não há nada para aprovar depois.', [DEFAULT_PORT, MIN_NODE_MAJOR, MIN_NODE_MAJOR, MIN_NODE_MAJOR]);

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em server/test/grok-install.test.ts)
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** `node "<hook>"` (ou `"<node>" "<hook>"` com um Node escolhido), sem opções. */
export function hookCommand(scriptPath: string, nodeBin?: string): string {
  return `${nodeBin ? quotePath(nodeBin) : 'node'} ${quotePath(scriptPath)}`;
}

/** O conteúdo de <GROK_HOME>/hooks/habblaud.json, como o Grok o lê ({description, hooks: {<Evento>: [{matcher?, hooks: [handler]}]}}). */
export function hooksFile(command: string): Rec {
  const hooks: Rec = {};
  for (const event of EVENTS) {
    const timeout = event === 'SessionEnd' ? SESSION_END_TIMEOUT_S : OBSERVE_TIMEOUT_S;
    const group: Rec = { hooks: [{ type: 'command', command, timeout }] };
    if (event === 'Notification') group.matcher = NOTIFICATION_MATCHER;
    hooks[event] = [group];
  }
  return { description: 'Habblaud: mostra as sessões do Grok no escritório (so observa; npm run grok:uninstall remove)', hooks };
}

/** JSON com as chaves em ordem (para comparar arquivos sem depender da ordem em que foram gravados). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const r = rec(v);
  if (!r) return JSON.stringify(v) ?? 'null';
  return `{${Object.keys(r)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`)
    .join(',')}}`;
}

/** Caminho do script no comando de um handler instalado. */
export function scriptPathOf(command: string): string | undefined {
  const m = /("[^"]*habblaud-grok[\\/]+hook\.mjs"|'(?:[^']|'\\'')*habblaud-grok[\\/]+hook\.mjs'|\S*habblaud-grok[\\/]+hook\.mjs)/.exec(command);
  if (!m) return undefined;
  const q = m[1];
  if (q.startsWith('"')) return q.slice(1, -1);
  if (q.startsWith("'")) return q.slice(1, -1).replace(/'\\''/g, "'");
  return q;
}

export type FileState = 'missing' | 'ok' | 'outdated' | 'foreign';

/**
 * O que está em <GROK_HOME>/hooks/habblaud.json: ausente, igual ao esperado, diferente (outro caminho do repositório,
 * versão antiga) ou um arquivo que não é do Habblaud (sem o hook dele: não é tocado).
 */
export function fileState(raw: string | undefined, expected: Rec): { state: FileState; paths: string[] } {
  if (raw === undefined) return { state: 'missing', paths: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'foreign', paths: [] };
  }
  const paths: string[] = [];
  const hooks = rec(rec(parsed)?.hooks) ?? {};
  for (const list of Object.values(hooks)) {
    if (!Array.isArray(list)) continue;
    for (const g of list) {
      const handlers = rec(g)?.hooks;
      if (!Array.isArray(handlers)) continue;
      for (const h of handlers) {
        const p = typeof rec(h)?.command === 'string' ? scriptPathOf(rec(h)!.command as string) : undefined;
        if (p && !paths.includes(p)) paths.push(p);
      }
    }
  }
  if (!paths.length) return { state: 'foreign', paths };
  return { state: canonical(parsed) === canonical(expected) ? 'ok' : 'outdated', paths };
}

// ---------------------------------------------------------------------------------------------
// Efeitos (arquivos e o /api/health do Habblaud)
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  /** Só a pasta desta conta (basename). */
  account?: string;
  port: number;
  /** --node: o Node do hook, com caminho absoluto (sem ela, chooseNode). */
  node?: string;
}

export interface Health {
  grokEvents?: boolean;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  hookPath: string;
  out: (line: string) => void;
  /** Consulta o /api/health do Habblaud (testes injetam um falso). */
  health?: (port: number) => Promise<Health | undefined>;
  /** Versão de um Node (ver chooseNode); ausente = não consulta e usa `node` (os testes não rodam shells). */
  nodeProbe?: (bin: string | undefined) => string | undefined;
  /** Candidatos a Node quando o do shell de login é antigo. */
  nodeCandidates?: readonly string[];
}

class FatalError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let account: string | undefined;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let node: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--conta') {
      account = argv[++i];
      if (!account) throw new FatalError(tr('--conta precisa do nome da pasta da conta (ex.: .grok).'));
    } else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError(tr('--port precisa de um número entre 1 e 65535.'));
    } else if (a === '--node') {
      node = argv[++i];
      if (!node || !isAbsolute(node)) throw new FatalError(tr('--node precisa do caminho absoluto de um Node 22+ (ex.: /opt/homebrew/bin/node).'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('diga o que fazer: install, uninstall ou status.\n\n{0}', [USAGE]));
  return { command, dryRun, account, port, ...(node ? { node } : {}) };
}

export function configPath(home: string): string {
  return join(home, '.habblaud', CONFIG_NAME);
}

/** Configuração gravada para o hook (undefined = não existe ou ilegível). */
export function readHookConfig(home: string): { port?: number } | undefined {
  try {
    const j = rec(JSON.parse(readFileSync(configPath(home), 'utf8')));
    if (!j) return undefined;
    return typeof j.port === 'number' ? { port: j.port } : {};
  } catch {
    return undefined;
  }
}

/** Grava a configuração do hook se mudou. Devolve true se gravou. */
function writeHookConfig(home: string, port: number): boolean {
  if (readHookConfig(home)?.port === port) return false;
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(configPath(home), `${JSON.stringify({ port }, null, 2)}\n`, { mode: 0o644 });
  return true;
}

async function fetchHealth(port: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as Health;
  } catch {
    return undefined;
  }
}

function readFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** Grava o arquivo (atômico), com backup do anterior se existia. Devolve o caminho do backup. */
function writeHooksFile(file: string, content: Rec, previous: string | undefined, now: Date): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | undefined;
  if (previous !== undefined) {
    backup = `${file}.habblaud-backup-${stamp(now)}`;
    for (let i = 2; existsSync(backup); i++) backup = `${file}.habblaud-backup-${stamp(now)}-${i}`;
    writeFileSync(backup, previous, { mode: 0o600 });
  }
  const tmp = `${file}.habblaud-tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  return backup;
}

/** Executa o comando para todas as pastas do Grok. Devolve o código de saída. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { env, home, out } = ctx;
  const found = discoverGrokDirs(env, home);
  const dirs = opts.account ? found.filter((d) => basename(d) === opts.account) : found;
  if (!dirs.length) {
    out(
      opts.account
        ? tr('Nenhuma pasta do Grok com o nome {0} (pastas encontradas: {1}).', [opts.account, found.map((d) => basename(d)).join(', ') || tr('nenhuma')])
        : tr('Nenhuma pasta do Grok encontrada (~/.grok ou GROK_HOME). Use HABBLAUD_GROK_DIRS se ela estiver em outro lugar.'),
    );
    return 1;
  }
  let nodeBin = opts.node;
  if (!nodeBin && ctx.nodeProbe) {
    const pick = chooseNode(ctx.nodeProbe, ctx.nodeCandidates ?? []);
    nodeBin = pick.bin;
    const login = pick.login ? `Node ${pick.login}` : tr('nenhum Node');
    if (pick.bin) out(tr('i O shell de login (onde o Grok roda os hooks) tem {0}; o hook precisa do {1}+ e vai usar {2} ({3}).', [login, MIN_NODE_MAJOR, tildify(pick.bin, home), pick.chosen]));
    else if ((nodeMajor(pick.login) ?? 0) < MIN_NODE_MAJOR)
      out(tr('! O shell de login (onde o Grok roda os hooks) tem {0} e não achei um Node {1}+: os hooks podem falhar. Use --node <caminho de um Node {2}+>.', [login, MIN_NODE_MAJOR, MIN_NODE_MAJOR]));
  }
  const command = hookCommand(ctx.hookPath, nodeBin);
  const expected = hooksFile(command);
  let failures = 0;
  let changed = 0;
  for (const dir of dirs) {
    const file = join(dir, 'hooks', HOOKS_FILE);
    const label = `${basename(dir)} (${tildify(file, home)})`;
    const raw = readFile(file);
    const st = fileState(raw, expected);
    if (opts.command === 'status') {
      if (st.state === 'missing') out(tr('• {0}: não instalado', [label]));
      else if (st.state === 'foreign') out(tr('! {0}: existe, mas não é o hook do Habblaud; o instalador não mexe nele', [label]));
      else {
        for (const p of st.paths) {
          if (resolve(p) === resolve(ctx.hookPath)) continue;
          const gone = !existsSync(p) ? tr(' (esse arquivo não existe mais: os hooks falham e nada chega ao escritório)') : '';
          out(tr('! {0}: o hook aponta para {1}{2}; rode npm run grok:install para atualizar', [label, p, gone]));
        }
        if (st.state === 'outdated') out(tr('! {0}: diferente do esperado; rode npm run grok:install para atualizar', [label]));
        else out(tr('• {0}: instalado ({1} eventos)', [label, EVENTS.length]));
      }
      continue;
    }
    if (opts.command === 'uninstall') {
      if (st.state === 'missing') {
        out(tr('= {0}: não estava instalado', [label]));
        continue;
      }
      if (st.state === 'foreign') {
        out(tr('✗ {0}: existe, mas não é o hook do Habblaud; nada foi apagado', [label]));
        failures++;
        continue;
      }
      if (opts.dryRun) {
        out(tr('~ {0}: seria apagado (simulação: nada gravado)', [label]));
        continue;
      }
      try {
        unlinkSync(file);
        out(tr('✓ {0}: hook do Habblaud removido', [label]));
        changed++;
      } catch (err) {
        out(tr('✗ {0}: não consegui apagar ({1})', [label, (err as Error).message]));
        failures++;
      }
      continue;
    }
    // install
    if (st.state === 'ok') {
      out(tr('= {0}: já instalado', [label]));
      continue;
    }
    if (st.state === 'foreign') {
      out(tr('✗ {0}: existe um arquivo com esse nome que não é do Habblaud; renomeie-o e rode de novo', [label]));
      failures++;
      continue;
    }
    const message = st.state === 'missing' ? tr('instalado ({0} eventos)', [EVENTS.length]) : tr('atualizado');
    if (opts.dryRun) {
      out(tr('~ {0}: {1} (simulação: nada gravado)', [label, message]));
      continue;
    }
    try {
      const backup = writeHooksFile(file, expected, raw, ctx.now);
      out(`✓ ${label}: ${message}${backup ? tr(' · backup em {0}', [tildify(backup, home)]) : ''}`);
      changed++;
    } catch (err) {
      out(tr('✗ {0}: não consegui gravar ({1})', [label, (err as Error).message]));
      failures++;
    }
  }
  const cfgFile = tildify(configPath(home), home);
  if (opts.command === 'install') {
    if (opts.dryRun) out(tr('~ configuração do hook ({0}): porta {1} (simulação: nada gravado)', [cfgFile, opts.port]));
    else {
      try {
        if (writeHookConfig(home, opts.port)) out(tr('✓ configuração do hook gravada em {0} (porta {1})', [cfgFile, opts.port]));
        else out(tr('= configuração do hook ({0}): porta {1}', [cfgFile, opts.port]));
      } catch (err) {
        out(tr('✗ não consegui gravar {0} ({1}): o hook usa a porta {2}', [cfgFile, (err as Error).message, DEFAULT_PORT]));
        failures++;
      }
    }
  }
  if (opts.command === 'status') {
    const cfg = readHookConfig(home);
    out(cfg ? tr('Configuração do hook ({0}): porta {1}.', [cfgFile, cfg.port ?? DEFAULT_PORT]) : tr('Configuração do hook ({0}): não existe (o hook usa HABBLAUD_PORT ou a porta {1}).', [cfgFile, DEFAULT_PORT]));
    const port = cfg?.port ?? opts.port;
    const health = await (ctx.health ?? fetchHealth)(port);
    if (!health) out(tr('Habblaud em http://127.0.0.1:{0}: fora do ar (com ele parado, o hook sai na hora e o Grok segue normal).', [port]));
    else out(tr('Habblaud em http://127.0.0.1:{0}: {1}.', [port, health.grokEvents ? tr('recebendo os eventos do Grok') : tr('no ar, mas sem a fonte do Grok (os eventos são ignorados)')]));
  }
  if (opts.command === 'install' && changed && !opts.dryRun) {
    out('');
    out(tr('Pronto. Os hooks globais do Grok são sempre confiáveis: nada para aprovar. Sessões já abertas releem os hooks'));
    out(tr('sozinhas (ou abra o Grok de novo). Com o Habblaud aberto no navegador, cada passo do Grok aparece na hora.'));
    out(tr('Para desfazer: npm run grok:uninstall'));
  }
  if (opts.command === 'uninstall' && changed) out(tr('A configuração em ~/.habblaud/grok-hook.json fica (só o hook a lê).'));
  return failures ? 1 : 0;
}

/** Versão de um Node: o do shell de login (`$SHELL -lc`, bin ausente) ou de um caminho. Falha = undefined. */
function probeNode(bin: string | undefined): string | undefined {
  try {
    const opts = { encoding: 'utf8' as const, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
    const out = bin ? execFileSync(bin, ['--version'], opts) : execFileSync(process.env.SHELL || '/bin/sh', ['-lc', 'node --version'], opts);
    return out.trim().split('\n').pop();
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  process.exitCode = await run(parsed, {
    env: process.env,
    home,
    now: new Date(),
    hookPath: HOOK_SCRIPT,
    out: (l) => console.log(l),
    nodeProbe: probeNode,
    nodeCandidates: ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[grok] Erro: {0}', [err.message]) : tr('[grok] Erro inesperado: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
