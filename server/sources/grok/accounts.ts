// Contas do Grok (Grok Build CLI, da xAI): uma pasta GROK_HOME por conta (~/.grok, ~/.grok-trabalho...). Node puro e
// sem dependências do servidor: também é importado por scripts/docker-up.ts e scripts/grok-install.ts (via tsx).
//
// Descoberta: HABBLAUD_GROK_DIRS (lista separada por vírgula) substitui tudo; senão GROK_HOME e `$HOME/.grok*` que
// tenham cara de pasta do Grok (isGrokHome). Letra da conta: o alias de shell `alias g='GROK_HOME=... grok'` (sem
// GROK_HOME = a pasta padrão); sem alias, uma letra derivada que não colide com as do Claude Code nem as do Codex.
// Cor: da paleta das contas, sem repetir as das outras ferramentas. Nome: "Grok" (ou "Grok X" com mais de uma).
//
// Privacidade: NUNCA lê `auth.json`, `config.toml` nem a memória do Grok (só confere se existem, em isGrokHome); dos
// arquivos de shell, só as linhas `alias X='... grok ...'`. No Docker o host manda tudo pronto em HABBLAUD_ACCOUNTS
// (`provider: 'grok'`, com o `configDir` do host).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type DetectedAccount,
} from '../../accounts/detect';

/** Registro das sessões abertas (o Grok regrava o arquivo inteiro a cada abertura/fechamento). */
export const ACTIVE_SESSIONS_FILE = 'active_sessions.json';

/** HABBLAUD_GROK desligado (0, false, off, no): sem o Grok no escritório (docker:up e o auxiliar do host). */
export function grokDisabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.HABBLAUD_GROK?.trim();
  return !!v && !/^(1|true|yes|sim|on)$/i.test(v);
}
/** Pasta das sessões: sessions/<cwd codificado como URL>/<id da sessão>/. */
export const SESSIONS_DIR = 'sessions';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Pasta padrão do Grok: GROK_HOME ou $HOME/.grok. */
export function defaultGrokHome(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env.GROK_HOME?.trim();
  return raw ? expandHome(raw, home) : join(home, '.grok');
}

/**
 * A pasta é do Grok (um GROK_HOME)? Tem `active_sessions.json`, ou `sessions/` com alguma pasta de projeto codificada
 * como URL (`%2FUsers%2F...`), ou `config.toml` junto de `sessions/`. Uma pasta do Claude Code (`projects/`) ou do
 * Codex (`thread-writer-locks/`, `sessions/AAAA/`) nunca é do Grok. Pasta inexistente ou vazia não é do Grok.
 */
export function isGrokHome(p: string): boolean {
  if (!isDir(p)) return false;
  if (existsSync(join(p, 'projects')) || existsSync(join(p, 'thread-writer-locks'))) return false;
  if (existsSync(join(p, ACTIVE_SESSIONS_FILE))) return true;
  const sessions = join(p, SESSIONS_DIR);
  if (!isDir(sessions)) return false;
  let names: string[];
  try {
    names = readdirSync(sessions);
  } catch {
    return false;
  }
  if (names.some((n) => /^\d{4}$/.test(n))) return false;
  return names.some((n) => n.startsWith('%2F') || /^[A-Za-z]%3A/.test(n)) || existsSync(join(p, 'config.toml'));
}

/**
 * Pastas do Grok observadas. HABBLAUD_GROK_DIRS (lista separada por vírgula) substitui a detecção e vale como veio
 * (só precisa existir). Senão: GROK_HOME e `$HOME/.grok*` que passem em isGrokHome. Ordem estável: a padrão
 * primeiro, depois alfabética.
 */
export function discoverGrokDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_GROK_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const found: string[] = [];
  const main = defaultGrokHome(env, home);
  if (isGrokHome(main)) found.push(main);
  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.grok')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(home, ent.name);
      if (isGrokHome(p)) found.push(p);
    }
  } catch {
    // $HOME ilegível (ex.: container sem home)
  }
  const dirs = [...new Set(found.map((p) => expandHome(p, home)))];
  dirs.sort((a, b) => (a === main ? 0 : 1) - (b === main ? 0 : 1) || a.localeCompare(b));
  return dirs;
}

/** Overrides das contas do Grok em HABBLAUD_ACCOUNTS (vindos do host, no Docker). */
export function grokOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'grok');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Letras candidatas de uma conta sem alias: a inicial do sufixo (".grok-trabalho" → T), G, K, R... e o alfabeto. */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?grok[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('G', 'K', 'R', 'Q', 'J', 'H');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface GrokDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Letras e cores já usadas pelas contas das outras ferramentas (não se repetem). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * Uma conta por pasta do Grok, NA MESMA ORDEM de `dirs`. `configDir` é o caminho para exibição (no Docker, o do
 * host, vindo de HABBLAUD_ACCOUNTS). Sem e-mail nem plano (o Grok não os expõe localmente sem ler credenciais).
 */
export function detectGrokAccounts(dirs: string[], opts: GrokDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = grokOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home, 'grok'), home, defaultGrokHome(env, home));
  const ids = accountIds(dirs);
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const ov = matchOverride(overrides, ids[i], resolve(dir), home);
    const short = str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir));
    return { dir, id: str(ov?.id) ?? ids[i], ov, short: short && !usedShorts.has(short.toUpperCase()) ? short : undefined };
  });
  for (const p of partial) if (p.short) usedShorts.add(p.short.toUpperCase());

  return partial.map((p) => {
    const short = p.short ?? letterCandidates(p.dir).find((l) => !usedShorts.has(l)) ?? '?';
    usedShorts.add(short.toUpperCase());
    let color = str(p.ov?.color);
    if (!color) {
      color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[usedColors.size % ACCOUNT_COLORS.length];
      usedColors.add(color);
    }
    return {
      id: p.id,
      provider: 'grok',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `Grok ${short}` : 'Grok'),
      color,
    };
  });
}
