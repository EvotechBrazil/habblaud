#!/usr/bin/env node
// Hook do Habblaud para o Grok Build CLI (xAI): mostra no escritório, na hora, o que as sessões do Grok fazem.
// `npm run grok:install` grava <GROK_HOME>/hooks/habblaud.json (um arquivo só do Habblaud; os outros hooks do Grok
// ficam como estão), com um grupo por evento que roda:
//
//   node "/caminho/do/habblaud/mod/habblaud-grok/hook.mjs"
//
// Porta fica em ~/.habblaud/grok-hook.json ({port}, gravado pelo instalador); HABBLAUD_PORT vale como reserva.
//
// O hook:
// 1. lê do stdin o JSON do evento (session_id/sessionId, hook_event_name, cwd, tool_name, tool_input...);
// 2. manda o evento, com os textos cortados, para POST http://127.0.0.1:<porta>/api/grok/events (prazo curto), com
//    a conta (basename do GROK_HOME, como o servidor calcula) e o caminho do GROK_HOME.
// Só observa: NUNCA decide nada (nada de deny, block ou updatedInput) e nunca imprime no stdout (no SessionStart e
// no UserPromptSubmit o stdout viraria contexto ou mensagem). Fail-open: todo erro = sair com 0 e sem saída, antes
// do tempo limite do Grok (que também é curto). Só fala com 127.0.0.1.
//
// Regras: Node puro (22+), só `node:*`, sem dependências. HABBLAUD_HOOK_DEBUG=1 escreve o que acontece no stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
/** Arquivo de configuração, em ~/.habblaud (o instalador grava). */
export const CONFIG_FILE = 'grok-hook.json';
/** Eventos mandados ao Habblaud. */
export const OBSERVED = new Set([
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
/** Prazo do envio de um evento: o Habblaud responde na hora (e o hook não pode atrasar o Grok). */
const EVENT_TIMEOUT_MS = 1_500;
/** O SessionEnd tem pouco tempo no Grok (1,5 s para a fila toda, ao sair). */
const SESSION_END_TIMEOUT_MS = 600;
const STDIN_TIMEOUT_MS = 5_000;
const MAX_STDIN = 8 * 1024 * 1024;
/** Textos do evento e dos argumentos mandados ao Habblaud (o servidor só mostra prévias). */
const MAX_STRING = 8_000;
/** Corpo do pedido (o servidor recusa acima de 256 KB). */
const MAX_BODY = 200_000;

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-grok] ${msg}\n`) : () => {};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

/** Caminho absoluto, com `~`/`$HOME` expandidos e sem barra final (como o servidor normaliza as pastas das contas). */
function expandHome(p, home) {
  const abs = resolve(p.trim().replace(/^~(?=[\\/]|$)/, home).replace(/\$\{HOME\}|\$HOME\b/g, home));
  return abs.length > 1 ? abs.replace(/[\\/]+$/, '') : abs;
}

/** Porta: ~/.habblaud/grok-hook.json ({port}); sem porta no arquivo, HABBLAUD_PORT; senão o padrão. */
export function readConfig(env = process.env) {
  const home = env.HOME || homedir();
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const f = isObject(file) ? file : {};
  const filePort = Number(f.port);
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  return { port: validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT };
}

/** GROK_HOME da sessão: a variável, se veio; senão ~/.grok. */
export function grokHomeOf(env) {
  const home = env.HOME || homedir();
  const fromEnv = typeof env.GROK_HOME === 'string' ? env.GROK_HOME.trim() : '';
  if (fromEnv) return expandHome(fromEnv, home);
  return join(home, '.grok');
}

/** Id da conta = basename do GROK_HOME (como o servidor dá ids às contas; colisões ele resolve pelo caminho). */
export function accountOf(grokHome) {
  return basename(grokHome) || grokHome;
}

/** Corta textos longos (saída de comando, conteúdo de arquivo...). */
export function trimInput(v, max = MAX_STRING, depth = 0) {
  if (typeof v === 'string') return v.length > max ? v.slice(0, max) : v;
  if (depth > 8 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => trimInput(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = trimInput(x, max, depth + 1);
  return out;
}

/** O valor com os textos cortados; se ainda ficar grande demais no corpo, corta mais curto. */
function fitted(v, size) {
  let out = v;
  for (const max of [MAX_STRING, 1_000, 200]) {
    out = trimInput(v, max);
    if (size(out) <= MAX_BODY) break;
  }
  return out;
}

/** Corpo de POST /api/grok/events: o stdin do hook inteiro, com os textos cortados. */
export function eventBody(input, account, grokHome) {
  const body = { account, grokHome, event: input };
  body.event = fitted(input, (event) => JSON.stringify({ ...body, event }).length);
  return body;
}

function readStdin() {
  return new Promise((ok) => {
    const chunks = [];
    let size = 0;
    const finish = (text) => {
      clearTimeout(timer);
      ok(text);
    };
    const timer = setTimeout(() => finish(undefined), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return finish(undefined);
      chunks.push(c);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(undefined));
  });
}

/** Requisição ao Habblaud local; null = fora do ar, tempo esgotado ou resposta ilegível. */
async function call(base, path, body, timeoutMs) {
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    debug(`POST ${path}: ${err?.name ?? 'erro'} ${err?.message ?? ''}`);
    return null;
  }
}

/** Manda o evento ao Habblaud. Devolve true se o Habblaud respondeu. Nunca lança, nunca imprime. */
export async function run(env = process.env, stdinText) {
  try {
    const raw = stdinText ?? (await readStdin());
    if (!raw) return false;
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isObject(input) || typeof input.hook_event_name !== 'string') return false;
    const sessionId = typeof input.session_id === 'string' ? input.session_id : typeof input.sessionId === 'string' ? input.sessionId : '';
    if (!sessionId) return false;
    const event = input.hook_event_name;
    if (!OBSERVED.has(event)) return false;
    const cfg = readConfig(env);
    const grokHome = grokHomeOf(env);
    const account = accountOf(grokHome);
    const base = `http://127.0.0.1:${cfg.port}`;
    const sent = await call(base, '/api/grok/events', eventBody(input, account, grokHome), event === 'SessionEnd' ? SESSION_END_TIMEOUT_MS : EVENT_TIMEOUT_MS);
    debug(`${event}: ${sent ? `${sent.status} ${JSON.stringify(sent.json ?? null)}` : 'Habblaud fora do ar'}`);
    return !!sent;
  } catch (err) {
    debug(`erro: ${err?.message ?? err}`);
    return false;
  }
}

export async function main() {
  // Rede de segurança: nada mantém o processo vivo além do envio (o Grok também tem o tempo limite do hook).
  setTimeout(() => process.exit(0), EVENT_TIMEOUT_MS + STDIN_TIMEOUT_MS + 2_000).unref();
  await run();
  // Sem process.exit() logo depois do fetch (nodejs/node#56645 no Windows): o loop esvazia sozinho.
  setTimeout(() => process.exit(0), 1_000).unref();
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
