// Eventos dos hooks do Grok (a parte "ao vivo" da fonte do Grok): o script de hook (mod/habblaud-grok/hook.mjs)
// manda o stdin do evento para POST /api/grok/events e a rota repassa aqui. A fonte do Grok (sources/grok/source.ts)
// implementa.
import type { GrokUsagePost } from './billing';
import type { ActiveSession } from './files';

export interface GrokLive {
  /**
   * Aplica um evento de hook do Grok (o stdin dele: `hook_event_name`, `session_id`, `cwd`, `tool_name`,
   * `tool_use_id`, `tool_input`, `notification_type`...; o Grok também grava as chaves em camelCase) ao escritório.
   * `account` = conta do Grok de quem mandou (id da conta ou a pasta GROK_HOME; ausente = deduzida da sessão).
   * Devolve false para evento desconhecido ou sessão que não casa com nenhuma conta do Grok.
   */
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean;
  /**
   * Registro das sessões abertas de uma conta vindo do auxiliar do host (POST /api/grok/registry, scripts/codex-bridge.ts):
   * o active_sessions.json do host, já só com os processos vivos. Vale no Docker, onde o arquivo não chega ao container;
   * fora dele o arquivo lido aqui manda. Devolve false para conta que não casa com nenhuma do Grok.
   */
  applyRegistry(account: string | undefined, sessions: readonly ActiveSession[]): boolean;
  /**
   * A cota do Grok lida pelo auxiliar do host no log do Grok (campo `usage` de POST /api/grok/registry; o container
   * não monta logs/): só a janela semanal e o plano. Vale a leitura mais recente (`fetchedAt`), de onde vier. false
   * para conta que não casa.
   */
  applyUsage(account: string | undefined, usage: GrokUsagePost): boolean;
}
