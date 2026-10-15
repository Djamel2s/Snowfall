import type { ProviderId } from './api'
import anthropic from '../assets/providers/anthropic.svg'
import google from '../assets/providers/google.svg'
import local from '../assets/providers/local.svg'
import mistral from '../assets/providers/mistral.svg'
import openai from '../assets/providers/openai.svg'
import { providerLabels } from './provider-labels'

const logos: Record<ProviderId, string> = { mistral, openai, anthropic, google, local }

export const providerMeta = Object.fromEntries(
  (Object.keys(logos) as ProviderId[]).map((id) => [id, { label: providerLabels[id], logo: logos[id] }]),
) as Record<ProviderId, { label: string; logo: string }>
