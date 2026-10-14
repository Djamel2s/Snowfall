import type { ProviderId } from './api'
import anthropic from '../assets/providers/anthropic.svg'
import google from '../assets/providers/google.svg'
import local from '../assets/providers/local.svg'
import mistral from '../assets/providers/mistral.svg'
import openai from '../assets/providers/openai.svg'

export const providerMeta: Record<ProviderId, { label: string; logo: string }> = {
  mistral: { label: 'Mistral', logo: mistral },
  openai: { label: 'OpenAI', logo: openai },
  anthropic: { label: 'Anthropic', logo: anthropic },
  google: { label: 'Google', logo: google },
  local: { label: 'Local', logo: local },
}
