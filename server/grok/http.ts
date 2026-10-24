// Eventos dos hooks do Grok (mod/habblaud-grok/hook.mjs, que npm run grok:install grava em <GROK_HOME>/hooks/
// habblaud.json): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Notification, Stop,
// StopFailure, StopCancelled, SubagentStart, SubagentStop e SessionEnd chegam aqui com a conta e vão para a fonte do
// Grok (GrokLive), que atualiza o agente na hora, sem esperar a conversa chegar ao arquivo. Os eventos só observam (a
// resposta nunca volta para a sessão), mas só valem vindos do próprio computador: a trava (Host local e, fora do
// Docker, conexão pelo loopback) é conferida em http/app.ts. O guard (http/guard.ts) já exigiu JSON.
//
//   POST /api/grok/events   (hook)   {account?, grokHome?, event: <stdin do hook, textos cortados>}: 200 {ok}
//   POST /api/grok/registry (auxiliar do host, scripts/codex-bridge.ts) {registries: [{account?, grokHome?,
//                           sessions: [<entradas do active_sessions.json com o processo vivo>],
//                           usage?: <a cota lida no log do Grok, sources/grok/billing.ts>}]}: 200 {ok, applied}
// O registro só faz sentido no Docker (o container não vê o active_sessions.json do host): a fonte guarda a lista por
// pouco tempo (BRIDGE_REGISTRY_TTL_MS) e, se o auxiliar parar de mandar, volta a decidir pelos arquivos e hooks. A
// cota (`usage`, só a semanal) vai junto porque o container também não monta logs/; inválida, é ignorada (a lista vale).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { AccountEntry } from '../accounts/service';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import { parseGrokUsagePost, type GrokUsagePost } from '../sources/grok/billing';
import { parseActiveSessionList, type ActiveSession } from '../sources/grok/files';
import type { GrokLive } from '../sources/grok/live';
import { tr } from '../../shared/i18n';

type Rec = Record<string, unknown>;

export interface GrokHookEvent {
  /** Conta calculada pelo hook (basename do GROK_HOME). */
  account?: string;
  /** Pasta GROK_HOME da sessão, no computador onde o hook roda. */
  grokHome?: string;
  /** O stdin do hook (hook_event_name, session_id...). */
  event: Rec;
}

/** Limites do corpo de POST /api/grok/registry (contas do Grok e sessões abertas por conta). */
export const REGISTRY_MAX_ACCOUNTS = 16;
export const REGISTRY_MAX_SESSIONS = 500;

export interface GrokRegistryPost {
  account?: string;
  grokHome?: string;
  /** Sessões abertas (válidas) daquela pasta do Grok. */
  sessions: ActiveSession[];
  /** A cota lida no log daquela pasta (quando o auxiliar a achou e ela é válida). */
  usage?: GrokUsagePost;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Corpo de POST /api/grok/events. Sem `event` (objeto com hook_event_name): 400. */
export function parseGrokEvent(raw: unknown): GrokHookEvent {
  const r = rec(raw);
  const event = rec(r?.event);
  if (!r || !event || typeof event.hook_event_name !== 'string') throw new HttpError(400, 'esperado {account?, grokHome?, event: <JSON do hook do Grok>}');
  const out: GrokHookEvent = { event };
  const account = shortStr(r.account, 200);
  const grokHome = shortStr(r.grokHome, 4_096);
  if (account) out.account = account;
  if (grokHome) out.grokHome = grokHome;
  return out;
}

/**
 * Corpo de POST /api/grok/registry: `{registries: [{account?, grokHome?, sessions: [...]}]}`. Sem a lista (ou
 * grande demais): 400. Entradas de sessão inválidas ficam de fora (parseActiveSessionList).
 */
export function parseGrokRegistry(raw: unknown): GrokRegistryPost[] {
  const list = rec(raw)?.registries;
  if (!Array.isArray(list) || list.length > REGISTRY_MAX_ACCOUNTS) throw new HttpError(400, 'esperado {registries: [{account?, grokHome?, sessions: [...]}]}');
  const out: GrokRegistryPost[] = [];
  for (const item of list) {
    const r = rec(item);
    if (!r || !Array.isArray(r.sessions) || r.sessions.length > REGISTRY_MAX_SESSIONS) throw new HttpError(400, 'esperado {registries: [{account?, grokHome?, sessions: [...]}]}');
    const entry: GrokRegistryPost = { sessions: parseActiveSessionList(r.sessions) };
    const account = shortStr(r.account, 200);
    const grokHome = shortStr(r.grokHome, 4_096);
    const usage = parseGrokUsagePost(r.usage);
    if (account) entry.account = account;
    if (grokHome) entry.grokHome = grokHome;
    if (usage) entry.usage = usage;
    out.push(entry);
  }
  return out;
}

/**
 * Conta do Grok de um evento do hook: a da pasta GROK_HOME que ele mandou (pelo caminho do host, AccountInfo.configDir,
 * ou pelo lido por este processo); senão a que ele calculou (o basename não sabe dos ids desambiguados, ex. ".grok~2").
 */
export function grokAccountOf(entries: readonly AccountEntry[], account: string | undefined, grokHome: string | undefined): string | undefined {
  if (grokHome && isAbsolute(grokHome)) {
    const abs = resolve(grokHome);
    const e = entries.find((x) => resolve(x.detected.configDir) === abs || resolve(x.dir) === abs);
    if (e) return e.id;
  }
  return account;
}

/** Trata POST /api/grok/events (método e Host já conferidos). `ok` = a fonte do Grok aproveitou o evento. */
export async function handleGrokEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: GrokLive; entries: () => readonly AccountEntry[] },
): Promise<void> {
  const body = parseGrokEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyHookEvent(grokAccountOf(deps.entries(), body.account, body.grokHome), body.event) === true;
    } catch (err) {
      log.warnOnce(`grok-event:${errMsg(err)}`, tr('Eventos do Grok: falha ao aplicar um evento ({0}).', [errMsg(err)]));
    }
  }
  sendJson(res, 200, { ok });
}

/**
 * Trata POST /api/grok/registry (método e Host já conferidos): cada lista vai à conta da pasta GROK_HOME (ou à que o
 * auxiliar nomeou). `applied` = quantas contas aceitaram; `ok` = todas (false sem a fonte do Grok).
 */
export async function handleGrokRegistry(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: GrokLive; entries: () => readonly AccountEntry[] },
): Promise<void> {
  const body = parseGrokRegistry(await readJson(req, 1024 * 1024));
  let applied = 0;
  if (deps.live) {
    for (const r of body) {
      try {
        const account = grokAccountOf(deps.entries(), r.account, r.grokHome);
        if (deps.live.applyRegistry(account, r.sessions)) applied++;
        if (r.usage) deps.live.applyUsage(account, r.usage);
      } catch (err) {
        log.warnOnce(`grok-registry:${errMsg(err)}`, tr('Registro do Grok: falha ao aplicar a lista do auxiliar ({0}).', [errMsg(err)]));
      }
    }
  }
  sendJson(res, 200, { ok: !!deps.live && applied === body.length, applied });
}
