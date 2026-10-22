// Eventos dos hooks do Grok (mod/habblaud-grok/hook.mjs, que npm run grok:install grava em <GROK_HOME>/hooks/
// habblaud.json): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Notification, Stop,
// StopFailure, StopCancelled, SubagentStart, SubagentStop e SessionEnd chegam aqui com a conta e vão para a fonte do
// Grok (GrokLive), que atualiza o agente na hora, sem esperar a conversa chegar ao arquivo. Os eventos só observam (a
// resposta nunca volta para a sessão), mas só valem vindos do próprio computador: a trava (Host local e, fora do
// Docker, conexão pelo loopback) é conferida em http/app.ts. O guard (http/guard.ts) já exigiu JSON.
//
//   POST /api/grok/events   (hook)   {account?, grokHome?, event: <stdin do hook, textos cortados>}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { AccountEntry } from '../accounts/service';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
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
