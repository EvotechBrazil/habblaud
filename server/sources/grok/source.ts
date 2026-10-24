// Fonte de agentes do Grok (AgentSource 'grok', ver sources/source.ts): o Grok Build CLI da xAI, que grava em
// GROK_HOME (~/.grok). Observa as sessões ABERTAS de cada conta do Grok e alimenta o Office; os eventos dos hooks
// (GrokLive, via POST /api/grok/events) chegam por applyHookEvent e adiantam o que os arquivos ainda não contam.
//
// Presença:
// - `active_sessions.json` lista as sessões abertas ({session_id, pid, cwd...}), como o registro do Claude Code.
//   Fora do Docker o PID é conferido (uma entrada pode sobrar depois de um crash); no Docker os PIDs são do host e
//   o arquivo nem chega lá (o Grok o troca de inode a cada escrita, e uma montagem de arquivo ficaria presa na cópia
//   antiga). Lá, quem traz o registro é o auxiliar do host (scripts/codex-bridge.ts, npm run bridge): ele lê o
//   arquivo, confere os PIDs e manda a lista em POST /api/grok/registry a cada 2 s (applyRegistry); a lista vale por
//   BRIDGE_REGISTRY_TTL_MS, depois a presença cai no modo seguinte;
// - sem registro nenhum: sessão aberta = updates.jsonl modificado nos últimos 30 min (FALLBACK_RECENT_MS), e uma
//   sessão que um hook abriu (SessionStart) fica até o SessionEnd ou 12 h sem nada novo;
// - um evento de hook segura o agente presente por HOOK_PRESENCE_MS mesmo fora do registro (ex.: `grok -p`);
//   SessionEnd fecha (se o registro também já não o tem, ou depois de SESSION_END_GRACE_MS);
// - sem registro = fechada (com a mesma folga de 1,5 s do Claude Code).
// Sala = o cwd do registro (ou do summary.json, ou do hook). O Grok não grava um arquivo por subagente: os
// subagentes entram só como número (stats.subagents) e como atividade "Delegando".
//
// Status: aplicado por bordas (instrução e turn_completed no updates.jsonl, eventos de hook), a informação mais nova
// vence; o arquivo nunca grava "esperando você": só o hook Notification (permission_prompt) levanta a mão. Boot curto
// e síncrono (só a janela final de arquivos grandes; o começo é lido depois, em segundo plano, até PREFIX_MAX_BYTES).
import { createReadStream, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import { pidAlive } from '../registry';
import type { AgentSource } from '../source';
import { FileTail, LineBuffer, warnOversizedLine } from '../tail';
import type { TerminalParser } from '../terminal';
import { ACTIVE_SESSIONS_FILE, detectGrokAccounts } from './accounts';
import { isSessionId, readActiveSessions, readSummary, SessionIndex, type ActiveSession, type GrokSummary } from './files';
import type { GrokLive } from './live';
import { createGrokState, describeGrokTool, parseUpdateLine, type GrokLineResult, type GrokState } from './updates';
import { createGrokTerminalParser } from './terminal';
import { tr } from '../../../shared/i18n';

/** Sem `active_sessions.json` nem o auxiliar (Docker): presença = updates.jsonl modificado nos últimos 30 min. */
export const FALLBACK_RECENT_MS = 30 * 60_000;
/** O registro mandado pelo auxiliar do host (POST /api/grok/registry, a cada 2 s) vale por este tempo. */
export const BRIDGE_REGISTRY_TTL_MS = 15_000;
/** Sessão aberta por hook (sem o registro): fecha sem nada novo (arquivo ou hook) por este tempo. */
export const STALE_HOOK_MS = 12 * 3600_000;
/** Um evento de hook segura o agente presente por este tempo (fora do registro). */
export const HOOK_PRESENCE_MS = 60_000;
/** SessionEnd com a sessão ainda no registro: fecha mesmo assim depois disto. */
export const SESSION_END_GRACE_MS = 5_000;
/** Tempo que a sessão precisa ficar ausente para ser dada como encerrada. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/** 'working' sem nenhuma escrita no arquivo nem evento de hook por este tempo: o turno morreu (crash). */
export const WORKING_QUIET_MS = 30 * 60_000;
/** Sem eventos de turno: escreveu há pouco = trabalhando. */
const LEGACY_WORKING_MS = 90_000;
/** Atividades recuperadas do começo de um arquivo grande para a linha do tempo longa. */
const PREFIX_HISTORY = 120;
/** Começo do arquivo lido em segundo plano só até este tamanho (um updates.jsonl pode passar de 300 MB). */
export const PREFIX_MAX_BYTES = 32 * 1024 * 1024;
/** Resultados guardados ao ler um arquivo antes de o agente entrar no escritório. */
const BACKLOG_MAX = 400;
const MAIN_ROLE = tr('Agente principal (Grok)');

const HOOK_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Notification',
  'Stop',
  'StopFailure',
  'StopCancelled',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
]);

export interface GrokSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas do Grok lidas por este processo (no Docker, as montadas), uma por conta. */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /** Confere o PID das sessões do registro (fora do Docker). */
  checkPid?: boolean;
  isAlive?: (pid: number) => boolean;
  /** Quanto do fim de cada updates.jsonl é lido ao abrir a sessão (padrão 1 MB). */
  tailBytes?: number;
  /** Desliga o fs.watch (testes). */
  watch?: boolean;
}

interface GrokAccount {
  id: string;
  /** Pasta lida por este processo. */
  dir: string;
  /** Pasta para exibir (no Docker, a do host). */
  configDir: string;
  index: SessionIndex;
  /** Registro em vigor no último ciclo (null = sem o arquivo e sem o auxiliar). */
  active: Map<string, ActiveSession> | null;
  /** Último registro mandado pelo auxiliar do host (já só com os processos vivos) e quando chegou. */
  bridged?: { at: number; entries: readonly ActiveSession[] };
  /** Modo sem registro: arquivos modificados há pouco (sessão → mtime), revistos a cada 10 s. */
  recent: Map<string, { mtimeMs: number; cwd?: string }>;
  recentAt: number;
  error?: string;
}

interface SessionTracker {
  key: string;
  acc: GrokAccount;
  sessionId: string;
  /** cwd pelo registro, pelo summary.json ou pelo hook. */
  cwd?: string;
  dir?: string;
  path?: string;
  nextResolveAt: number;
  tail?: FileTail;
  state: GrokState;
  summary?: GrokSummary;
  summaryMtime?: number;
  /** Resultados lidos antes de o agente entrar no escritório (vão como histórico, sem feed). */
  backlog: GrokLineResult[];
  inOffice: boolean;
  status: AgentStatus;
  /** Quando o status foi decidido (linha do arquivo ou evento de hook): informação mais velha não o muda. */
  statusAt: number;
  waitingFor?: string;
  lastHookAt?: number;
  /** SessionStart visto (e nenhum SessionEnd depois). */
  hookOpen?: boolean;
  /** mtime do updates.jsonl na última leitura. */
  lastWriteAt?: number;
  endedAt?: number;
  missingSince?: number;
  startedAt?: number;
  watcher?: FSWatcher;
}

type Via = 'registry' | 'bridge' | 'recent' | 'hook';

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function normPath(p: string): string {
  try {
    return resolve(p);
  } catch {
    return p;
  }
}

export class GrokSource implements AgentSource, GrokLive {
  readonly provider = 'grok' as const;
  private accs: GrokAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private sessions = new Map<string, SessionTracker>();
  private dirWatchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt = 0;
  private prefixChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly tailBytes: number;
  private readonly useWatch: boolean;
  private readonly checkPid: boolean;
  private readonly isAlive: (pid: number) => boolean;
  private stopped = false;

  constructor(private readonly opts: GrokSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
    this.useWatch = opts.watch ?? true;
    this.checkPid = opts.checkPid ?? true;
    this.isAlive = opts.isAlive ?? pidAlive;
    const env = opts.env ?? process.env;
    const others = opts.accounts.allEntries();
    this.detected = detectGrokAccounts(opts.dirs, {
      env,
      home: opts.home,
      taken: { shorts: others.map((e) => e.detected.short), colors: others.map((e) => e.detected.color) },
    });
    this.register();
  }

  /** Registra as contas no AccountsService, sempre na mesma ordem: os ids não mudam. */
  private register(): void {
    const entries = this.opts.accounts.setProviderAccounts(
      'grok',
      this.opts.dirs.map((dir, i) => ({ dir, detected: this.detected[i] })),
    );
    this.entries = entries;
    const prev = new Map(this.accs.map((a) => [a.dir, a]));
    this.accs = entries.map((e) => {
      const old = prev.get(e.dir);
      if (old) {
        old.id = e.id;
        old.configDir = e.detected.configDir;
        return old;
      }
      return { id: e.id, dir: e.dir, configDir: e.detected.configDir, index: new SessionIndex(e.dir, this.now), active: null, recent: new Map(), recentAt: -Infinity };
    });
  }

  /** Contas do Grok (ids finais, no AccountsService). */
  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  /** Reconstrói as sessões abertas sem gerar avisos. Síncrono e curto. */
  boot(): void {
    this.opts.office.beginBoot();
    try {
      for (const acc of this.accs) acc.index.scanAll();
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
    for (const t of this.sessions.values()) this.unwatch(t);
  }

  sources(): SourceInfo[] {
    return this.accs.map((acc) => {
      let sessions = 0;
      for (const t of this.sessions.values()) if (t.acc === acc && t.inOffice) sessions++;
      const info: SourceInfo = { label: acc.id, provider: 'grok', path: acc.configDir, sessions, ok: !acc.error };
      if (acc.error) info.error = acc.error;
      return info;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.sessions.get(agentId);
    return t?.inOffice ? t.path : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.sessions.has(agentId) ? createGrokTerminalParser() : undefined;
  }

  /** Espera as leituras do começo dos arquivos (testes). */
  idle(): Promise<void> {
    return this.prefixChain;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`grok-poll:${errMsg(err)}`, tr('Grok: falha no ciclo de leitura: {0}', [errMsg(err)]));
    }
  }

  private schedule(): void {
    if (this.kick || this.stopped) return;
    const wait = Math.max(60, 150 - (this.now() - this.lastPollAt));
    this.kick = setTimeout(() => {
      this.kick = null;
      this.safePoll();
    }, wait);
    this.kick.unref?.();
  }

  poll(boot = false): void {
    const now = (this.lastPollAt = this.now());
    const seen = new Set<string>();
    for (const acc of this.accs) {
      const present = this.presentSessions(acc, now);
      for (const [sessionId, via] of present) {
        const key = `${acc.id}:${sessionId}`;
        let t = this.sessions.get(key);
        if (!t) {
          t = this.newTracker(acc, sessionId);
          this.sessions.set(key, t);
        }
        try {
          this.syncSession(t, via, now, boot);
        } catch (err) {
          log.warnOnce(`grok-session:${key}:${errMsg(err)}`, tr('Grok: sessão {0}: {1}', [key, errMsg(err)]));
        }
        seen.add(key);
      }
    }
    for (const [key, t] of [...this.sessions]) {
      if (seen.has(key)) continue;
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      this.leave(t);
      this.unwatch(t);
      this.sessions.delete(key);
    }
  }

  /**
   * Sessões presentes de uma conta e por quê: 'registry' (active_sessions.json lido aqui, com o PID vivo), 'bridge'
   * (o registro que o auxiliar do host mandou há menos de BRIDGE_REGISTRY_TTL_MS, PIDs já conferidos lá), 'recent'
   * (sem registro: updates.jsonl modificado há pouco ou sessão aberta por hook) ou 'hook' (evento de hook recente).
   */
  private presentSessions(acc: GrokAccount, now: number): Map<string, Via> {
    const out = new Map<string, Via>();
    const read = readActiveSessions(acc.dir);
    acc.error = read.error ? tr('{0} ilegível ({1})', [ACTIVE_SESSIONS_FILE, read.error]) : undefined;
    const bridged = !read.entries && acc.bridged && now - acc.bridged.at < BRIDGE_REGISTRY_TTL_MS ? acc.bridged.entries : undefined;
    if (read.entries) {
      acc.active = new Map();
      this.watchDir(acc.dir);
      for (const e of read.entries) {
        if (this.checkPid && !this.isAlive(e.pid)) continue;
        acc.active.set(e.sessionId, e);
        out.set(e.sessionId, 'registry');
      }
    } else if (bridged) {
      acc.active = new Map();
      for (const e of bridged) {
        acc.active.set(e.sessionId, e);
        out.set(e.sessionId, 'bridge');
      }
    } else {
      acc.active = null;
      if (now - acc.recentAt >= 10_000) {
        acc.recentAt = now;
        acc.recent = new Map(acc.index.recentlyModified(FALLBACK_RECENT_MS).map((r) => [r.sessionId, { mtimeMs: r.mtimeMs, cwd: r.cwd }]));
      }
      for (const [sessionId, r] of acc.recent) {
        const t = this.sessions.get(`${acc.id}:${sessionId}`);
        const last = Math.max(r.mtimeMs, t?.lastWriteAt ?? 0);
        if (now - last <= FALLBACK_RECENT_MS) out.set(sessionId, 'recent');
      }
      // Sessão aberta por hook (SessionStart sem SessionEnd): fica enquanto houver sinal de vida.
      for (const t of this.sessions.values()) {
        if (t.acc !== acc || out.has(t.sessionId) || !t.hookOpen) continue;
        const last = Math.max(t.lastWriteAt ?? 0, t.lastHookAt ?? 0);
        if (now - last < STALE_HOOK_MS) out.set(t.sessionId, 'recent');
      }
    }
    for (const t of this.sessions.values()) {
      if (t.acc !== acc || out.has(t.sessionId)) continue;
      if (t.lastHookAt !== undefined && now - t.lastHookAt < HOOK_PRESENCE_MS) out.set(t.sessionId, 'hook');
    }
    return out;
  }

  private newTracker(acc: GrokAccount, sessionId: string): SessionTracker {
    return {
      key: `${acc.id}:${sessionId}`,
      acc,
      sessionId,
      nextResolveAt: 0,
      state: createGrokState(),
      backlog: [],
      inOffice: false,
      status: 'idle',
      statusAt: 0,
    };
  }

  /** Um ciclo de uma sessão presente: acha/lê o arquivo e decide se ela está (ou continua) no escritório. */
  private syncSession(t: SessionTracker, via: Via, now: number, boot: boolean): void {
    delete t.missingSince;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false; // saiu do escritório (graça encerrada)
    const entry = t.acc.active?.get(t.sessionId);
    if (entry) {
      t.cwd ??= entry.cwd;
      t.startedAt ??= entry.openedAt;
    } else if (via === 'recent') {
      t.cwd ??= t.acc.recent.get(t.sessionId)?.cwd;
    }
    this.pump(t, boot);
    this.reconcile(t, now);
    if (t.inOffice) {
      this.quietCheck(t, now);
      this.opts.office.fillWorkingActivity(t.key);
    }
  }

  /** A sessão deve estar no escritório agora? Entra ou sai conforme o caso. */
  private reconcile(t: SessionTracker, now: number): void {
    const want = this.wanted(t, now);
    if (!want) {
      if (t.inOffice) this.leave(t);
      return;
    }
    if (!t.inOffice) this.enter(t, now);
  }

  private wanted(t: SessionTracker, now: number): boolean {
    // SessionEnd: fecha, a não ser que algo novo tenha acontecido depois.
    if (t.endedAt !== undefined) {
      const inRegistry = !!t.acc.active?.has(t.sessionId);
      const newer = (t.lastHookAt ?? 0) > t.endedAt || (t.lastWriteAt ?? 0) > t.endedAt + 1_000;
      if (newer) delete t.endedAt;
      else if (!inRegistry || now - t.endedAt >= SESSION_END_GRACE_MS) return false;
    }
    // Sem o projeto não há sala: espera o registro, o summary.json ou um hook dizer o cwd.
    return !!this.cwdOf(t);
  }

  /** Projeto conhecido da sessão (registro, summary.json ou hook). */
  private cwdOf(t: SessionTracker): string | undefined {
    return t.cwd ?? t.summary?.cwd;
  }

  private enter(t: SessionTracker, now: number): void {
    const office = this.opts.office;
    office.addMain({
      id: t.key,
      provider: 'grok',
      account: t.acc.id,
      sessionId: t.sessionId,
      cwd: this.cwdOf(t)!,
      role: MAIN_ROLE,
      startedAt: t.summary?.createdAt ?? t.startedAt ?? t.state.firstAt ?? now,
      status: t.status,
      waitingFor: t.waitingFor,
    });
    t.inOffice = office.has(t.key);
    if (!t.inOffice) return;
    // Reaberta dentro do período de graça: o status pode ter mudado enquanto esteve fora.
    office.setStatus(t.key, t.status, t.waitingFor);
    this.flushBacklog(t);
    this.applySummary(t);
  }

  private leave(t: SessionTracker): void {
    if (!t.inOffice) return;
    this.opts.office.closeMain(t.key);
    t.inOffice = false;
  }

  private statusToOffice(t: SessionTracker): void {
    if (t.inOffice) this.opts.office.setStatus(t.key, t.status, t.waitingFor);
  }

  // ---------------------------------------------------------------- updates.jsonl

  /** Acha a pasta da sessão (sem pressa: no máximo a cada 3 s) e lê o que for novo. */
  private pump(t: SessionTracker, boot: boolean): void {
    const now = this.now();
    if (now >= t.nextResolveAt) {
      t.nextResolveAt = now + (boot ? 0 : 3_000);
      const info = t.acc.index.find(t.sessionId, t.cwd);
      if (info) {
        t.dir = info.dir;
        t.cwd ??= info.cwd;
        this.refreshSummary(t);
        if (!t.tail && this.exists(info.path)) this.load(t, info.path);
      }
    }
    if (!t.tail) return;
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = t.tail.read();
      } catch (err) {
        log.warnOnce(`grok-read:${t.key}`, tr('Grok: updates.jsonl de {0} ilegível ({1}).', [t.key, errMsg(err)]));
        return;
      }
      if (r.missing) {
        this.unwatch(t);
        delete t.tail;
        delete t.path;
        t.nextResolveAt = 0;
        return;
      }
      t.lastWriteAt = t.tail.mtimeMs;
      if (r.reset) {
        this.load(t, t.tail.path);
        return;
      }
      for (const line of r.lines) this.apply(t, parseUpdateLine(t.state, line, { idPrefix: t.key, now: this.now() }), true);
      if (r.lines.length) this.applySummary(t);
      if (!r.more) break;
    }
  }

  private exists(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  /** Relê o summary.json quando ele muda (título gerado, modelo, branch). */
  private refreshSummary(t: SessionTracker): void {
    if (!t.dir) return;
    const r = readSummary(t.dir);
    if (!r || r.mtimeMs === t.summaryMtime) return;
    t.summaryMtime = r.mtimeMs;
    t.summary = r.summary;
    if (!t.cwd && r.summary.cwd) t.cwd = r.summary.cwd;
    this.applySummary(t);
  }

  /** Lê a janela do fim do arquivo; o começo vai em segundo plano (até PREFIX_MAX_BYTES). */
  private load(t: SessionTracker, path: string): void {
    this.unwatch(t);
    const tail = new FileTail(path);
    const start = tail.seekTail(this.tailBytes);
    t.tail = tail;
    t.path = path;
    t.state = createGrokState();
    t.backlog = [];
    for (let i = 0; i < 64; i++) {
      const r = tail.read();
      for (const line of r.lines) this.apply(t, parseUpdateLine(t.state, line, { idPrefix: t.key, now: this.now() }), false);
      if (!r.more) break;
    }
    t.lastWriteAt = tail.mtimeMs;
    this.settleStatus(t);
    if (t.inOffice) {
      this.flushBacklog(t);
      this.statusToOffice(t);
    }
    this.applySummary(t);
    this.watchFile(t, path);
    if (start > 0) this.queuePrefix(t, path, start);
  }

  /**
   * Status depois de ler a janela do arquivo: o turno aberto (ou, sem eventos de turno, uma escrita recente) é
   * 'working'. Um status mais novo vindo de hook vence.
   */
  private settleStatus(t: SessionTracker): void {
    const s = t.state;
    const at = s.lastAt ?? 0;
    if (at < t.statusAt) return;
    let status: AgentStatus;
    if (s.turnOpen !== undefined) status = s.turnOpen ? 'working' : 'idle';
    else status = s.lastAt !== undefined && this.now() - s.lastAt < LEGACY_WORKING_MS ? 'working' : 'idle';
    if (status === 'working' && this.now() - Math.max(t.lastWriteAt ?? 0, at) > WORKING_QUIET_MS) status = 'idle';
    t.status = status;
    t.statusAt = at;
    delete t.waitingFor;
  }

  /** Aplica um resultado de linha: ao vivo vai direto ao escritório; na carga inicial, fica no backlog. */
  private apply(t: SessionTracker, r: GrokLineResult, live: boolean): void {
    for (const sig of r.signals) {
      switch (sig.type) {
        case 'turnStart':
          this.decide(t, 'working', r.at, undefined, live);
          break;
        case 'turnEnd':
          this.decide(t, 'idle', r.at, undefined, live);
          break;
        case 'progress':
          if (t.status === 'waiting') this.decide(t, 'working', r.at, undefined, live);
          break;
        default:
          break;
      }
    }
    if (!live || !t.inOffice) {
      if (r.activities.length || r.signals.some((s) => s.type === 'github')) {
        t.backlog.push(r);
        if (t.backlog.length > BACKLOG_MAX) t.backlog.splice(0, t.backlog.length - BACKLOG_MAX);
      }
      return;
    }
    this.toOffice(t, r, true);
  }

  private toOffice(t: SessionTracker, r: GrokLineResult, live: boolean): void {
    const office = this.opts.office;
    for (const a of r.activities) office.addActivity(t.key, a.activity, a.current, { feed: live });
    for (const sig of r.signals) {
      if (sig.type === 'github') office.githubEvent(t.key, sig.event, { key: sig.key, at: r.at, live });
    }
  }

  private flushBacklog(t: SessionTracker): void {
    const backlog = t.backlog;
    t.backlog = [];
    for (const r of backlog) this.toOffice(t, r, false);
  }

  /** Muda o status por uma borda (instrução, fim de turno, hook): informação mais velha que a última decisão não vale. */
  private decide(t: SessionTracker, status: AgentStatus, at: number, waitingFor: string | undefined, live: boolean): void {
    if (at < t.statusAt) return;
    t.statusAt = at;
    t.status = status;
    if (waitingFor) t.waitingFor = waitingFor;
    else delete t.waitingFor;
    if (live) this.statusToOffice(t);
  }

  /** 'working' sem nenhuma notícia por muito tempo (turno morto num crash): vira 'idle'. */
  private quietCheck(t: SessionTracker, now: number): void {
    if (t.status !== 'working') return;
    const last = Math.max(t.lastWriteAt ?? 0, t.lastHookAt ?? 0, t.statusAt);
    if (now - last > WORKING_QUIET_MS) this.decide(t, 'idle', now, undefined, true);
  }

  private applySummary(t: SessionTracker): void {
    if (!t.inOffice) return;
    const s = t.state;
    const summary: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
    const title = t.summary?.title ?? s.title;
    if (title) summary.title = title;
    const model = s.model ?? t.summary?.model;
    if (model) summary.model = model;
    if (t.summary?.gitBranch) summary.gitBranch = t.summary.gitBranch;
    if (s.firstAt !== undefined) summary.firstAt = s.firstAt;
    const lastAt = Math.max(s.lastAt ?? 0, t.summary?.lastActiveAt ?? 0);
    if (lastAt) summary.lastAt = lastAt;
    this.opts.office.applyTranscript(t.key, summary);
  }

  /** Começo de um arquivo grande (antes da janela lida): números, título e a linha do tempo longa. */
  private queuePrefix(t: SessionTracker, path: string, end: number): void {
    if (end > PREFIX_MAX_BYTES) {
      log.warnOnce(`grok-prefix-big:${path}`, tr('Grok: o começo de {0} ({1} MB) não foi lido: os números da sessão contam só a parte final.', [basename(t.dir ?? path), Math.round(end / 1_048_576)]));
      return;
    }
    const state = t.state;
    this.prefixChain = this.prefixChain
      .then(async () => {
        if (this.stopped) return;
        const prefix = await scanPrefix(path, end, t.key, PREFIX_HISTORY);
        if (this.sessions.get(t.key) !== t || t.state !== state) return;
        state.stats.toolCalls += prefix.state.stats.toolCalls;
        state.stats.subagents += prefix.state.stats.subagents;
        state.stats.tokensIn += prefix.state.stats.tokensIn;
        state.stats.tokensOut += prefix.state.stats.tokensOut;
        state.title ??= prefix.state.title;
        state.model ??= prefix.state.model;
        if (!state.tasks.length && prefix.state.tasks.length) state.tasks = prefix.state.tasks;
        if (prefix.state.firstAt !== undefined && (state.firstAt === undefined || prefix.state.firstAt < state.firstAt)) state.firstAt = prefix.state.firstAt;
        this.applySummary(t);
        if (t.inOffice) this.opts.office.mergeHistory(t.key, prefix.activities);
      })
      .catch((err) => log.warnOnce(`grok-prefix:${path}`, tr('Grok: não foi possível ler o início de um updates.jsonl ({0}).', [errMsg(err)])));
  }

  // ---------------------------------------------------------------- registro pelo auxiliar (GrokLive)

  applyRegistry(account: string | undefined, sessions: readonly ActiveSession[]): boolean {
    // Só a conta nomeada (id ou pasta): a lista de uma pasta do Grok que o container não conhece nunca cai em outra.
    const acc = this.accountByRef(account);
    if (!acc) return false;
    acc.bridged = { at: this.now(), entries: sessions };
    this.schedule();
    return true;
  }

  // ---------------------------------------------------------------- hooks (GrokLive)

  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    try {
      return this.hookEvent(account, input);
    } catch (err) {
      log.warnOnce(`grok-hook:${errMsg(err)}`, tr('Grok: evento de hook ignorado ({0}).', [errMsg(err)]));
      return false;
    }
  }

  private hookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    const event = str(input.hook_event_name);
    if (!event || !HOOK_EVENTS.has(event)) return false;
    const sessionId = (str(input.session_id) ?? str(input.sessionId))?.toLowerCase();
    if (!isSessionId(sessionId)) return false;
    const acc = this.accountFor(account, sessionId);
    if (!acc) return false;
    const now = this.now();
    const cwd = str(input.cwd) ?? str(input.workspaceRoot);
    const office = this.opts.office;

    if (event === 'SessionEnd') {
      const t = this.sessions.get(`${acc.id}:${sessionId}`);
      if (!t) return false;
      t.endedAt = now;
      t.hookOpen = false;
      delete t.lastHookAt;
      this.reconcile(t, now);
      this.schedule();
      return true;
    }

    const t = this.touch(acc, sessionId, now, cwd);
    if (event === 'SessionStart') t.hookOpen = true;
    this.reconcile(t, now);

    switch (event) {
      case 'UserPromptSubmit':
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
      case 'PreCompact':
      case 'PostCompact':
        this.decide(t, 'working', now, undefined, true);
        break;
      case 'PreToolUse': {
        this.decide(t, 'working', now, undefined, true);
        const toolName = str(input.tool_name) ?? str(input.toolName) ?? 'ferramenta';
        const toolInput = rec(input.tool_input) ?? rec(input.toolInput) ?? {};
        const { desc, tool } = describeGrokTool(toolName, toolInput);
        const id = str(input.tool_use_id) ?? str(input.toolUseId);
        const act: Activity = { id: `${t.key}#${id ?? `hook${now.toString(36)}`}`, at: now, ...desc, tool };
        if (t.inOffice) office.addActivity(t.key, act, true);
        break;
      }
      case 'SubagentStart': {
        this.decide(t, 'working', now, undefined, true);
        t.state.stats.subagents++;
        const type = str(input.subagent_type) ?? str(input.subagentType) ?? str(input.agent_type);
        const { desc, tool } = describeGrokTool('spawn_subagent', { description: type, subagent_type: type });
        const act: Activity = { id: `${t.key}#sub${now.toString(36)}`, at: now, ...desc, tool };
        if (t.inOffice) office.addActivity(t.key, act, true);
        this.applySummary(t);
        break;
      }
      case 'Notification': {
        const type = (str(input.notification_type) ?? str(input.notificationType) ?? str(input.type) ?? str(input.matcher) ?? '').toLowerCase();
        if (type === 'permission_prompt') this.decide(t, 'waiting', now, tr('aprovar uma permissão'), true);
        else if (type === 'idle_prompt') this.decide(t, 'idle', now, undefined, true);
        break;
      }
      case 'Stop':
      case 'StopFailure':
      case 'StopCancelled':
        this.decide(t, 'idle', now, undefined, true);
        break;
      default:
        break;
    }
    return true;
  }

  /** Rastreador da sessão (criado se preciso), com a presença dada pelo hook. */
  private touch(acc: GrokAccount, sessionId: string, now: number, cwd: string | undefined): SessionTracker {
    const key = `${acc.id}:${sessionId}`;
    let t = this.sessions.get(key);
    if (!t) {
      t = this.newTracker(acc, sessionId);
      this.sessions.set(key, t);
    }
    t.lastHookAt = now;
    delete t.missingSince;
    if (t.endedAt !== undefined && now > t.endedAt) delete t.endedAt;
    if (cwd) t.cwd ??= cwd;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false;
    this.pump(t, false);
    return t;
  }

  /** Conta pelo id ou pela pasta (lida aqui ou a do host), exatamente. */
  private accountByRef(ref: string | undefined): GrokAccount | undefined {
    if (!ref) return undefined;
    const byId = this.accs.find((a) => a.id === ref);
    if (byId) return byId;
    const abs = normPath(ref);
    return this.accs.find((a) => normPath(a.dir) === abs || normPath(a.configDir) === abs);
  }

  /** Conta de um evento: `account` (id ou pasta); senão a que já conhece a sessão; com uma conta só, ela. */
  private accountFor(account: string | undefined, sessionId: string): GrokAccount | undefined {
    const exact = this.accountByRef(account);
    if (exact) return exact;
    const known = this.accs.filter((a) => this.sessions.has(`${a.id}:${sessionId}`) || a.active?.has(sessionId));
    if (known.length === 1) return known[0];
    if (account) {
      const byName = this.accs.find((a) => basename(a.dir) === basename(account) || basename(a.configDir) === basename(account));
      if (byName) return byName;
    }
    return this.accs.length === 1 ? this.accs[0] : undefined;
  }

  // ---------------------------------------------------------------- fs.watch (acelerador)

  private watchDir(dir: string): void {
    if (!this.useWatch || this.dirWatchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, (_, name) => {
        if (!name || String(name) === ACTIVE_SESSIONS_FILE) this.schedule();
      });
      w.on('error', () => {
        w.close();
        this.dirWatchers.delete(dir);
      });
      this.dirWatchers.set(dir, w);
    } catch {
      // sem suporte: o polling cobre
    }
  }

  private watchFile(t: SessionTracker, path: string): void {
    if (!this.useWatch) return;
    this.unwatch(t);
    try {
      const w = watch(path, { persistent: false }, () => this.schedule());
      w.on('error', () => w.close());
      t.watcher = w;
    } catch {
      // sem suporte: o polling cobre
    }
  }

  private unwatch(t: SessionTracker): void {
    t.watcher?.close();
    delete t.watcher;
  }
}

/** Lê em stream os bytes [0, end) de um updates.jsonl: números, título e as últimas `keep` atividades antes da janela. */
export async function scanPrefix(path: string, end: number, idPrefix: string, keep: number): Promise<{ state: GrokState; activities: Activity[] }> {
  const state = createGrokState();
  let activities: Activity[] = [];
  if (end <= 0) return { state, activities };
  const ctx = { idPrefix, now: Date.now(), activities: keep > 0 };
  const take = (line: string) => {
    const r = parseUpdateLine(state, line, ctx);
    for (const a of r.activities) activities.push(a.activity);
    if (activities.length > keep * 2) activities = activities.slice(-keep);
  };
  const pending = new LineBuffer();
  let discarded = 0;
  const stream = createReadStream(path, { start: 0, end: end - 1, highWaterMark: 1024 * 1024 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const fed = pending.push(chunk);
    discarded += fed.discarded;
    for (const buf of fed.lines) {
      const line = buf.toString('utf8');
      if (line) take(line);
    }
  }
  const rest = pending.flush();
  if (rest?.length) take(rest.toString('utf8'));
  if (discarded) warnOversizedLine(path);
  return { state, activities: activities.slice(-keep) };
}

/** O id da sessão num caminho sessions/<cwd>/<id>/updates.jsonl (para validar hints de hooks). */
export function sessionIdOfPath(path: string): string | undefined {
  const id = basename(join(path, '..'));
  return isSessionId(id) ? id.toLowerCase() : undefined;
}

export { sep };
