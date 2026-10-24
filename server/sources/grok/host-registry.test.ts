// A conferência dos processos do registro do Grok no host (auxiliar): parse do `lstart` do ps, PID vivo + pid_start,
// o cache do ps e a leitura do active_sessions.json. Dados sintéticos; só um caso usa o `ps` de verdade (este processo).
import { afterEach, describe, expect, it } from 'vitest';
import { grokHome, sessionId } from '../../test/grok-fixtures';
import type { ActiveSession } from './files';
import { createLivenessCheck, parseLstart, processStartTimes, PS_CACHE_MS, readLiveSessions } from './host-registry';

const A = sessionId(1);
const B = sessionId(2);
const C = sessionId(3);
const D = sessionId(4);
const E = sessionId(5);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function entry(id: string, pid: number, pidStart?: number): ActiveSession {
  return { sessionId: id, pid, cwd: '/p/loja', ...(pidStart !== undefined ? { pidStart } : {}) };
}

describe('host-registry (registro do Grok lido no host)', () => {
  it('parseLstart: a coluna lstart do ps (hora local), com ou sem o dia da semana', () => {
    expect(parseLstart('Thu Oct 22 14:41:43 2026')).toBe(new Date(2026, 9, 22, 14, 41, 43).getTime());
    expect(parseLstart('  Oct  2 09:05:01 2026 ')).toBe(new Date(2026, 9, 2, 9, 5, 1).getTime());
    expect(parseLstart('nada')).toBeUndefined();
    expect(parseLstart('Thu Xyz 22 14:41:43 2026')).toBeUndefined();
  });

  it('createLivenessCheck: PID morto cai; pid_start que não bate com o ps (PID reaproveitado) cai; sem pid_start ou sem o ps, fica', () => {
    let clock = 0;
    const asked: number[][] = [];
    const starts = new Map([
      [1, 1_000_000],
      [2, 5_000_000],
    ]);
    const live = createLivenessCheck({
      isAlive: (pid) => pid !== 9,
      startTimes: (pids) => {
        asked.push([...pids]);
        return new Map([...pids].filter((p) => starts.has(p)).map((p) => [p, starts.get(p)!]));
      },
      now: () => clock,
    });
    const list = [
      entry(A, 1, 1_002_000_000), // 1 002 000 ms: dentro da tolerância de 5 s
      entry(B, 2, 9_000_000_000), // 9 000 000 ms, o ps diz 5 000 000: outro processo com o mesmo PID
      entry(C, 3, 123), // o ps não listou: fica (só o PID vivo conta)
      entry(D, 4), // sem pid_start: fica
      entry(E, 9, 1), // morto
    ];
    expect(live(list).map((x) => x.sessionId)).toEqual([A, C, D]);
    expect(asked).toEqual([[1, 2, 3]]);
    // O ps só é perguntado de novo depois de PS_CACHE_MS.
    clock = PS_CACHE_MS - 1;
    expect(live(list).map((x) => x.sessionId)).toEqual([A, C, D]);
    expect(asked.length).toBe(1);
    clock = PS_CACHE_MS;
    live(list);
    expect(asked.length).toBe(2);
  });

  it('readLiveSessions: sem o arquivo, nenhuma; com ele, só as que o conferidor deixou', () => {
    const home = grokHome();
    cleanups.push(home.cleanup);
    home.active([
      { id: A, pid: 1 },
      { id: B, pid: 2 },
    ]);
    const onlyPid1 = (entries: readonly ActiveSession[]) => entries.filter((e) => e.pid === 1);
    expect(readLiveSessions(home.dir, onlyPid1).map((e) => e.sessionId)).toEqual([A]);
    home.noActive();
    expect(readLiveSessions(home.dir, onlyPid1)).toEqual([]);
  });

  it('processStartTimes: o início deste processo bate com o uptime (fora do Windows)', () => {
    const m = processStartTimes([process.pid]);
    if (process.platform === 'win32') {
      expect(m.size).toBe(0);
      return;
    }
    const expected = Date.now() - process.uptime() * 1_000;
    expect(Math.abs(m.get(process.pid)! - expected)).toBeLessThan(5_000);
    expect(processStartTimes([])).toEqual(new Map());
  });
});
