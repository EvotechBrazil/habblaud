// Interpretação do updates.jsonl de uma sessão do Grok (<GROK_HOME>/sessions/<cwd>/<id>/updates.jsonl): o fluxo ACP
// da sessão, uma linha JSON por evento. Cada linha atualiza um GrokState (modelo, título, números, turno aberto,
// tarefas...) e pode gerar atividades (o que o personagem está fazendo) e sinais (turno começou/terminou, evento do
// GitHub).
//
// Formato: {timestamp (s), method, params: {sessionId, update: {sessionUpdate, ...}, _meta: {agentTimestampMs,
// eventId, promptId...}}}. `method` "session/update" traz o ACP padrão: user_message_chunk, agent_thought_chunk,
// agent_message_chunk (as três em pedaços), tool_call (toolCallId, title = nome da ferramenta, rawInput, o
// `_meta["x.ai/tool"]` com nome, tipo e namespace), tool_call_update (status completed/failed, content, rawOutput) e
// plan (as tarefas). `method` "_x.ai/session/update" traz o resto: turn_completed (usage por turno e stop_reason),
// hook_execution, task_backgrounded/task_completed (comandos em segundo plano), auto_compact_*, retry_state...
// Tokens: o `usage` do turn_completed é POR TURNO e o `inputTokens` já inclui o cache lido (totalTokens = input +
// output), então os turnos são somados sem contar o cache de novo. Custo: `costUsdTicks` está em unidade não
// documentada e fica de fora. Tipos de linha desconhecidos são ignorados; uma linha inválida nunca derruba a leitura.
import { describePrompt, describeTool, maskSecrets, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { GitHubEvent } from '../../../shared/github';
import type { Activity, AgentStats, TaskItem, TaskStatus } from '../../../shared/types';
import { detectGitHubResult, githubCallOf } from '../github';
import type { ParsedActivity } from '../transcript';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// ------------------------------------------------------------------ ferramentas

/** Nome MCP no formato do Claude Code: `mcp__<servidor>__<ferramenta>` (o Grok grava `<servidor>__<ferramenta>`). */
export function mcpName(qualified: string): string {
  return qualified.startsWith('mcp__') ? qualified : `mcp__${qualified}`;
}

/**
 * Atividade de uma ferramenta do Grok pelo nome que ela tem no updates.jsonl ou no hook (read_file, search_replace,
 * run_terminal_command, grep, list_dir, write, todo_write, monitor, web_fetch, spawn_subagent, use_tool, os
 * `<servidor>__<ferramenta>` do MCP...). `tool` volta normalizado para o Activity.tool (Bash, Read, Edit, Write...).
 */
export function describeGrokTool(rawName: string, input: Rec): { desc: ActivityDescription; tool: string } {
  const name = rawName.trim();
  const file = str(input.file_path) ?? str(input.target_file) ?? str(input.path);
  switch (name) {
    case 'read_file':
    case 'Read':
      return { desc: describeTool('Read', { file_path: file }), tool: 'Read' };
    case 'search_replace':
    case 'hashline_edit':
    case 'Edit':
    case 'StrReplace': {
      // search_replace com old_string vazio (ou sem ele) cria o arquivo.
      const creates = typeof input.old_string === 'string' ? !input.old_string : input.old_string === undefined && typeof input.new_string === 'string' && name === 'search_replace';
      const tool = creates ? 'Write' : 'Edit';
      return { desc: describeTool(tool, { file_path: file }), tool };
    }
    case 'write':
    case 'Write':
      return { desc: describeTool('Write', { file_path: file }), tool: 'Write' };
    case 'run_terminal_command':
    case 'Bash':
    case 'Shell':
      return { desc: describeTool('Bash', { command: input.command, description: input.description }), tool: 'Bash' };
    case 'grep':
    case 'Grep':
      return { desc: describeTool('Grep', { pattern: input.pattern, path: str(input.path) }), tool: 'Grep' };
    case 'glob':
    case 'Glob':
      return { desc: describeTool('Glob', { pattern: input.pattern ?? input.glob }), tool: 'Glob' };
    case 'list_dir':
    case 'LS':
    case 'List':
      return { desc: describeTool('LS', { path: str(input.target_directory) ?? file }), tool: 'LS' };
    case 'todo_write':
    case 'TodoWrite':
      return { desc: describeTool('TodoWrite', { todos: input.todos }), tool: 'TodoWrite' };
    case 'monitor':
    case 'Monitor':
      return { desc: describeTool('Monitor', { command: input.command, description: input.description }), tool: 'Monitor' };
    case 'get_command_or_subagent_output':
    case 'TaskOutput':
    case 'AwaitShell':
      return { desc: describeTool('TaskOutput', {}), tool: 'TaskOutput' };
    case 'kill_command_or_subagent':
    case 'TaskStop':
      return { desc: describeTool('TaskStop', {}), tool: 'TaskStop' };
    case 'web_fetch':
    case 'WebFetch':
    case 'Fetch':
      return { desc: describeTool('WebFetch', { url: input.url }), tool: 'WebFetch' };
    case 'web_search':
    case 'WebSearch':
    case 'Web search:':
      return { desc: describeTool('WebSearch', { query: input.query }), tool: 'WebSearch' };
    case 'spawn_subagent':
    case 'Task':
    case 'Agent':
      return { desc: describeTool('Agent', { description: input.description, prompt: input.prompt, subagent_type: input.subagent_type ?? input.agent_type }), tool: 'Agent' };
    case 'search_tool':
      return { desc: { kind: 'other', icon: '🧰', text: tr('Procurando uma ferramenta') }, tool: name };
    case 'use_tool': {
      // Despachante do MCP: a ferramenta de verdade vem em tool_name (`servidor__ferramenta`).
      const inner = str(input.tool_name);
      if (inner) return describeGrokTool(inner, rec(input.tool_input) ?? {});
      return { desc: { kind: 'mcp', icon: '🔌', text: tr('Usando uma ferramenta externa') }, tool: name };
    }
    default: {
      if (/^(?:mcp__)?[\w.-]+__[\w.-]+$/.test(name)) {
        const mcp = mcpName(name);
        return { desc: describeTool(mcp, input), tool: mcp };
      }
      return { desc: describeTool(name, input), tool: name };
    }
  }
}

/** Atividade de uma instrução recebida pelo Grok: "Recebeu “…”" (kind 'prompt', a base do "Concluiu em X"). */
export function describeGrokPrompt(text: string): ActivityDescription {
  const shown = truncate(maskSecrets(text.slice(0, 1_000)), 34);
  return { ...describePrompt(text), text: truncate(tr('Recebeu “{0}”', [shown]), 46) };
}

const TASK_STATUS = new Set<string>(['pending', 'in_progress', 'completed']);

/** Tarefas de um `plan` ({entries: [{content, status, priority}]}) ou de um `todo_write` ({todos: [{id, content, status}]}). */
export function planTasks(raw: unknown): TaskItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: TaskItem[] = [];
  raw.forEach((item, i) => {
    const p = rec(item);
    const title = str(p?.content) ?? str(p?.title);
    if (!p || !title) return;
    const status = typeof p.status === 'string' && TASK_STATUS.has(p.status) ? (p.status as TaskStatus) : 'pending';
    out.push({ id: str(p.id) ?? String(i + 1), title: truncate(maskSecrets(title.slice(0, 480)), 120), status });
  });
  return out;
}

/** Texto de um resultado de tool_call_update: os blocos `content` ({type: 'content', content: {type: 'text', text}}) ou o rawOutput. */
export function resultText(update: Rec): string {
  const parts: string[] = [];
  if (Array.isArray(update.content)) {
    for (const raw of update.content) {
      const c = rec(raw);
      if (!c) continue;
      if (c.type === 'content') {
        const inner = rec(c.content);
        if (typeof inner?.text === 'string') parts.push(inner.text);
      } else if (c.type === 'diff') {
        // Já mostrado na chamada (o diff vai como entrada da ferramenta no terminal).
      }
    }
  }
  if (!parts.length) {
    const ro = rec(update.rawOutput);
    const t = str(ro?.output_for_prompt) ?? str(ro?.output);
    if (t) parts.push(t);
  }
  return parts.join('\n');
}

/** Código de saída de um comando (rawOutput.exit_code ou "exit: N" no texto). */
export function exitCodeOf(update: Rec, text: string): number | undefined {
  const ro = rec(update.rawOutput);
  const code = num(ro?.exit_code);
  if (code !== undefined) return code;
  const m = /^exit:\s*(-?\d+)/m.exec(text.slice(0, 200));
  return m ? Number(m[1]) : undefined;
}

function firstLine(s: string, max = 140): string | undefined {
  const line = s
    .replace(/^exit:\s*-?\d+\s*\n?/, '')
    .split('\n')
    .find((l) => l.trim());
  return line ? truncate(line, max) : undefined;
}

// ------------------------------------------------------------------ estado

export interface GrokState {
  model?: string;
  /** Primeira instrução (título da sessão), já mascarada e cortada. */
  title?: string;
  tasks: TaskItem[];
  stats: AgentStats;
  /** Turno aberto (instrução sem turn_completed); undefined = nenhum evento de turno visto. */
  turnOpen?: boolean;
  /** Turnos concluídos vistos. */
  turns: number;
  firstAt?: number;
  lastAt?: number;
  /** Chamadas de ferramenta ainda sem resultado (toolCallId → nome e entrada). */
  pending: Map<string, { name: string; input: Rec }>;
  current?: { id: string; kind: Activity['kind']; at: number };
  /** Último pedaço visto (user, agent ou thought) e a chave da atividade dele: os pedaços seguintes não repetem. */
  chunk?: { kind: 'user' | 'agent' | 'thought'; key: string; at: number };
}

export function createGrokState(): GrokState {
  return { tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, turns: 0, pending: new Map() };
}

/** Sinais de uma linha para quem acompanha a sessão. */
export type GrokSignal =
  | { type: 'turnStart' }
  | { type: 'turnEnd'; aborted: boolean }
  /** Algo concluiu dentro do turno (tira a espera por aprovação). */
  | { type: 'progress' }
  | { type: 'github'; event: GitHubEvent; key: string };

export interface GrokLineResult {
  activities: ParsedActivity[];
  signals: GrokSignal[];
  /** Título, números, modelo ou tarefas mudaram. */
  changed: boolean;
  /** Epoch ms da linha (o `agentTimestampMs`, o `timestamp` em segundos ou o `now` do contexto). */
  at: number;
}

export interface GrokParseContext {
  /** Prefixo dos ids de atividade (o id do agente). */
  idPrefix: string;
  now: number;
  /** false = só atualiza o estado (sem montar atividades). */
  activities?: boolean;
}

const TITLE_MAX = 90;
const MAX_PENDING = 128;
/** Motivos de parada que não são uma conclusão normal. */
const ABORTED = /cancel|interrupt|abort/i;
const FAILED = /error|fail/i;

class UpdateLineParser {
  readonly out: GrokLineResult;
  private readonly withActivities: boolean;
  private readonly eventId?: string;
  private readonly promptId?: string;

  constructor(
    private readonly s: GrokState,
    private readonly ctx: GrokParseContext,
    private readonly method: string,
    private readonly u: Rec,
    meta: Rec | undefined,
    private readonly at: number,
  ) {
    this.withActivities = ctx.activities !== false;
    this.out = { activities: [], signals: [], changed: false, at };
    this.eventId = str(meta?.eventId) ?? str(rec(u._meta)?.eventId);
    this.promptId = str(meta?.promptId) ?? str(rec(u._meta)?.promptId) ?? str(u.prompt_id);
  }

  /** Chave estável de uma atividade sem id próprio: o eventId da linha (ou o horário). Uma releitura gera as mesmas chaves. */
  private key(): string {
    return this.eventId ?? `t${this.at.toString(36)}`;
  }

  private push(desc: ActivityDescription, opts: { key?: string; tool?: string; current?: boolean; durationMs?: number; callId?: string } = {}): void {
    if (!this.withActivities) return;
    const key = opts.key ?? this.key();
    const activity: Activity = { id: `${this.ctx.idPrefix}#${key}`, at: this.at, ...desc };
    if (opts.tool) activity.tool = opts.tool;
    if (opts.durationMs !== undefined) activity.durationMs = opts.durationMs;
    if (desc.kind === 'error') activity.error = true;
    const current = opts.current ?? true;
    this.out.activities.push(opts.callId ? { activity, current, toolUseId: opts.callId } : { activity, current });
    if (current) this.s.current = { id: activity.id, kind: desc.kind, at: this.at };
  }

  private changed(): void {
    this.out.changed = true;
  }

  private progress(): void {
    this.out.signals.push({ type: 'progress' });
  }

  /** Um pedaço de texto de tipo `kind`: true se é o PRIMEIRO de uma sequência (os seguintes só continuam). */
  private firstChunk(kind: 'user' | 'agent' | 'thought'): boolean {
    const c = this.s.chunk;
    if (c?.kind === kind && this.at - c.at < 10 * 60_000) {
      c.at = this.at;
      return false;
    }
    this.s.chunk = { kind, key: this.key(), at: this.at };
    return true;
  }

  private endChunks(): void {
    delete this.s.chunk;
  }

  run(): void {
    const kind = str(this.u.sessionUpdate);
    if (!kind) return;
    if (this.method === 'session/update') return this.acp(kind);
    if (this.method === '_x.ai/session/update') return this.xai(kind);
  }

  // ---------------------------------------------------------------- session/update (ACP)

  private acp(kind: string): void {
    switch (kind) {
      case 'user_message_chunk':
        return this.userChunk();
      case 'agent_thought_chunk':
        if (this.firstChunk('thought')) this.think();
        this.progress();
        return;
      case 'agent_message_chunk': {
        const text = str(rec(this.u.content)?.text);
        if (this.firstChunk('agent')) this.push(SPECIAL.respond(text ? truncate(maskSecrets(text.slice(0, 2_000)), 300) : undefined));
        this.progress();
        return;
      }
      case 'tool_call':
        this.endChunks();
        return this.toolCall();
      case 'tool_call_update':
        this.endChunks();
        return this.toolUpdate();
      case 'plan': {
        this.endChunks();
        const tasks = planTasks(this.u.entries);
        if (tasks) {
          this.s.tasks = tasks;
          this.changed();
        }
        return;
      }
      default:
        return;
    }
  }

  private userChunk(): void {
    const content = rec(this.u.content);
    const type = str(content?.type);
    const text = type === 'text' ? (content?.text as string | undefined) : undefined;
    const first = this.firstChunk('user');
    // Uma instrução nova abre o turno (o turn_completed fecha); o hook user_prompt_submit pode já ter aberto.
    if (first && this.s.turnOpen !== true) {
      this.s.turnOpen = true;
      this.out.signals.push({ type: 'turnStart' });
    }
    if (!first) return;
    const clean = (text ?? '').trim();
    const shown = clean || (type === 'image' || type === 'resource_link' ? tr('[imagem]') : '');
    if (!shown) return;
    if (this.s.title === undefined) {
      this.s.title = truncate(maskSecrets(clean.slice(0, 1_000) || shown), TITLE_MAX);
      this.changed();
    }
    this.push(describeGrokPrompt(shown));
  }

  private think(): void {
    const cur = this.s.current;
    // Um único "Pensando…" seguido (o raciocínio vem em vários pedaços).
    if (cur?.kind === 'think' && this.at - cur.at < 30_000) return;
    this.push(SPECIAL.think());
  }

  private toolCall(): void {
    const callId = str(this.u.toolCallId);
    const meta = rec(rec(this.u._meta)?.['x.ai/tool']);
    const name = str(meta?.name) ?? str(this.u.title) ?? 'ferramenta';
    const input = rec(this.u.rawInput) ?? {};
    if (callId) {
      this.s.pending.set(callId, { name, input });
      if (this.s.pending.size > MAX_PENDING) this.s.pending.delete(this.s.pending.keys().next().value as string);
    }
    this.s.stats.toolCalls++;
    if (name === 'spawn_subagent') this.s.stats.subagents++;
    this.changed();
    if (name === 'todo_write') {
      const tasks = planTasks(input.todos);
      if (tasks) this.s.tasks = tasks;
    }
    const { desc, tool } = describeGrokTool(name, input);
    this.push(desc, { key: callId, tool, callId });
  }

  private toolUpdate(): void {
    const status = str(this.u.status);
    const callId = str(this.u.toolCallId);
    // Sem status: só enriquece a chamada (título, locais); o que importa é a conclusão.
    if (!status || (status !== 'completed' && status !== 'failed')) return;
    const call = callId ? this.s.pending.get(callId) : undefined;
    if (callId) this.s.pending.delete(callId);
    this.progress();
    const text = resultText(this.u);
    const key = callId ?? this.key();
    const { tool } = call ? describeGrokTool(call.name, call.input) : { tool: 'ferramenta' };
    const exit = exitCodeOf(this.u, text);
    const failed = status === 'failed' || (exit !== undefined && exit !== 0);
    if (failed) {
      const detail = firstLine(text) ?? (exit !== undefined ? tr('Código de saída {0}', [exit]) : undefined);
      this.push(SPECIAL.error(tool, detail), { key: `${key}:e`, tool, current: this.s.current?.id === `${this.ctx.idPrefix}#${key}` });
    }
    // GitHub: a mesma detecção do Claude Code, com o comando, a saída e o código de saída.
    const command = str(rec(this.u.rawOutput)?.command) ?? str(call?.input.command);
    const gh = tool === 'Bash' && command ? githubCallOf('Bash', { command }) : undefined;
    if (gh) {
      const content = failed ? `Exit code ${exit ?? 1}\n${text}` : text;
      const event = detectGitHubResult(gh, { content, tur: {}, isError: failed });
      if (event) this.out.signals.push({ type: 'github', event, key });
    }
  }

  // ---------------------------------------------------------------- _x.ai/session/update

  private xai(kind: string): void {
    switch (kind) {
      case 'turn_completed':
        this.endChunks();
        return this.turnCompleted();
      case 'hook_execution': {
        // Os hooks do Grok rodam em pontos fixos: user_prompt_submit abre o turno, stop* fecha.
        const event = str(this.u.event_name)?.toLowerCase();
        if (event === 'user_prompt_submit' && !this.s.turnOpen) {
          this.s.turnOpen = true;
          this.out.signals.push({ type: 'turnStart' });
        } else if (event === 'stop' || event === 'stop_failure' || event === 'stop_cancelled') {
          if (this.s.turnOpen !== false) {
            this.s.turnOpen = false;
            this.s.pending.clear();
            this.out.signals.push({ type: 'turnEnd', aborted: event !== 'stop' });
          }
        }
        return;
      }
      case 'task_completed': {
        this.endChunks();
        const snap = rec(this.u.task_snapshot);
        const id = str(snap?.task_id) ?? str(this.u.task_id);
        this.push(SPECIAL.backgroundResult(str(snap?.command) ? truncate(maskSecrets(snap!.command as string), 80) : undefined), { key: id ? `${id}:bg` : undefined, current: false });
        this.progress();
        return;
      }
      case 'auto_compact_completed':
        this.endChunks();
        this.push(SPECIAL.compact());
        return;
      case 'retry_state':
        if (str(this.u.type) === 'retrying') this.push(SPECIAL.apiRetry());
        return;
      default:
        return;
    }
  }

  private turnCompleted(): void {
    const usage = rec(this.u.usage);
    if (usage) {
      const tin = num(usage.inputTokens) ?? 0;
      const tout = num(usage.outputTokens) ?? 0;
      if (tin || tout) {
        this.s.stats.tokensIn += tin;
        this.s.stats.tokensOut += tout;
        this.changed();
      }
      for (const m of Object.keys(rec(usage.modelUsage) ?? {})) {
        if (m !== this.s.model) {
          this.s.model = m;
          this.changed();
        }
        break;
      }
    }
    this.s.turns++;
    const reason = str(this.u.stop_reason) ?? 'end_turn';
    const aborted = ABORTED.test(reason);
    // O hook stop pode já ter fechado o turno: o sinal sai uma vez só.
    if (this.s.turnOpen !== false) this.out.signals.push({ type: 'turnEnd', aborted });
    this.s.turnOpen = false;
    this.s.pending.clear();
    const turn = this.promptId ?? this.key();
    const ms = num(this.u.elapsed_ms);
    if (aborted) this.push(SPECIAL.interrupted(), { key: `${turn}:int` });
    else if (FAILED.test(reason)) this.push(SPECIAL.error(undefined, truncate(reason, 80)), { key: `${turn}:err` });
    else this.push(SPECIAL.turnDone(ms), { key: `${turn}:done`, durationMs: ms });
  }
}

/** Epoch ms de uma linha: `params._meta.agentTimestampMs`, senão `timestamp` (segundos). */
export function lineTime(line: Rec, params: Rec | undefined): number | undefined {
  const ms = num(rec(params?._meta)?.agentTimestampMs);
  if (ms !== undefined) return ms;
  const s = num(line.timestamp);
  if (s === undefined) return undefined;
  return s > 1e12 ? s : s * 1000;
}

/** Interpreta uma linha do updates.jsonl. Linhas inválidas ou desconhecidas não geram nada. */
export function parseUpdateLine(state: GrokState, raw: string, ctx: GrokParseContext): GrokLineResult {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { activities: [], signals: [], changed: false, at: ctx.now };
  }
  const r = rec(j);
  const params = rec(r?.params);
  const update = rec(params?.update);
  const method = str(r?.method);
  if (!r || !params || !update || !method) return { activities: [], signals: [], changed: false, at: ctx.now };
  const at = lineTime(r, params);
  if (at !== undefined) {
    if (state.firstAt === undefined || at < state.firstAt) state.firstAt = at;
    if (state.lastAt === undefined || at > state.lastAt) state.lastAt = at;
  }
  const p = new UpdateLineParser(state, ctx, method, update, rec(params._meta), at ?? ctx.now);
  try {
    p.run();
  } catch {
    // linha estranha demais: fica o que já tiver saído dela
  }
  return p.out;
}
