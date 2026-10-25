// Arquivos de uma pasta do Grok (GROK_HOME) que a fonte lê, todos só leitura:
// - `active_sessions.json`: as sessões abertas ({session_id, pid, pid_start, cwd, opened_at}), como o registro
//   <configDir>/sessions/<pid>.json do Claude Code; o Grok regrava o arquivo inteiro (por troca de arquivo) a cada
//   sessão aberta ou fechada;
// - `sessions/<cwd codificado como URL>/<id>/updates.jsonl`: o fluxo ACP da sessão, uma linha JSON por evento (ver
//   updates.ts); `summary.json` ao lado: projeto, título gerado, modelo, branch e horários.
// auth.json, config.toml, a memória, os logs e o resto nunca são abertos.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_SESSIONS_FILE, SESSIONS_DIR } from './accounts';

type Rec = Record<string, unknown>;

/** Id de sessão do Grok (UUID v7). */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_ID.test(v);
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

// ------------------------------------------------------------------ active_sessions.json

export interface ActiveSession {
  sessionId: string;
  pid: number;
  /** Início do processo (µs desde a época), quando o Grok grava. */
  pidStart?: number;
  cwd: string;
  openedAt?: number;
}

export interface ActiveSessionsRead {
  /** null = o arquivo não existe (ou não foi montado no Docker): a presença cai no modo "modificado há pouco". */
  entries: ActiveSession[] | null;
  error?: string;
}

/** Interpreta o conteúdo de active_sessions.json (lista de sessões). Entradas inválidas ficam de fora. */
export function parseActiveSessions(raw: string): ActiveSession[] {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return [];
  }
  return parseActiveSessionList(Array.isArray(j) ? j : rec(j)?.sessions);
}

/**
 * Uma lista de entradas do registro já em JSON (o conteúdo do arquivo, ou a lista que o auxiliar do host manda em
 * POST /api/grok/registry): aceita as chaves do Grok (`session_id`, `pid_start`, `opened_at`) e as já normalizadas
 * (`sessionId`, `pidStart`, `openedAt` em ms). Entradas inválidas ficam de fora.
 */
export function parseActiveSessionList(list: unknown): ActiveSession[] {
  if (!Array.isArray(list)) return [];
  const out: ActiveSession[] = [];
  for (const raw of list) {
    const r = rec(raw);
    const sessionId = (str(r?.session_id) ?? str(r?.sessionId))?.toLowerCase();
    const pid = num(r?.pid);
    const cwd = str(r?.cwd);
    if (!r || !isSessionId(sessionId) || pid === undefined || !cwd) continue;
    const e: ActiveSession = { sessionId, pid, cwd };
    const pidStart = num(r.pid_start) ?? num(r.pidStart);
    const openedAt = toMs(r.opened_at) ?? num(r.openedAt);
    if (pidStart !== undefined) e.pidStart = pidStart;
    if (openedAt !== undefined) e.openedAt = openedAt;
    out.push(e);
  }
  return out;
}

/** Lê active_sessions.json da pasta (sem cache: o arquivo é pequeno e muda de inode a cada escrita). */
export function readActiveSessions(home: string): ActiveSessionsRead {
  const file = join(home, ACTIVE_SESSIONS_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { entries: null };
    return { entries: null, error: code ?? 'erro' };
  }
  return { entries: parseActiveSessions(raw) };
}

// ------------------------------------------------------------------ pastas das sessões

/** Pasta do projeto como o Grok a codifica em sessions/ (encodeURIComponent do cwd). */
export function encodeSessionCwd(cwd: string): string {
  return encodeURIComponent(cwd);
}

/** O cwd a partir do nome da pasta em sessions/ (undefined se não decodificar). */
export function decodeSessionCwd(name: string): string | undefined {
  try {
    const cwd = decodeURIComponent(name);
    return cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd) ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export interface SessionDirInfo {
  sessionId: string;
  /** Pasta da sessão (sessions/<cwd>/<id>). */
  dir: string;
  /** Caminho do updates.jsonl (pode ainda não existir). */
  path: string;
  /** cwd decodificado do nome da pasta do projeto. */
  cwd?: string;
}

/** Todas as pastas de sessão da conta (sessions/<cwd>/<id>). */
export function listSessionDirs(home: string): SessionDirInfo[] {
  const out: SessionDirInfo[] = [];
  const root = join(home, SESSIONS_DIR);
  for (const enc of listDir(root)) {
    const cwd = decodeSessionCwd(enc);
    const projectDir = join(root, enc);
    for (const id of listDir(projectDir)) {
      if (!isSessionId(id)) continue;
      const dir = join(projectDir, id);
      const info: SessionDirInfo = { sessionId: id.toLowerCase(), dir, path: join(dir, 'updates.jsonl') };
      if (cwd) info.cwd = cwd;
      out.push(info);
    }
  }
  return out;
}

/**
 * Onde está a pasta de cada sessão, com cache. Com o cwd conhecido (registro ou hook) o caminho é direto; sem ele,
 * ou se a pasta não estiver lá (cwd gravado de outro jeito), uma varredura de sessions/ (no máximo a cada 10 s).
 */
export class SessionIndex {
  private dirs = new Map<string, SessionDirInfo>();
  private lastScan = -Infinity;

  constructor(
    readonly home: string,
    private readonly now: () => number = Date.now,
  ) {}

  find(sessionId: string, cwd?: string): SessionDirInfo | undefined {
    const id = sessionId.toLowerCase();
    const hit = this.dirs.get(id);
    if (hit && existsSync(hit.dir)) return hit;
    if (hit) this.dirs.delete(id);
    if (cwd) {
      const dir = join(this.home, SESSIONS_DIR, encodeSessionCwd(cwd), id);
      if (existsSync(dir)) {
        const info: SessionDirInfo = { sessionId: id, dir, path: join(dir, 'updates.jsonl'), cwd };
        this.dirs.set(id, info);
        return info;
      }
    }
    const now = this.now();
    if (now - this.lastScan >= 10_000) {
      this.lastScan = now;
      this.scanAll();
    }
    return this.dirs.get(id);
  }

  scanAll(): void {
    this.lastScan = this.now();
    for (const info of listSessionDirs(this.home)) this.dirs.set(info.sessionId, info);
  }

  /** Sessões cujo updates.jsonl foi modificado nos últimos `maxAgeMs` (com stat de cada um): presença sem o registro. */
  recentlyModified(maxAgeMs: number): Array<SessionDirInfo & { mtimeMs: number }> {
    const now = this.now();
    const out: Array<SessionDirInfo & { mtimeMs: number }> = [];
    for (const info of listSessionDirs(this.home)) {
      this.dirs.set(info.sessionId, info);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(info.path).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs <= maxAgeMs) out.push({ ...info, mtimeMs });
    }
    this.lastScan = now;
    return out;
  }
}

// ------------------------------------------------------------------ summary.json

export interface GrokSummary {
  sessionId?: string;
  cwd?: string;
  /** Título gerado pelo Grok (generated_title) ou o resumo da sessão. */
  title?: string;
  model?: string;
  agentName?: string;
  gitRoot?: string;
  gitBranch?: string;
  createdAt?: number;
  updatedAt?: number;
  lastActiveAt?: number;
  numMessages?: number;
  /** "headless" nas sessões sem terminal (ex.: `grok -p`). */
  sessionKind?: string;
}

export function parseSummary(raw: string): GrokSummary | undefined {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const r = rec(j);
  if (!r) return undefined;
  const info = rec(r.info);
  const s: GrokSummary = {};
  const id = str(info?.id);
  if (isSessionId(id)) s.sessionId = id.toLowerCase();
  const cwd = str(info?.cwd);
  if (cwd) s.cwd = cwd;
  const title = str(r.generated_title) ?? str(r.session_summary);
  if (title) s.title = title.slice(0, 200);
  const model = str(r.current_model_id);
  if (model) s.model = model;
  const agent = str(r.agent_name);
  if (agent) s.agentName = agent;
  const root = str(r.git_root_dir);
  if (root) s.gitRoot = root;
  const branch = str(r.head_branch);
  if (branch && branch !== 'HEAD') s.gitBranch = branch;
  const createdAt = toMs(r.created_at);
  const updatedAt = toMs(r.updated_at);
  const lastActiveAt = toMs(r.last_active_at);
  if (createdAt !== undefined) s.createdAt = createdAt;
  if (updatedAt !== undefined) s.updatedAt = updatedAt;
  if (lastActiveAt !== undefined) s.lastActiveAt = lastActiveAt;
  const n = num(r.num_messages);
  if (n !== undefined) s.numMessages = n;
  const kind = str(r.session_kind);
  if (kind) s.sessionKind = kind;
  return s;
}

/** Lê summary.json da pasta da sessão (undefined se não existe ou é ilegível). */
export function readSummary(sessionDir: string): { summary: GrokSummary; mtimeMs: number } | undefined {
  const file = join(sessionDir, 'summary.json');
  try {
    const mtimeMs = statSync(file).mtimeMs;
    const summary = parseSummary(readFileSync(file, 'utf8'));
    return summary ? { summary, mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}
