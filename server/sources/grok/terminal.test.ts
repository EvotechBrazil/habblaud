// Terminal do Grok: as linhas do updates.jsonl viram entradas do terminal (sessões reais anonimizadas e sintéticas).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { G, GROK_FIXTURES, sessionId } from '../../test/grok-fixtures';
import { createGrokTerminalParser } from './terminal';

const S = sessionId(1);

function run(lines: string[]): TerminalEntry[] {
  const p = createGrokTerminalParser();
  return lines.flatMap((l) => p.push(l));
}

describe('terminal do Grok', () => {
  it('sessão real: prompt, raciocínio, leituras com resultado, resposta e o fim do turno, na ordem', () => {
    const lines = readFileSync(join(GROK_FIXTURES, 'curta', 'updates.jsonl'), 'utf8').split('\n').filter(Boolean);
    const out = run(lines);
    const kinds = out.map((e) => e.kind);
    expect(kinds[0]).toBe('user');
    // O prompt veio com dois anexos (resource_link): contam como imagens.
    expect(out[0]).toMatchObject({ kind: 'user', text: 'Rode os testes da loja e me diga o que falhou.\n[imagem] [imagem]' });
    expect(kinds).toContain('thinking');
    expect(out.filter((e) => e.kind === 'tool')).toHaveLength(2);
    expect(out.filter((e) => e.kind === 'result')).toHaveLength(2);
    // Sem o cwd (o parser não lê o summary.json), os caminhos saem absolutos.
    expect(out.find((e) => e.kind === 'tool')).toMatchObject({ tool: 'Read', title: 'Read(/projetos/loja/frames/quadro.jpg)' });
    // A resposta pode sair em mais de uma entrada (uma por sequência de pedaços).
    expect(out.filter((e) => e.kind === 'assistant').map((e) => (e as { text: string }).text).join(' ')).toContain('Os testes passaram. Ajustei o README');
    expect(out[out.length - 1]).toMatchObject({ kind: 'system', text: 'Turno concluído em 12s' });
    // Ids únicos (o terminal não duplica).
    expect(new Set(out.map((e) => e.id)).size).toBe(out.length);
  });

  it('sessão real média: comandos com a saída, busca e listagem', () => {
    const lines = readFileSync(join(GROK_FIXTURES, 'media', 'updates.jsonl'), 'utf8').split('\n').filter(Boolean);
    const out = run(lines);
    const tools = out.filter((e): e is Extract<TerminalEntry, { kind: 'tool' }> => e.kind === 'tool');
    expect(tools.map((t) => t.tool)).toEqual(expect.arrayContaining(['Bash', 'Grep', 'LS', 'Read']));
    const bash = tools.find((t) => t.tool === 'Bash')!;
    expect(bash).toMatchObject({ title: 'Bash(npm test)', input: 'npm test', inputKind: 'command' });
    const result = out.find((e) => e.kind === 'result' && e.toolUseId === bash.id);
    expect(result).toMatchObject({ kind: 'result', text: 'ok' });
  });

  it('sintético: edição com diff, escrita, comando que falha, interrupção, retry e compactação', () => {
    const at = Date.parse('2026-10-19T12:00:00Z');
    const out = run([
      G.user(S, 'Arrume ', { at }),
      G.user(S, 'o teste', { at: at + 1 }),
      G.toolCall(S, 'c1', 'search_replace', { file_path: '/projetos/loja/src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }, { at: at + 2 }),
      G.toolDone(S, 'c1', { at: at + 3, text: '' }),
      G.toolCall(S, 'c2', 'write', { file_path: '/projetos/loja/README.md', content: '# Loja\n' }, { at: at + 4 }),
      G.toolCall(S, 'c3', 'run_terminal_command', { command: 'npm test' }, { at: at + 5 }),
      G.toolDone(S, 'c3', { at: at + 6, exitCode: 1, text: 'falhou\n', command: 'npm test' }),
      G.retry(S, { at: at + 7 }),
      G.compacted(S, { at: at + 8 }),
      G.agent(S, 'Corrigi.', { at: at + 9 }),
      G.turnCompleted(S, { at: at + 10, stopReason: 'cancelled', promptId: 'p1' }),
    ]);
    expect(out.map((e) => e.kind)).toEqual(['user', 'tool', 'result', 'tool', 'tool', 'result', 'system', 'system', 'assistant', 'system']);
    expect(out[0]).toMatchObject({ text: 'Arrume o teste' });
    expect(out[1]).toMatchObject({ tool: 'Edit', title: 'Edit(/projetos/loja/src/a.ts)', inputKind: 'diff' });
    expect(out[2]).toMatchObject({ kind: 'result', text: '(sem saída)' });
    expect(out[3]).toMatchObject({ tool: 'Write', title: 'Write(/projetos/loja/README.md)', input: '# Loja' });
    expect(out[5]).toMatchObject({ kind: 'result', error: true, text: 'Código de saída 1\nfalhou' });
    expect(out[6]).toMatchObject({ kind: 'system', level: 'warn', text: 'Instabilidade na API, tentando de novo' });
    expect(out[7]).toMatchObject({ kind: 'system', text: 'Conversa compactada' });
    expect(out[9]).toMatchObject({ kind: 'system', level: 'warn', text: 'Interrompido pelo usuário', id: 'p1:int:s' });
  });

  it('linhas inválidas são puladas; pedaços sem fim só saem quando outra coisa acontece', () => {
    const p = createGrokTerminalParser();
    expect(p.push('{')).toEqual([]);
    expect(p.push(G.agent(S, 'metade'))).toEqual([]);
    const out = p.push(G.turnCompleted(S));
    expect(out.map((e) => e.kind)).toEqual(['assistant', 'system']);
  });
});
