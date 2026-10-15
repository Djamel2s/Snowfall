import type { ProviderId } from './api'

export const providerLabels: Record<ProviderId, string> = {
  mistral: 'Mistral',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  local: 'Local',
}
