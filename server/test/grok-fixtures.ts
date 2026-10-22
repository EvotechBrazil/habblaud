// Fixtures do Grok para os testes: um GROK_HOME temporário (sessions/<cwd codificado>/<id>/ com updates.jsonl e
// summary.json, mais o active_sessions.json), as sessões REAIS anonimizadas de server/test/grok-fixtures/ (a
// estrutura é a de sessões de verdade do Grok Build CLI 1.0.x; todo texto, caminho e saída é sintético) e
// construtores de linhas sintéticas no mesmo formato ACP do updates.jsonl.
import { cpSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeSessionCwd } from '../sources/grok/files';
import { appendLines, tempDir, writeLines } from './fixtures';

/** Pasta das sessões reais anonimizadas (uma subpasta por sessão: curta, media). */
export const GROK_FIXTURES = join(__dirname, 'grok-fixtures');
/** Ids (sintéticos) das sessões das fixtures, como estão nos arquivos. */
export const FIXTURE_IDS = { curta: '0199b0c0-0000-7000-8000-000000000001', media: '0199b0c0-0000-7000-8000-000000000002' } as const;
/** Projeto das fixtures (info.cwd do summary.json). */
export const FIXTURE_CWD = '/projetos/loja';

/** Id de sessão sintético (UUID v7 de mentira). */
export function sessionId(n: number): string {
  return `0199b0c0-0000-7000-8000-${String(n + 100).padStart(12, '0')}`;
}

let seq = 0;

interface LineOpts {
  /** Epoch ms da linha (vai em params._meta.agentTimestampMs e, em segundos, no timestamp). */
  at?: number;
  promptId?: string;
}

function line(session: string, method: 'session/update' | '_x.ai/session/update', update: Record<string, unknown>, o: LineOpts = {}): string {
  const at = o.at ?? Date.now();
  const meta: Record<string, unknown> = { eventId: `${session}-${++seq}`, agentTimestampMs: at };
  if (o.promptId) meta.promptId = o.promptId;
  return JSON.stringify({ timestamp: Math.floor(at / 1000), method, params: { sessionId: session, update, _meta: meta } });
}

function tool(name: string, kind: string): Record<string, unknown> {
  return { 'x.ai/tool': { version: 1, name, kind, namespace: 'grok_build', label: name, read_only: kind === 'read' } };
}

/** Linhas sintéticas do updates.jsonl. `s` = id da sessão. */
export const G = {
  user(s: string, text: string, o: LineOpts = {}): string {
    return line(s, 'session/update', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }, o);
  },
  userImage(s: string, o: LineOpts = {}): string {
    return line(s, 'session/update', { sessionUpdate: 'user_message_chunk', content: { type: 'resource_link', mimeType: 'image/jpeg', name: 'quadro.jpg', uri: 'file:///projetos/loja/quadro.jpg' } }, o);
  },
  thought(s: string, text: string, o: LineOpts = {}): string {
    return line(s, 'session/update', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }, o);
  },
  agent(s: string, text: string, o: LineOpts = {}): string {
    return line(s, 'session/update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }, o);
  },
  toolCall(s: string, callId: string, name: string, rawInput: Record<string, unknown>, o: LineOpts & { kind?: string } = {}): string {
    return line(s, 'session/update', { sessionUpdate: 'tool_call', toolCallId: callId, title: name, rawInput, _meta: tool(name, o.kind ?? 'execute') }, o);
  },
  /** Resultado: `text` como bloco de conteúdo; `exitCode` e `command` no rawOutput (como o run_terminal_command grava). */
  toolDone(s: string, callId: string, o: LineOpts & { text?: string; status?: 'completed' | 'failed'; exitCode?: number; command?: string } = {}): string {
    const update: Record<string, unknown> = { sessionUpdate: 'tool_call_update', toolCallId: callId, status: o.status ?? 'completed', content: [{ type: 'content', content: { type: 'text', text: o.text ?? 'ok\n' } }] };
    if (o.exitCode !== undefined || o.command) {
      update.rawOutput = { type: 'Bash', output: [], output_for_prompt: `exit: ${o.exitCode ?? 0}\n${o.text ?? 'ok\n'}`, exit_code: o.exitCode ?? 0, command: o.command ?? 'npm test', truncated: false };
    }
    return line(s, 'session/update', update, o);
  },
  /** tool_call_update sem status (só título e locais): não conclui nada. */
  toolInfo(s: string, callId: string, title: string, o: LineOpts = {}): string {
    return line(s, 'session/update', { sessionUpdate: 'tool_call_update', toolCallId: callId, kind: 'read', title, locations: [{ path: '/projetos/loja/src/arquivo.ts' }] }, o);
  },
  plan(s: string, entries: Array<{ content: string; status: string }>, o: LineOpts = {}): string {
    return line(s, 'session/update', { sessionUpdate: 'plan', entries: entries.map((e) => ({ ...e, priority: 'medium' })) }, o);
  },
  turnCompleted(s: string, o: LineOpts & { input?: number; output?: number; cached?: number; elapsedMs?: number; stopReason?: string; model?: string } = {}): string {
    const input = o.input ?? 1_000;
    const output = o.output ?? 100;
    const usage = { inputTokens: input, outputTokens: output, totalTokens: input + output, cachedReadTokens: o.cached ?? 0, cacheCreationTokens: 0, reasoningTokens: 10, modelCalls: 1, apiDurationMs: 500, costUsdTicks: 1, numTurns: 1 };
    return line(
      s,
      '_x.ai/session/update',
      { sessionUpdate: 'turn_completed', prompt_id: o.promptId ?? 'p1', stop_reason: o.stopReason ?? 'end_turn', usage: { ...usage, modelUsage: { [o.model ?? 'grok-teste']: usage } }, elapsed_ms: o.elapsedMs ?? 4_000 },
      o,
    );
  },
  hook(s: string, eventName: string, o: LineOpts = {}): string {
    return line(s, '_x.ai/session/update', { sessionUpdate: 'hook_execution', event_name: eventName, runs: [{ name: 'global/habblaud', status: { status: 'success', elapsed_ms: 5 } }] }, o);
  },
  retry(s: string, o: LineOpts = {}): string {
    return line(s, '_x.ai/session/update', { sessionUpdate: 'retry_state', type: 'retrying', attempt: 1, max_retries: 3, reason: 'API error (status 500)', error_type: 'api' }, o);
  },
  compacted(s: string, o: LineOpts = {}): string {
    return line(s, '_x.ai/session/update', { sessionUpdate: 'auto_compact_completed' }, o);
  },
  taskCompleted(s: string, taskId: string, command: string, o: LineOpts = {}): string {
    return line(s, '_x.ai/session/update', { sessionUpdate: 'task_completed', task_snapshot: { task_id: taskId, command, status: 'completed' } }, o);
  },
};

export interface SummaryOpts {
  cwd?: string;
  title?: string;
  model?: string;
  branch?: string;
  createdAt?: number;
  lastActiveAt?: number;
  kind?: string;
}

/** summary.json como o Grok grava. */
export function summaryJson(s: string, o: SummaryOpts = {}): string {
  const iso = (ms: number) => new Date(ms).toISOString();
  const created = o.createdAt ?? Date.now() - 60_000;
  const last = o.lastActiveAt ?? Date.now();
  return JSON.stringify(
    {
      info: { id: s, cwd: o.cwd ?? FIXTURE_CWD },
      session_summary: '',
      created_at: iso(created),
      updated_at: iso(last),
      num_messages: 4,
      current_model_id: o.model ?? 'grok-teste',
      session_kind: o.kind ?? 'interactive',
      git_root_dir: `${o.cwd ?? FIXTURE_CWD}/`,
      head_branch: o.branch ?? 'main',
      grok_home: '/home/fulano/.grok',
      last_active_at: iso(last),
      agent_name: 'grok-build',
      ...(o.title ? { generated_title: o.title } : {}),
    },
    null,
    2,
  );
}

export interface ActiveOpts {
  pid?: number;
  cwd?: string;
  openedAt?: number;
}

/** GROK_HOME temporário. */
export function grokHome(name = '.grok') {
  const tmp = tempDir('habblaud-grok-');
  const dir = join(tmp.dir, name);
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const ctx = {
    home: tmp.dir,
    dir,
    cleanup: tmp.cleanup,
    /** Pasta de uma sessão (criada se faltar). */
    sessionDir(s: string, cwd = FIXTURE_CWD): string {
      const d = join(dir, 'sessions', encodeSessionCwd(cwd), s);
      mkdirSync(d, { recursive: true });
      return d;
    },
    /** Grava o updates.jsonl de uma sessão (e o summary.json, se pedido). Devolve o caminho do updates.jsonl. */
    session(s: string, lines: string[], o: { cwd?: string; summary?: SummaryOpts | false; mtime?: number } = {}): string {
      const d = ctx.sessionDir(s, o.cwd);
      const path = join(d, 'updates.jsonl');
      writeLines(path, lines);
      if (o.summary !== false) writeFileSync(join(d, 'summary.json'), summaryJson(s, { cwd: o.cwd, ...(o.summary ?? {}) }));
      if (o.mtime !== undefined) utimesSync(path, o.mtime / 1000, o.mtime / 1000);
      return path;
    },
    /** Copia uma das sessões reais anonimizadas (server/test/grok-fixtures/<name>) para a pasta da sessão dela. */
    fixture(name: keyof typeof FIXTURE_IDS, o: { cwd?: string; mtime?: number } = {}): { id: string; path: string } {
      const id = FIXTURE_IDS[name];
      const d = ctx.sessionDir(id, o.cwd);
      cpSync(join(GROK_FIXTURES, name), d, { recursive: true });
      const path = join(d, 'updates.jsonl');
      if (o.mtime !== undefined) utimesSync(path, o.mtime / 1000, o.mtime / 1000);
      return { id, path };
    },
    append(path: string, lines: string[]): void {
      appendLines(path, lines);
    },
    /** Regrava active_sessions.json com as sessões abertas (como o Grok faz: arquivo inteiro, por troca). */
    active(entries: Array<{ id: string } & ActiveOpts>): void {
      const list = entries.map((e) => ({ session_id: e.id, pid: e.pid ?? process.pid, pid_start: 1, cwd: e.cwd ?? FIXTURE_CWD, opened_at: new Date(e.openedAt ?? Date.now()).toISOString() }));
      const tmpFile = join(dir, 'active_sessions.json.tmp');
      writeFileSync(tmpFile, JSON.stringify(list, null, 2));
      rmSync(join(dir, 'active_sessions.json'), { force: true });
      cpSync(tmpFile, join(dir, 'active_sessions.json'));
      rmSync(tmpFile);
    },
    noActive(): void {
      rmSync(join(dir, 'active_sessions.json'), { force: true });
    },
    touch(path: string, at: number): void {
      utimesSync(path, at / 1000, at / 1000);
    },
  };
  return ctx;
}
