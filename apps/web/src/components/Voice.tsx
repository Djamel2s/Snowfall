import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Mic, Square, Volume2 } from 'lucide-react'
import { api } from '../lib/api'
import { useI18n } from '../lib/i18n'

/** Durée maximale d'une dictée : au-delà, l'enregistrement s'arrête seul. */
const MAX_DICTATION_MS = 120_000

/** Format d'enregistrement accepté par le serveur, selon le navigateur. */
function recordingType() {
  for (const type of ['audio/webm', 'audio/ogg', 'audio/mp4']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
  }
  return null
}

/**
 * Dictée : la voix est transcrite par le service local, puis le texte arrive
 * dans la zone de saisie (rien n'est envoyé avant que tu valides).
 */
export function DictationButton({ disabled, language, onText, onError }: { disabled: boolean; language: 'fr' | 'en'; onText: (text: string) => void; onError: (message: string) => void }) {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const recorder = useRef<MediaRecorder | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      recorder.current?.stream.getTracks().forEach((track) => track.stop())
    },
    [],
  )

  async function start() {
    const type = recordingType()
    if (!type || !navigator.mediaDevices?.getUserMedia) return onError(t('voice.unsupported'))
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      return onError(t('voice.denied'))
    }
    const chunks: Blob[] = []
    const media = new MediaRecorder(stream, { mimeType: type })
    media.ondataavailable = (event) => event.data.size && chunks.push(event.data)
    media.onstop = () => {
      stream.getTracks().forEach((track) => track.stop())
      window.clearTimeout(timer.current)
      setState('transcribing')
      api
        .transcribe(new Blob(chunks, { type }), type, language)
        .then((text) => text && onText(text))
        .catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setState('idle'))
    }
    recorder.current = media
    media.start()
    setState('recording')
    timer.current = window.setTimeout(() => media.state === 'recording' && media.stop(), MAX_DICTATION_MS)
  }

  const label = state === 'recording' ? t('voice.stop') : state === 'transcribing' ? t('voice.transcribing') : t('voice.dictate')
  return (
    <button
      type="button"
      className={`attachment-button dictation-button${state === 'recording' ? ' recording' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={state === 'recording'}
      disabled={disabled || state === 'transcribing'}
      onClick={() => (state === 'recording' ? recorder.current?.stop() : void start())}
    >
      {state === 'recording' ? <Square size={13} fill="currentColor" /> : state === 'transcribing' ? <LoaderCircle size={16} className="spin" /> : <Mic size={16} />}
    </button>
  )
}

/** Lecture d'une réponse à voix haute (voix locale) ; un second clic l'arrête. */
export function ReadAloudButton({ text, onError }: { text: string; onError: (message: string) => void }) {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle')
  const audio = useRef<HTMLAudioElement | null>(null)

  useEffect(() => () => audio.current?.pause(), [])

  async function play() {
    if (state === 'playing') {
      audio.current?.pause()
      setState('idle')
      return
    }
    setState('loading')
    try {
      const url = URL.createObjectURL(await api.speak(text))
      const element = new Audio(url)
      audio.current = element
      const done = () => {
        URL.revokeObjectURL(url)
        setState('idle')
      }
      element.onended = done
      element.onpause = done
      await element.play()
      setState('playing')
    } catch (cause) {
      setState('idle')
      onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const label = state === 'playing' ? t('voice.stopReading') : t('voice.read')
  return (
    <button className="copy-message" aria-label={label} title={label} aria-pressed={state === 'playing'} disabled={state === 'loading'} onClick={() => void play()}>
      {state === 'loading' ? <LoaderCircle size={14} className="spin" /> : state === 'playing' ? <Square size={12} fill="currentColor" /> : <Volume2 size={14} />}
    </button>
  )
}
