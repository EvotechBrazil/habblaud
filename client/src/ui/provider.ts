// De qual ferramenta é cada coisa (Claude Code, Codex ou Grok) e os textos que mudam com ela. Puro (sem DOM): testado
// em ui/provider.test.ts. No protocolo, `provider` ausente quer dizer Claude Code (shared/types.ts); aqui tudo cai nisso.
//
// Identidade visual das outras ferramentas (sem logotipo de ninguém): o chip da conta fica "vazado" (fundo escuro,
// borda e letra na cor da conta, cantos em degrau) e, onde há espaço, um selo de texto com o nome ("Codex", "Grok")
// ao lado do nome da conta.
import type { AccountInfo, OfficeSnapshot, Provider } from '../../../shared/types';
import { shortcutHint } from './model';
import { tr } from '../../../shared/i18n';

/** Nome de cada ferramenta como aparece nos textos. */
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok' };

/** Ferramenta de um agente, conta, sessão ou pedido (ausente = Claude Code). */
export function providerOf(x: { provider?: Provider } | null | undefined): Provider {
  return x?.provider ?? 'claude';
}

export function isCodex(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'codex';
}

export function isGrok(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'grok';
}

/** Outra ferramenta que não o Claude Code (chip vazado e selo). */
export function isExternal(x: { provider?: Provider } | null | undefined): boolean {
  return providerOf(x) !== 'claude';
}

/** Ferramentas que contam tokens mas não gravam custo (o "Meu dia" mostra só os tokens delas). */
export function recordsCost(provider: Provider): boolean {
  return provider === 'claude';
}

/**
 * O id de conta tem cara de pasta do Codex (".codex", ".codex-trabalho", ".codex~2", "demo:.codex")? Só para quando a
 * conta já não está no snapshot (ex.: histórico, "Meu dia"): com a conta à mão, vale o `provider` dela.
 */
export function looksLikeCodexId(id: string): boolean {
  return /(?:^|[:/\\])\.?codex(?:[-_.~]|$)/i.test(id);
}

/** O mesmo para o Grok (".grok", ".grok-trabalho", ".grok~2"). */
export function looksLikeGrokId(id: string): boolean {
  return /(?:^|[:/\\])\.?grok(?:[-_.~]|$)/i.test(id);
}

/** Ferramenta da conta: a do snapshot; sem ela, a dica de quem chamou ou o jeito do id. */
export function accountProvider(account: Pick<AccountInfo, 'provider'> | undefined, fallbackId = '', hint?: Provider): Provider {
  if (account) return providerOf(account);
  return hint ?? (looksLikeCodexId(fallbackId) ? 'codex' : looksLikeGrokId(fallbackId) ? 'grok' : 'claude');
}

/**
 * Letra do chip de uma conta que não está no snapshot: a primeira letra depois do prefixo da pasta
 * (".claude-conta2" -> "C", ".codex-trabalho" -> "T", ".grok-casa" -> "C"). A pasta padrão do Codex (".codex") vira
 * "X", a do Grok (".grok") "G"; a do Claude Code, "?" (como antes). Nunca devolve "." nem vazio.
 */
export function fallbackShort(id: string, provider: Provider = accountProvider(undefined, id)): string {
  const rest = id
    .replace(/^.*:/, '')
    .replace(/~\d+$/, '')
    .replace(/^\.?(?:claude|codex|grok)(?=[-_.]|$)[-_.]?/i, '');
  const letter = /[\p{L}\p{N}]/u.exec(rest)?.[0];
  if (letter) return letter.toUpperCase();
  return provider === 'codex' ? 'X' : provider === 'grok' ? 'G' : '?';
}

/** O selo com o nome da ferramenta ao lado do nome da conta (não repete quando o nome já diz "Codex"/"Grok"). */
export function showsProviderTag(provider: Provider, accountName = ''): boolean {
  return provider !== 'claude' && !accountName.toLowerCase().includes(PROVIDER_NAME[provider].toLowerCase());
}

/** Rótulo do chip da conta (dica e leitores de tela): "Conta C (dev@x.com)", "Codex · plano Team", "Grok". */
export function accountChipLabel(account: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'provider'> | undefined, fallbackId: string, provider: Provider): string {
  if (!account) return fallbackId ? `${fallbackId}${provider !== 'claude' ? ` · ${PROVIDER_NAME[provider]}` : ''}` : tr('Conta desconhecida');
  if (provider === 'claude') return `${account.name}${account.email ? ` (${account.email})` : ''}`;
  const tag = showsProviderTag(provider, account.name) ? ` · ${PROVIDER_NAME[provider]}` : '';
  return `${account.name}${tag}${account.plan ? tr(' · plano {0}', [account.plan]) : ''}`;
}

/**
 * Texto do escritório vazio. Os atalhos ("atalhos c ou d") são só das contas do Claude Code, que vêm de aliases do
 * shell (a letra de uma conta do Codex ou do Grok não é um atalho); as outras ferramentas só entram quando há uma
 * conta delas.
 */
export function emptyOfficeHint(accounts: readonly Pick<AccountInfo, 'short' | 'provider'>[]): string {
  const keys = shortcutHint(accounts.filter((a) => !isExternal(a)));
  const others = (['codex', 'grok'] as const).filter((p) => accounts.some((a) => a.provider === p)).map((p) => PROVIDER_NAME[p]);
  if (!others.length) return tr('Abra o Claude Code em qualquer projeto{0} e veja seu agente chegar.', [keys ? ` (${keys})` : '']);
  return tr('Abra o Claude Code{0} ou o {1} em qualquer projeto e veja seu agente chegar.', [keys ? ` (${keys})` : '', others.join(tr(' ou o '))]);
}

/** Algum pedido de permissão do Codex esperando: o prazo é curto e o cartão conta os segundos (relógio de 1 s). */
export function hasCodexPermission(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => a.permission && isCodex(a.permission) && a.status !== 'offline' && a.status !== 'done');
}

/** Como ver o Codex ao vivo e aprovar pelo escritório (gaveta de um agente do Codex e ajuda). */
export const CODEX_LIVE_HINT = tr('Para ver o Codex ao vivo e aprovar pelo escritório: `npm run codex:install` e aprove os hooks em `/hooks` no Codex.');

/** Como ver o Grok ao vivo (gaveta de um agente do Grok e ajuda). */
export const GROK_LIVE_HINT = tr('Para ver o Grok ao vivo (cada passo na hora, mão levantada): `npm run grok:install`. Sem aprovar nada no Grok: os hooks globais dele são sempre confiáveis.');

/** Políticas de aprovação do Codex (`approval_policy`), quando o servidor as manda no lugar do modo de permissão. */
const CODEX_APPROVALS: Record<string, string> = {
  untrusted: tr('Pergunta antes de quase tudo'),
  'on-request': tr('Pergunta quando precisa'),
  'on-failure': tr('Pergunta quando um comando falha'),
  never: tr('Nunca pergunta'),
};

/** Aprovação de um agente do Codex em português (valor desconhecido passa como veio). */
export function codexApprovalLabel(policy: string | undefined): string {
  if (!policy) return '—';
  return CODEX_APPROVALS[policy] ?? policy;
}
