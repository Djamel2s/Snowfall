import { useEffect, useRef, useState } from 'react'
import { api, approvalStep, isPaused, type AgentStep, type Message, type RunSnapshot } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { useReasoning } from './useReasoning'

/** Ce que fait une réponse : 'paused' (attend une validation), l'id de la réponse, ou rien. */
type RunOutcome = 'paused' | string | void
type Runner = (signal: AbortSignal, onToken: (text: string) => void) => Promise<RunOutcome>

type Options = {
  /** Remplace les messages d'une conversation (relecture serveur, question d'une réponse reprise). */
  updateMessages: (conversationId: string, update: (messages: Message[]) => Message[]) => void
  /** Réponse terminée et enregistrée (l'interface est déjà revenue au repos). */
  onFinished: (conversationId: string, answerId: string | undefined) => Promise<void> | void
  onFailed: (cause: unknown) => void
  /** Nouvelle réponse : l'erreur affichée est effacée. */
  onStart: () => void
}

/**
 * Une réponse en cours, de bout en bout : flux de texte, étapes de l'agent,
 * réflexion, pause sur une validation, reprise, arrêt et reconnexion.
 *
 * Le serveur exécute la réponse (exécution durable) ; ce hook ne fait que la
 * suivre. Une seule réponse suivie à la fois : celle de streamingId.
 */
export function useRun({ updateMessages, onFinished, onFailed, onStart }: Options) {
  const { t } = useI18n()
  const [sending, setSending] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  // Étapes de l'agent pendant la réponse (outils appelés), remplacées à chaque nouvel état.
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([])
  // Réponse en pause : elle attend ta décision sur une action.
  const [paused, setPaused] = useState(false)
  // Régénération : la dernière réponse est masquée pendant qu'une nouvelle s'écrit.
  const [regenerating, setRegenerating] = useState(false)
  // Conversation dont la réponse s'écrit (ou attend une validation).
  const streamingIdRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const stoppedRef = useRef(false)
  const { reasoning, reasoningByMessage, onReasoning, showReasoning, keepReasoning } = useReasoning()

  // Page quittée : on cesse de suivre (la réponse continue côté serveur).
  useEffect(() => () => abortRef.current?.abort(), [])

  const onStep = (step: AgentStep) =>
    setAgentSteps((current) => (current.some((item) => item.id === step.id) ? current.map((item) => (item.id === step.id ? { ...item, ...step } : item)) : [...current, step]))

  /** Fin de réponse : l'interface revient au repos. */
  function reset() {
    setSending(false)
    setStreamingText('')
    setAgentSteps([])
    setRegenerating(false)
    setPaused(false)
    showReasoning('')
    streamingIdRef.current = null
  }

  /** Messages relus depuis le serveur ; renvoie l'id de la dernière réponse. */
  async function refreshMessages(conversationId: string) {
    const messages = await api.getMessages(conversationId)
    updateMessages(conversationId, () => messages)
    return messages.at(-1)?.role === 'assistant' ? messages.at(-1)!.id : undefined
  }

  /**
   * Suit une réponse : envoi, reprise après une validation (resume : texte et
   * étapes conservés), ou reconnexion. Le runner renvoie « paused » si la
   * réponse attend une décision : l'interface reste alors sur la réponse en cours.
   */
  async function stream(conversationId: string, run: Runner, rollback: () => void, options: { resume?: boolean } = {}) {
    onStart()
    setSending(true)
    setPaused(false)
    if (!options.resume) {
      setAgentSteps([])
      showReasoning('')
    }
    streamingIdRef.current = conversationId
    stoppedRef.current = false
    const controller = new AbortController()
    abortRef.current = controller
    let keep = false

    try {
      const outcome = await run(controller.signal, (text) => {
        if (!controller.signal.aborted) setStreamingText((current) => current + text)
      })
      if (outcome === 'paused') {
        keep = true
        setPaused(true)
        return
      }
      // Réponse terminée : la réflexion reste consultable sous elle.
      if (outcome) keepReasoning(outcome)
      // La réponse enregistrée remplace tout de suite le flux : sinon les deux
      // s'affichent le temps des rafraîchissements qui suivent.
      reset()
      await onFinished(conversationId, outcome || undefined)
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        // Arrêt volontaire : la réponse partielle est enregistrée côté serveur.
        if (stoppedRef.current) setTimeout(() => void refreshMessages(conversationId).catch(() => undefined), 600)
        return
      }
      rollback()
      onFailed(cause)
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        if (!keep) reset()
      }
    }
  }

  /** Ne plus suivre la réponse (autre conversation ouverte) ; elle continue côté serveur. */
  function detach() {
    abortRef.current?.abort()
  }

  /**
   * Arrêter : demandé au serveur (fermer l'onglet ne suffit pas, la réponse
   * continuerait). La réponse partielle est gardée.
   */
  function stop() {
    stoppedRef.current = true
    const conversationId = streamingIdRef.current
    if (conversationId) api.cancelRun(conversationId).catch(() => undefined)
    abortRef.current?.abort()
    if (paused && conversationId) {
      reset()
      setTimeout(() => void refreshMessages(conversationId).catch(() => undefined), 600)
    }
  }

  /** Ta décision : la réponse reprend dans la même bulle (texte et étapes gardés). */
  async function decide(approvalId: string, approved: boolean) {
    const conversationId = streamingIdRef.current
    if (!conversationId) throw new Error(t('agent.approvalExpired'))
    setAgentSteps((current) => current.map((step) => (step.approval?.id === approvalId ? { ...step, approval: undefined } : step)))
    await stream(
      conversationId,
      async (signal, onToken) => {
        const result = await api.decideApproval(conversationId, approvalId, approved, { signal, onToken, onReasoning, onStep })
        if (isPaused(result)) return 'paused'
        return refreshMessages(conversationId)
      },
      () => void refreshMessages(conversationId).catch(() => undefined),
      { resume: true },
    )
  }

  /** Étapes et validations en attente d'une réponse reprise (reconnexion). */
  const restoreSteps = (snapshot: RunSnapshot) =>
    snapshot.approvals.reduce<AgentStep[]>(
      (steps, approval) => {
        const pending = approvalStep(approval)
        return steps.some((step) => step.id === pending.id)
          ? steps.map((step) => (step.id === pending.id ? { ...step, approval: pending.approval, status: 'running' } : step))
          : [...steps, pending]
      },
      snapshot.steps.map((step) => ({ ...step })),
    )

  /**
   * Conversation ouverte avec une réponse en cours (onglet rouvert, autre
   * appareil) : la question, le texte et les étapes réapparaissent, puis la
   * suite arrive en direct ; une validation en attente est proposée à nouveau.
   */
  async function resume(conversationId: string) {
    if (streamingIdRef.current) return
    const run = await api.getRun(conversationId).catch(() => null)
    if (!run || streamingIdRef.current) return
    if (run.kind === 'message') {
      updateMessages(conversationId, (messages) => [...messages, { id: `run-${run.id}`, role: 'user', content: run.question, createdAt: new Date().toISOString() }])
    } else {
      setRegenerating(true)
    }
    setStreamingText(run.text)
    showReasoning(run.reasoning ?? '')
    setAgentSteps(restoreSteps(run))
    if (run.status === 'waiting') {
      streamingIdRef.current = conversationId
      setSending(true)
      setPaused(true)
      return
    }
    await stream(
      conversationId,
      async (signal, onToken) => {
        const result = await api.watchRun(conversationId, {
          signal,
          onToken,
          onReasoning,
          onStep,
          onSnapshot: (snapshot) => {
            setStreamingText(snapshot.text)
            showReasoning(snapshot.reasoning ?? '')
            setAgentSteps(restoreSteps(snapshot))
          },
        })
        if (isPaused(result)) return 'paused'
        return refreshMessages(conversationId)
      },
      () => void refreshMessages(conversationId).catch(() => undefined),
      { resume: true },
    )
  }

  return {
    sending,
    streamingText,
    agentSteps,
    paused,
    regenerating,
    setRegenerating,
    reasoning,
    reasoningByMessage,
    /** À passer aux appels d'API d'une réponse. */
    handlers: { onReasoning, onStep },
    stream,
    stop,
    detach,
    decide,
    resume,
    refreshMessages,
  }
}
