// Terminal do Grok: converte as linhas do updates.jsonl em TerminalEntry (prompts, respostas, raciocínio, chamadas
// de ferramenta com a saída, fim de turno), com segredos mascarados e textos truncados pelas mesmas regras do
// terminal do Claude Code (sources/terminal.ts).
//
// O texto do usuário, da resposta e do raciocínio chega em PEDAÇOS (user_message_chunk, agent_message_chunk,
// agent_thought_chunk): cada sequência é juntada e sai como uma entrada só quando outra coisa acontece (uma
// ferramenta, o fim do turno). Os eventos "_x.ai" de manutenção (hooks, memória) ficam de fora.
import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { formatDuration, maskSecrets } from '../../../shared/activity';
import { marked, oneLine, prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView, INPUT_MAX, type TerminalParser } from '../terminal';
import { describeGrokTool, exitCodeOf, lineTime, resultText } from './updates';
import { tr } from '../../../shared/i18n';

type Rec = Record<string, unknown>;
type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;
type SystemEntry = Extract<TerminalEntry, { kind: 'system' }>;

const SEEN_MAX = 20_000;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Entrada da ferramenta no formato do Claude Code (o `toolView` conhece as chaves dele). */
function claudeInput(name: string, input: Rec): { tool: string; input: Rec } {
  const { tool } = describeGrokTool(name, input);
  const file = str(input.file_path) ?? str(input.target_file) ?? str(input.path);
  switch (tool) {
    case 'Read':
      return { tool, input: { file_path: file, ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) } };
    case 'Edit':
      return { tool, input: { file_path: file, old_string: input.old_string ?? '', new_string: input.new_string ?? '' } };
    case 'Write':
      return { tool, input: { file_path: file, content: input.content ?? input.new_string ?? '' } };
    case 'LS':
      return { tool, input: { path: str(input.target_directory) ?? file } };
    case 'Grep':
      return { tool, input: { pattern: input.pattern, ...(input.path !== undefined ? { path: input.path } : {}), ...(input.glob !== undefined ? { glob: input.glob } : {}) } };
    case 'Glob':
      return { tool, input: { pattern: input.pattern ?? input.glob } };
    case 'Agent':
      return { tool, input: { description: input.description, prompt: input.prompt, subagent_type: input.subagent_type ?? input.agent_type } };
    default:
      if (name === 'use_tool') return { tool, input: rec(input.tool_input) ?? {} };
      return { tool, input };
  }
}

class GrokTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private readonly seen = new Set<string>();
  private cwd?: string;
  private lastAt?: number;
  private seq = 0;
  /** Chamadas sem resultado (toolCallId → nome e entrada), para rotular o resultado. */
  private readonly calls = new Map<string, { name: string; input: Rec }>();
  /** Sequência de pedaços em andamento. */
  private chunk?: { kind: 'user' | 'agent' | 'thought'; id: string; at: number; text: string; images: number };

  push(line: string): TerminalEntry[] {
    this.out = [];
    try {
      this.line(line);
    } catch {
      // Linha estranha demais: fica o que já tiver saído dela; a leitura segue.
    }
    return this.out;
  }

  private emit(e: TerminalEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    this.out.push(e);
  }

  private line(raw: string): void {
    if (raw.length < 2) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const j = rec(parsed);
    const params = rec(j?.params);
    const u = rec(params?.update);
    const method = str(j?.method);
    if (!j || !params || !u || !method) return;
    const ts = lineTime(j, params);
    if (ts !== undefined) this.lastAt = ts;
    const at = ts ?? this.lastAt ?? Date.now();
    const meta = rec(params._meta);
    const key = str(meta?.eventId) ?? str(rec(u._meta)?.eventId) ?? `l${++this.seq}`;
    const kind = str(u.sessionUpdate);
    if (!kind) return;
    if (method === 'session/update') return this.acp(kind, u, at, key);
    if (method === '_x.ai/session/update') return this.xai(kind, u, at, key, str(meta?.promptId));
  }

  // ---------------------------------------------------------------- pedaços de texto

  private feed(kind: 'user' | 'agent' | 'thought', u: Rec, at: number, key: string): void {
    const content = rec(u.content);
    const type = str(content?.type);
    const text = type === 'text' && typeof content?.text === 'string' ? content.text : '';
    const image = type === 'image' || type === 'resource_link' ? 1 : 0;
    if (this.chunk && this.chunk.kind !== kind) this.flush();
    if (!this.chunk) this.chunk = { kind, id: key, at, text: '', images: 0 };
    this.chunk.text += text;
    this.chunk.images += image;
  }

  private flush(): void {
    const c = this.chunk;
    if (!c) return;
    delete this.chunk;
    if (c.kind === 'user') {
      const pics = c.images ? Array.from({ length: Math.min(c.images, 10) }, () => tr('[imagem]')).join(' ') : '';
      const text = marked(prepare([c.text.trim(), pics].filter(Boolean).join('\n'), TEXT_MAX));
      if (text) this.emit({ kind: 'user', id: `${c.id}:u`, at: c.at, text });
      return;
    }
    if (c.kind === 'agent') {
      const text = marked(prepare(c.text, TEXT_MAX));
      if (text) this.emit({ kind: 'assistant', id: `${c.id}:a`, at: c.at, text });
      return;
    }
    const text = c.text.trim() ? marked(prepare(c.text, THINKING_MAX)) : '';
    this.emit(text ? { kind: 'thinking', id: `${c.id}:t`, at: c.at, text } : { kind: 'thinking', id: `${c.id}:t`, at: c.at });
  }

  // ---------------------------------------------------------------- entradas

  private sys(id: string, at: number, text: string, o: { level?: SystemEntry['level']; detail?: string } = {}): void {
    const e: SystemEntry = { kind: 'system', id: `${id}:s`, at, text: maskSecrets(text), level: o.level ?? 'info' };
    if (o.detail?.trim()) {
      const detail = marked(prepare(o.detail, 4_000));
      if (detail) e.detail = detail;
    }
    this.emit(e);
  }

  private tool(id: string, at: number, tool: string, view: { title: string; input?: string; inputKind?: TerminalInputKind }): void {
    const e: ToolEntry = { kind: 'tool', id, at, tool, title: maskSecrets(view.title) };
    if (view.input) {
      e.input = view.input;
      e.inputKind = view.inputKind;
    }
    this.emit(e);
  }

  private result(toolId: string, at: number, raw: string, error: boolean): void {
    const p = prepare(raw, RESULT_MAX, RESULT_MAX_LINES);
    const e: ResultEntry = { kind: 'result', id: `${toolId}:r`, at, toolUseId: toolId, text: p.text || tr('(sem saída)') };
    if (error) e.error = true;
    if (p.truncated) e.truncated = true;
    this.emit(e);
  }

  // ---------------------------------------------------------------- session/update

  private acp(kind: string, u: Rec, at: number, key: string): void {
    switch (kind) {
      case 'user_message_chunk':
        return this.feed('user', u, at, key);
      case 'agent_message_chunk':
        return this.feed('agent', u, at, key);
      case 'agent_thought_chunk':
        return this.feed('thought', u, at, key);
      case 'tool_call': {
        this.flush();
        const id = str(u.toolCallId) ?? key;
        const name = str(rec(rec(u._meta)?.['x.ai/tool'])?.name) ?? str(u.title) ?? 'ferramenta';
        const input = rec(u.rawInput) ?? {};
        this.calls.set(id, { name, input });
        if (this.calls.size > 512) this.calls.delete(this.calls.keys().next().value as string);
        const c = claudeInput(name, input);
        if (c.tool === 'Write' && typeof c.input.content === 'string') {
          // O conteúdo inteiro como entrada (como o Claude Code mostra o Write).
          const text = marked(prepare(c.input.content, INPUT_MAX, Infinity, false));
          const title = toolView('Write', c.input, this.cwd).title;
          return this.tool(id, at, 'Write', text ? { title, input: text, inputKind: 'text' } : { title });
        }
        return this.tool(id, at, c.tool, toolView(c.tool, c.input, this.cwd));
      }
      case 'tool_call_update': {
        const status = str(u.status);
        if (status !== 'completed' && status !== 'failed') return;
        this.flush();
        const id = str(u.toolCallId) ?? key;
        const call = this.calls.get(id);
        this.calls.delete(id);
        const text = resultText(u);
        const exit = exitCodeOf(u, text);
        const failed = status === 'failed' || (exit !== undefined && exit !== 0);
        const shown = exit !== undefined && exit !== 0 ? tr('Código de saída {0}\n{1}', [exit, text.replace(/^exit:\s*-?\d+\s*\n?/, '')]) : text.replace(/^exit:\s*-?\d+\s*\n?/, '');
        // Sem a chamada (janela cortada), ainda assim mostra o resultado solto.
        if (!call) this.tool(id, at, 'ferramenta', { title: oneLine(str(u.title) ?? tr('ferramenta'), 100) });
        return this.result(id, at, shown, failed);
      }
      case 'plan':
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- _x.ai/session/update

  private xai(kind: string, u: Rec, at: number, key: string, promptId: string | undefined): void {
    switch (kind) {
      case 'turn_completed': {
        this.flush();
        const ms = num(u.elapsed_ms);
        const reason = str(u.stop_reason) ?? 'end_turn';
        const turn = str(u.prompt_id) ?? promptId ?? key;
        if (/cancel|interrupt|abort/i.test(reason)) return this.sys(`${turn}:int`, at, tr('Interrompido pelo usuário'), { level: 'warn' });
        if (/error|fail/i.test(reason)) return this.sys(`${turn}:err`, at, tr('Erro: {0}', [oneLine(reason, 160)]), { level: 'error' });
        if (ms !== undefined && ms >= 0) this.sys(`${turn}:done`, at, tr('Turno concluído em {0}', [formatDuration(ms)]));
        return;
      }
      case 'retry_state':
        if (str(u.type) === 'retrying') this.sys(key, at, tr('Instabilidade na API, tentando de novo'), { level: 'warn', detail: str(u.reason) });
        return;
      case 'auto_compact_completed':
        this.flush();
        return this.sys(key, at, tr('Conversa compactada'));
      case 'task_completed': {
        const snap = rec(u.task_snapshot);
        const cmd = str(snap?.command);
        return this.sys(key, at, tr('Comando em segundo plano terminou{0}', [cmd ? `: ${oneLine(cmd, 80)}` : '']));
      }
      default:
        return;
    }
  }
}

/** Parser com estado do terminal do Grok: uma instância por leitura de arquivo, alimentada na ordem do arquivo. */
export function createGrokTerminalParser(): TerminalParser {
  return new GrokTerminalParser();
}
