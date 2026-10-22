// Eventos dos hooks do Grok (a parte "ao vivo" da fonte do Grok): o script de hook (mod/habblaud-grok/hook.mjs)
// manda o stdin do evento para POST /api/grok/events e a rota repassa aqui. A fonte do Grok (sources/grok/source.ts)
// implementa.

export interface GrokLive {
  /**
   * Aplica um evento de hook do Grok (o stdin dele: `hook_event_name`, `session_id`, `cwd`, `tool_name`,
   * `tool_use_id`, `tool_input`, `notification_type`...; o Grok também grava as chaves em camelCase) ao escritório.
   * `account` = conta do Grok de quem mandou (id da conta ou a pasta GROK_HOME; ausente = deduzida da sessão).
   * Devolve false para evento desconhecido ou sessão que não casa com nenhuma conta do Grok.
   */
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean;
}
