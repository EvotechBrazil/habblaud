// Interpretação do updates.jsonl do Grok: as sessões reais anonimizadas (server/test/grok-fixtures/) e linhas
// sintéticas no mesmo formato.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_IDS, G, GROK_FIXTURES, sessionId } from '../../test/grok-fixtures';
import { createGrokState, describeGrokTool, parseUpdateLine, planTasks, resultText, type GrokLineResult, type GrokState } from './updates';

const S = sessionId(1);
const ctx = { idPrefix: 'acc:s', now: 0 };

function feed(lines: string[], state: GrokState = createGrokState()): { state: GrokState; results: GrokLineResult[] } {
  const results = lines.map((l) => parseUpdateLine(state, l, ctx));
  return { state, results };
}

function fixtureLines(name: keyof typeof FIXTURE_IDS): string[] {
  return readFileSync(join(GROK_FIXTURES, name, 'updates.jsonl'), 'utf8').split('\n').filter(Boolean);
}

const texts = (results: GrokLineResult[]) => results.flatMap((r) => r.activities.map((a) => a.activity.text));
const kinds = (results: GrokLineResult[]) => results.flatMap((r) => r.activities.map((a) => a.activity.kind));
const signals = (results: GrokLineResult[]) => results.flatMap((r) => r.signals.map((s) => s.type));

describe('updates.jsonl do Grok: sessões reais (anonimizadas)', () => {
  it('sessão curta: instrução, raciocínio, leituras, resposta e o fim do turno com os tokens', () => {
    const { state, results } = feed(fixtureLines('curta'));
    expect(state.title).toBe('Rode os testes da loja e me diga o que falhou.');
    expect(state.stats).toMatchObject({ toolCalls: 2, tokensIn: 53_718, tokensOut: 499, subagents: 0 });
    expect(state.model).toBe('grok-4.6-build');
    expect(state.turnOpen).toBe(false);
    expect(state.turns).toBe(1);
    expect(state.firstAt).toBe(1789235755062);
    expect(state.lastAt).toBeGreaterThan(state.firstAt!);
    const k = kinds(results);
    expect(k[0]).toBe('prompt');
    expect(k).toContain('think');
    expect(k.filter((x) => x === 'read')).toHaveLength(2);
    expect(k).toContain('respond');
    expect(k[k.length - 1]).toBe('done');
    expect(texts(results)).toContain('Olhando quadro.jpg');
    // O turno abre na instrução (também pelo hook user_prompt_submit, sem duplicar) e fecha no turn_completed.
    const sig = signals(results);
    expect(sig.filter((s) => s === 'turnStart')).toHaveLength(1);
    expect(sig.filter((s) => s === 'turnEnd')).toHaveLength(1);
    const done = results.flatMap((r) => r.activities).find((a) => a.activity.kind === 'done');
    expect(done?.activity).toMatchObject({ kind: 'done', durationMs: 11_840, id: `acc:s#d4c5ec72-d5b6-4b59-b744-aa05689a9aef:done` });
  });

  it('sessão média: comandos, busca, listagem e um turno longo', () => {
    const { state, results } = feed(fixtureLines('media'));
    expect(state.stats.toolCalls).toBe(6);
    expect(state.turns).toBe(1);
    expect(state.stats.tokensIn).toBeGreaterThan(100_000);
    expect(state.stats.tokensOut).toBeGreaterThan(1_000);
    const tools = results.flatMap((r) => r.activities.map((a) => a.activity.tool)).filter(Boolean);
    expect(tools).toEqual(expect.arrayContaining(['Bash', 'Grep', 'LS', 'Read']));
    // Os pedaços de raciocínio viram uma atividade por sequência (entre ferramentas), não uma por pedaço.
    const thoughtLines = fixtureLines('media').filter((l) => l.includes('agent_thought_chunk')).length;
    const think = kinds(results).filter((x) => x === 'think').length;
    expect(think).toBeGreaterThan(0);
    expect(think).toBeLessThanOrEqual(thoughtLines);
    // Cada chamada vista tem o id dela (o hook PreToolUse usa o mesmo id: não duplica).
    const callIds = results.flatMap((r) => r.activities.map((a) => a.toolUseId)).filter(Boolean);
    expect(callIds.every((id) => /^call-/.test(id!))).toBe(true);
  });

  it('uma releitura gera os mesmos ids de atividade', () => {
    const a = feed(fixtureLines('curta')).results.flatMap((r) => r.activities.map((x) => x.activity.id));
    const b = feed(fixtureLines('curta')).results.flatMap((r) => r.activities.map((x) => x.activity.id));
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

describe('updates.jsonl do Grok: linhas sintéticas', () => {
  it('ferramentas: nomes do Grok viram as do Claude Code, com o arquivo ou o comando', () => {
    expect(describeGrokTool('read_file', { target_file: '/p/loja/src/a.ts' })).toMatchObject({ tool: 'Read', desc: { kind: 'read', text: 'Lendo a.ts' } });
    expect(describeGrokTool('search_replace', { file_path: '/p/loja/README.md', old_string: 'a', new_string: 'b' })).toMatchObject({ tool: 'Edit', desc: { kind: 'edit' } });
    expect(describeGrokTool('search_replace', { file_path: '/p/loja/novo.md', old_string: '', new_string: 'b' })).toMatchObject({ tool: 'Write', desc: { kind: 'write' } });
    expect(describeGrokTool('write', { file_path: '/p/loja/novo.md', content: 'x' })).toMatchObject({ tool: 'Write' });
    expect(describeGrokTool('run_terminal_command', { command: 'npm test' })).toMatchObject({ tool: 'Bash', desc: { kind: 'test' } });
    expect(describeGrokTool('grep', { pattern: 'TODO', path: '/p' })).toMatchObject({ tool: 'Grep', desc: { kind: 'search' } });
    expect(describeGrokTool('list_dir', { target_directory: '/p/loja/src' })).toMatchObject({ tool: 'LS', desc: { text: 'Listando src' } });
    expect(describeGrokTool('todo_write', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] })).toMatchObject({ tool: 'TodoWrite', desc: { kind: 'plan', detail: '1/2 concluídas' } });
    expect(describeGrokTool('monitor', { command: 'sleep 5', description: 'Espera o build' })).toMatchObject({ tool: 'Monitor' });
    expect(describeGrokTool('get_command_or_subagent_output', { task_ids: ['x'] })).toMatchObject({ tool: 'TaskOutput' });
    expect(describeGrokTool('kill_command_or_subagent', { task_id: 'x' })).toMatchObject({ tool: 'TaskStop' });
    expect(describeGrokTool('web_fetch', { url: 'https://example.com/docs' })).toMatchObject({ tool: 'WebFetch', desc: { kind: 'web' } });
    expect(describeGrokTool('Web search:', { variant: 'WebSearch' })).toMatchObject({ tool: 'WebSearch' });
    expect(describeGrokTool('spawn_subagent', { description: '[revisor] Revisar', prompt: 'Revise.' })).toMatchObject({ tool: 'Agent', desc: { kind: 'delegate', text: 'Delegando: [revisor] Revisar' } });
    // MCP: `servidor__ferramenta` (direto ou pelo despachante use_tool) vira mcp__servidor__ferramenta.
    expect(describeGrokTool('use_tool', { tool_name: 'github__create_issue', tool_input: { title: 'x' } })).toMatchObject({ tool: 'mcp__github__create_issue', desc: { kind: 'mcp' } });
    expect(describeGrokTool('context7__resolve-library-id', { libraryName: 'next' })).toMatchObject({ tool: 'mcp__context7__resolve-library-id' });
  });

  it('instrução em pedaços: um prompt só, com o título; imagem sem texto vira "[imagem]"', () => {
    const at = Date.parse('2026-10-19T12:00:00Z');
    const { state, results } = feed([G.user(S, 'Rode os testes ', { at }), G.user(S, 'da loja', { at: at + 1 }), G.userImage(S, { at: at + 2 }), G.thought(S, 'hmm', { at: at + 3 })]);
    expect(state.title).toBe('Rode os testes');
    expect(kinds(results)).toEqual(['prompt', 'think']);
    expect(signals(results).filter((s) => s === 'turnStart')).toHaveLength(1);
    expect(state.turnOpen).toBe(true);
    const only = feed([G.userImage(S, { at }), G.agent(S, 'ok', { at: at + 1 })]);
    expect(texts(only.results)[0]).toBe('Recebeu “[imagem]”');
  });

  it('resposta em pedaços: uma atividade por sequência; os pedaços seguintes só continuam', () => {
    const at = Date.parse('2026-10-19T12:00:00Z');
    const { results } = feed([G.user(S, 'Oi', { at }), G.agent(S, 'Os testes ', { at: at + 1 }), G.agent(S, 'passaram.', { at: at + 2 }), G.toolCall(S, 'c1', 'read_file', { target_file: '/p/a.ts' }, { at: at + 3 }), G.agent(S, 'Pronto.', { at: at + 4 })]);
    expect(kinds(results)).toEqual(['prompt', 'respond', 'read', 'respond']);
    expect(results[1].activities[0].activity.detail).toBe('Os testes');
  });

  it('comando que falha: erro com a primeira linha da saída; GitHub detectado pelo comando e pela saída', () => {
    const at = Date.parse('2026-10-19T12:00:00Z');
    const { state, results } = feed([
      G.user(S, 'Suba', { at }),
      G.toolCall(S, 'c1', 'run_terminal_command', { command: 'npm test' }, { at: at + 1 }),
      G.toolDone(S, 'c1', { at: at + 2, exitCode: 1, text: 'npm ERR! 1 teste falhou\n', command: 'npm test' }),
      G.toolCall(S, 'c2', 'run_terminal_command', { command: 'git push origin feat/x' }, { at: at + 3 }),
      G.toolDone(S, 'c2', { at: at + 4, exitCode: 0, text: 'To github.com:fulano/loja.git\n   abc123..def456  feat/x -> feat/x\n', command: 'git push origin feat/x' }),
      G.toolCall(S, 'c3', 'read_file', { target_file: '/p/a.ts' }, { at: at + 5 }),
      G.toolDone(S, 'c3', { at: at + 6, status: 'failed', text: 'arquivo não existe' }),
    ]);
    expect(state.stats.toolCalls).toBe(3);
    expect(state.pending.size).toBe(0);
    expect(texts(results)).toEqual(['Recebeu “Suba”', 'Rodando testes', 'Erro em Bash', 'Enviando commits (git push)', 'Lendo a.ts', 'Erro em Read']);
    expect(results[2].activities[0].activity).toMatchObject({ id: 'acc:s#c1:e', error: true, detail: 'npm ERR! 1 teste falhou' });
    expect(results[4].signals.find((s) => s.type === 'github')).toMatchObject({ type: 'github', key: 'c2' });
    expect(results[6].activities[0].activity).toMatchObject({ id: 'acc:s#c3:e', detail: 'arquivo não existe' });
    // Um tool_call_update sem status não conclui nada.
    const info = feed([G.toolCall(S, 'c9', 'read_file', { target_file: '/p/a.ts' }, { at }), G.toolInfo(S, 'c9', 'Read `/p/a.ts`', { at: at + 1 })]);
    expect(info.state.pending.size).toBe(1);
    expect(info.results[1].activities).toHaveLength(0);
  });

  it('turn_completed: soma os tokens por turno (o cache já está na entrada), fecha o turno e marca a conclusão', () => {
    const at = Date.parse('2026-10-19T12:00:00Z');
    const { state, results } = feed([
      G.user(S, 'a', { at }),
      G.turnCompleted(S, { at: at + 1, input: 1_000, output: 100, cached: 800, elapsedMs: 12_000, promptId: 'p1', model: 'grok-4.6' }),
      G.user(S, 'b', { at: at + 2 }),
      G.turnCompleted(S, { at: at + 3, input: 2_000, output: 50, promptId: 'p2', stopReason: 'cancelled' }),
      G.user(S, 'c', { at: at + 4 }),
      G.turnCompleted(S, { at: at + 5, input: 10, output: 1, promptId: 'p3', stopReason: 'api_error' }),
    ]);
    expect(state.stats).toMatchObject({ tokensIn: 3_010, tokensOut: 151 });
    // O modelo é o do último turno (modelUsage).
    expect(state.model).toBe('grok-teste');
    expect(state.turns).toBe(3);
    expect(state.turnOpen).toBe(false);
    expect(results[1].activities[0].activity).toMatchObject({ kind: 'done', text: 'Concluiu em 12s', durationMs: 12_000, id: 'acc:s#p1:done' });
    expect(results[1].signals).toEqual([{ type: 'turnEnd', aborted: false }]);
    expect(results[3].activities[0].activity).toMatchObject({ kind: 'wait', text: 'Interrompido por você' });
    expect(results[3].signals).toEqual([{ type: 'turnEnd', aborted: true }]);
    expect(results[5].activities[0].activity).toMatchObject({ kind: 'error', detail: 'api_error' });
  });

  it('hook_execution abre e fecha o turno sem duplicar; plan e todo_write viram tarefas; retry, compactação e tarefa em segundo plano', () => {
    const at = Date.parse('2026-10-19T12:00:00Z');
    const { state, results } = feed([
      G.hook(S, 'user_prompt_submit', { at }),
      G.user(S, 'a', { at: at + 1 }),
      G.plan(S, [{ content: 'Ler o código', status: 'completed' }, { content: 'Rodar os testes', status: 'in_progress' }], { at: at + 2 }),
      G.retry(S, { at: at + 3 }),
      G.compacted(S, { at: at + 4 }),
      G.taskCompleted(S, 'call-1', 'npm run build', { at: at + 5 }),
      G.hook(S, 'stop', { at: at + 6 }),
      G.turnCompleted(S, { at: at + 7 }),
    ]);
    expect(signals(results).filter((s) => s === 'turnStart')).toHaveLength(1);
    expect(signals(results).filter((s) => s === 'turnEnd')).toHaveLength(1);
    expect(state.turns).toBe(1);
    expect(state.tasks).toEqual([
      { id: '1', title: 'Ler o código', status: 'completed' },
      { id: '2', title: 'Rodar os testes', status: 'in_progress' },
    ]);
    expect(kinds(results)).toEqual(['prompt', 'wait', 'compact', 'other', 'done']);
    expect(results[5].activities[0]).toMatchObject({ current: false, activity: { id: 'acc:s#call-1:bg' } });
    expect(planTasks([{ id: '7', content: 'x', status: 'bogus' }])).toEqual([{ id: '7', title: 'x', status: 'pending' }]);
    const todo = feed([G.toolCall(S, 'c1', 'todo_write', { todos: [{ id: '0', content: 'A', status: 'completed' }] }, { at })]);
    expect(todo.state.tasks).toEqual([{ id: '0', title: 'A', status: 'completed' }]);
  });

  it('linhas inválidas ou desconhecidas não geram nada; sem atividades no contexto só o estado muda', () => {
    const at = Date.parse('2026-10-19T12:00:00Z');
    const { state, results } = feed(['{', 'null', JSON.stringify({ timestamp: 1, method: 'x', params: { update: { sessionUpdate: 'nada' } } })]);
    expect(results.every((r) => !r.activities.length && !r.signals.length)).toBe(true);
    // Uma linha desconhecida ainda conta para os horários (ela tem timestamp).
    expect(state.firstAt).toBe(1_000);
    const quiet = createGrokState();
    const r = parseUpdateLine(quiet, G.user(S, 'a', { at }), { ...ctx, activities: false });
    expect(r.activities).toHaveLength(0);
    expect(quiet.title).toBe('a');
    expect(r.signals).toEqual([{ type: 'turnStart' }]);
    expect(resultText({ content: [{ type: 'diff', path: '/a', oldText: '', newText: 'x' }], rawOutput: { output_for_prompt: 'exit: 0\nok\n' } })).toBe('exit: 0\nok\n');
  });
});
