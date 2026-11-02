import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, approveAiDraft, getAiDraft, getAiDrafts, getConversationMessages, getConversationResponseMode, getConversations, rejectAiDraft, sendApprovedAiDraft, updateConversationResponseMode, type AiDraftSourceMessage, type AiReplyDraft, type AiReplyDraftStatus, type ConversationResponseMode, type InboxConversation, type InboxMessage } from '../services/api'

const pageSize = 20
const conversationPageSize = 100
const reviewStatuses: { value: Extract<AiReplyDraftStatus, 'draft_ready' | 'approved' | 'rejected'>; label: string }[] = [
  { value: 'draft_ready', label: 'Pending review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
]

type DraftContext = {
  conversation?: InboxConversation
  sourceMessage: AiDraftSourceMessage | null
  recentMessages: InboxMessage[]
  error?: string
}

type SendFeedback = {
  draftId: string
  kind: 'sent' | 'already_sent' | 'definitive_failure' | 'uncertain'
  message: string
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Time unavailable'
}

function statusLabel(status: AiReplyDraftStatus): string {
  const labels: Record<AiReplyDraftStatus, string> = {
    queued: 'Queued',
    processing: 'Generating',
    draft_ready: 'Pending review',
    approved: 'Approved',
    rejected: 'Rejected',
    sending: 'Sending',
    sent: 'Sent',
    send_failed: 'Send failed',
    send_uncertain: 'Outcome uncertain',
    failed: 'Generation failed',
    cancelled: 'Cancelled',
  }
  return labels[status]
}

function statusClasses(status: AiReplyDraftStatus): string {
  if (status === 'draft_ready') return 'bg-amber-50 text-amber-800 ring-amber-200'
  if (status === 'approved' || status === 'sent') return 'bg-emerald-50 text-emerald-800 ring-emerald-200'
  if (status === 'rejected' || status === 'failed' || status === 'send_failed') return 'bg-rose-50 text-rose-700 ring-rose-200'
  if (status === 'send_uncertain') return 'bg-orange-50 text-orange-800 ring-orange-200'
  return 'bg-slate-100 text-slate-700 ring-slate-200'
}

async function loadConversationSummaries(conversationIds: string[]): Promise<Map<string, InboxConversation>> {
  const wanted = new Set(conversationIds)
  const summaries = new Map<string, InboxConversation>()
  let page = 1
  let totalPages = 1

  while (page <= totalPages && [...wanted].some((id) => !summaries.has(id))) {
    const result = await getConversations({ page, limit: conversationPageSize })
    totalPages = result.pagination.totalPages
    for (const conversation of result.conversations) {
      if (wanted.has(conversation.id)) summaries.set(conversation.id, conversation)
    }
    page += 1
  }

  return summaries
}

async function loadContextForDraft(
  draft: AiReplyDraft,
  summaries: Map<string, InboxConversation>,
): Promise<DraftContext> {
  const conversation = summaries.get(draft.conversationId)
  const context: DraftContext = { conversation, sourceMessage: draft.sourceMessage, recentMessages: [] }

  try {
    const history = await getConversationMessages(draft.conversationId, {
      page: 1,
      limit: conversationPageSize,
    })
    context.recentMessages = history.messages.slice(-6)
  } catch {
    context.error = 'Conversation messages could not be loaded.'
  }

  return context
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index])
    }
  }))
  return results
}

export function AiDraftsPage() {
  const [status, setStatus] = useState<Extract<AiReplyDraftStatus, 'draft_ready' | 'approved' | 'rejected'>>('draft_ready')
  const [page, setPage] = useState(1)
  const [refreshKey, setRefreshKey] = useState(0)
  const [drafts, setDrafts] = useState<AiReplyDraft[]>([])
  const [pagination, setPagination] = useState({ page: 1, limit: pageSize, totalItems: 0, totalPages: 0 })
  const [pendingCount, setPendingCount] = useState(0)
  const [contexts, setContexts] = useState<Record<string, DraftContext>>({})
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedDraft, setSelectedDraft] = useState<AiReplyDraft | null>(null)
  const [detailDraft, setDetailDraft] = useState<AiReplyDraft | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [editedText, setEditedText] = useState('')
  const [action, setAction] = useState<'approve' | 'reject' | 'send' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [sendFeedback, setSendFeedback] = useState<SendFeedback | null>(null)
  const [sendLockedDrafts, setSendLockedDrafts] = useState<Record<string, true>>({})
  const [responseModes, setResponseModes] = useState<Record<string, ConversationResponseMode>>({})
  const [desiredMode, setDesiredMode] = useState<ConversationResponseMode | ''>('')
  const [modeLoading, setModeLoading] = useState(false)
  const [modeRefresh, setModeRefresh] = useState(0)
  const [modeSaving, setModeSaving] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)
  const [modeSuccess, setModeSuccess] = useState<string | null>(null)
  const actionInProgress = useRef(false)
  const draftListRequestInFlight = useRef(false)
  const queuedDraftListRefresh = useRef(false)
  const componentMounted = useRef(false)
  const contextsRef = useRef(contexts)
  contextsRef.current = contexts

  useEffect(() => {
    componentMounted.current = true
    return () => { componentMounted.current = false }
  }, [])

  function finishDraftListRequest() {
    draftListRequestInFlight.current = false
    if (queuedDraftListRefresh.current && componentMounted.current) {
      queuedDraftListRefresh.current = false
      setRefreshKey((value) => value + 1)
    }
  }

  const selectedContext = selectedDraft ? contexts[selectedDraft.id] : undefined
  const selectedStatus = detailDraft?.status ?? selectedDraft?.status
  const selectedSendFeedback = selectedDraft && sendFeedback?.draftId === selectedDraft.id ? sendFeedback : null
  const currentMode = selectedDraft ? responseModes[selectedDraft.conversationId] : undefined
  const editorIsEditable = selectedStatus === 'draft_ready'
  const approvedSourceText = detailDraft?.generatedDraft ?? selectedDraft?.generatedDraft ?? ''
  const responseLabel = selectedStatus === 'approved'
    ? detailDraft?.approvalEdited ? 'Owner edited and approved' : 'Approved without edits'
    : selectedStatus === 'rejected'
      ? 'Rejected draft'
      : editorIsEditable && editedText.trim() !== approvedSourceText.trim()
        ? 'Edited by you'
        : 'AI generated'
  const currentPage = Math.max(1, pagination.page)
  const totalPages = Math.max(1, pagination.totalPages)
  const autoRefreshEnabled = Boolean(
    selectedDraft && currentMode === 'ai' && !modeLoading && !modeError && !modeSaving,
  )

  const selectedCustomerLabel = useMemo(() => {
    const customer = selectedContext?.conversation?.customer
    return customer?.profileName?.trim() || customer?.phoneNumber || 'Customer details unavailable'
  }, [selectedContext])

  useEffect(() => {
    let current = true
    if (draftListRequestInFlight.current) {
      queuedDraftListRefresh.current = true
      return () => { current = false }
    }

    draftListRequestInFlight.current = true
    setListLoading(true)
    setListError(null)

    void Promise.all([
      getAiDrafts({ page, limit: pageSize, status }),
      status === 'draft_ready'
        ? Promise.resolve(null)
        : getAiDrafts({ page: 1, limit: 1, status: 'draft_ready' }),
    ])
      .then(async ([list, pending]) => {
        const ids = [...new Set(list.drafts.map((draft) => draft.conversationId))]
        let summaries = new Map<string, InboxConversation>()
        try {
          summaries = await loadConversationSummaries(ids)
        } catch {
          // Keep draft review available even if conversation summaries are temporarily unavailable.
        }

        const contextPairs = await mapWithConcurrency(list.drafts, 4, async (draft) => {
          const context = await loadContextForDraft(draft, summaries)
          return [draft.id, context] as const
        })
        if (!current) return

        const nextContexts = Object.fromEntries(contextPairs)
        setDrafts(list.drafts)
        setPagination(list.pagination)
        setPendingCount(status === 'draft_ready' ? list.pagination.totalItems : pending?.pagination.totalItems ?? 0)
        setContexts(nextContexts)
        setSelectedDraft((existing) => {
          const refreshed = list.drafts.find((draft) => draft.id === existing?.id)
          if (refreshed) return refreshed
          if (existing && existing.status !== 'draft_ready' && status === 'draft_ready') return existing
          return list.drafts[0] ?? null
        })
      })
      .catch((error: unknown) => {
        if (current) setListError(errorMessage(error, 'AI drafts could not be loaded. Please retry.'))
      })
      .finally(() => {
        if (current) setListLoading(false)
        finishDraftListRequest()
      })

    return () => { current = false }
  }, [page, refreshKey, status])

  useEffect(() => {
    let active = true
    let intervalId: number | undefined

    async function refreshDraftListInBackground() {
      if (!active || !autoRefreshEnabled || document.visibilityState === 'hidden' || draftListRequestInFlight.current) return
      draftListRequestInFlight.current = true

      try {
        const [list, pending] = await Promise.all([
          getAiDrafts({ page, limit: pageSize, status }),
          status === 'draft_ready'
            ? Promise.resolve(null)
            : getAiDrafts({ page: 1, limit: 1, status: 'draft_ready' }),
        ])
        if (!active) return

        const missingContexts = list.drafts.filter((draft) => !contextsRef.current[draft.id])
        let newContexts: Record<string, DraftContext> = {}
        if (missingContexts.length > 0) {
          let summaries = new Map<string, InboxConversation>()
          try {
            summaries = await loadConversationSummaries(
              [...new Set(missingContexts.map((draft) => draft.conversationId))],
            )
          } catch {
            // Existing draft information remains usable if summaries are temporarily unavailable.
          }
          const pairs = await mapWithConcurrency(missingContexts, 4, async (draft) => [
            draft.id,
            await loadContextForDraft(draft, summaries),
          ] as const)
          newContexts = Object.fromEntries(pairs)
        }
        if (!active) return

        setDrafts(list.drafts)
        setPagination(list.pagination)
        setPendingCount(status === 'draft_ready' ? list.pagination.totalItems : pending?.pagination.totalItems ?? 0)
        if (Object.keys(newContexts).length > 0) {
          setContexts((current) => ({ ...current, ...newContexts }))
        }
        setSelectedDraft((existing) => {
          if (!existing) return list.drafts[0] ?? null
          return list.drafts.find((draft) => draft.id === existing.id) ?? existing
        })
        setDetailDraft((existing) => {
          if (!existing) return existing
          const refreshed = list.drafts.find((draft) => draft.id === existing.id)
          return refreshed
            ? {
                ...existing,
                status: refreshed.status,
                approvedText: refreshed.approvedText,
                approvalEdited: refreshed.approvalEdited,
                updatedAt: refreshed.updatedAt,
              }
            : existing
        })
        setListError(null)
      } catch (error) {
        if (active) setListError(errorMessage(error, 'AI drafts could not be refreshed. Please retry.'))
      } finally {
        finishDraftListRequest()
      }
    }

    function stopPolling() {
      if (intervalId !== undefined) {
        window.clearInterval(intervalId)
        intervalId = undefined
      }
    }

    function startPolling() {
      stopPolling()
      if (active && autoRefreshEnabled && document.visibilityState !== 'hidden') {
        intervalId = window.setInterval(() => {
          void refreshDraftListInBackground()
        }, 5_000)
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        stopPolling()
      } else if (autoRefreshEnabled) {
        void refreshDraftListInBackground()
        startPolling()
      }
    }

    if (!autoRefreshEnabled) {
      return () => { active = false }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    startPolling()

    return () => {
      active = false
      stopPolling()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [autoRefreshEnabled, page, status])

  useEffect(() => {
    setDesiredMode(selectedDraft ? responseModes[selectedDraft.conversationId] ?? '' : '')
  }, [selectedDraft?.conversationId, responseModes])

  useEffect(() => {
    if (!selectedDraft) {
      setModeLoading(false)
      return
    }

    let current = true
    setModeLoading(true)
    setModeError(null)
    void getConversationResponseMode(selectedDraft.conversationId)
      .then((result) => {
        if (!current) return
        setResponseModes((modes) => ({ ...modes, [result.conversation.id]: result.conversation.responseMode }))
        setDesiredMode(result.conversation.responseMode)
      })
      .catch((error: unknown) => {
        if (current) setModeError(errorMessage(error, 'Conversation response mode could not be loaded.'))
      })
      .finally(() => {
        if (current) setModeLoading(false)
      })

    return () => { current = false }
  }, [selectedDraft?.conversationId, modeRefresh])

  useEffect(() => {
    if (!selectedDraft) {
      setDetailDraft(null)
      setEditedText('')
      setDesiredMode('')
      setActionError(null)
      setActionSuccess(null)
      setModeError(null)
      setModeSuccess(null)
      return
    }

    let current = true
    setDetailLoading(true)
    setActionError(null)
    setActionSuccess(null)
    setModeError(null)
    setModeSuccess(null)

    void getAiDraft(selectedDraft.id)
      .then((response) => {
        if (!current) return
        setDetailDraft(response.draft)
        setEditedText(response.draft.approvedText ?? response.draft.generatedDraft ?? '')
      })
      .catch((error: unknown) => {
        if (current) setActionError(errorMessage(error, 'Draft details could not be loaded.'))
      })
      .finally(() => {
        if (current) setDetailLoading(false)
      })

    return () => { current = false }
  }, [selectedDraft?.id])

  async function handleApprove() {
    if (!selectedDraft || selectedStatus !== 'draft_ready' || actionInProgress.current) return
    if (!selectedContext?.sourceMessage) {
      setActionError('The source customer message is unavailable. Refresh the draft context before approving.')
      return
    }
    const text = editedText.trim()
    if (!text) {
      setActionError('Write a response before approving this draft.')
      return
    }

    actionInProgress.current = true
    setAction('approve')
    setActionError(null)
    setActionSuccess(null)
    try {
      const result = await approveAiDraft(selectedDraft.id, text)
      const approvedDraft: AiReplyDraft = {
        ...(detailDraft ?? selectedDraft),
        status: result.draft.status,
        approvedText: result.draft.approvedText,
        approvalEdited: result.draft.approvedText !== (selectedDraft.generatedDraft?.trim() ?? ''),
      }
      setDetailDraft(approvedDraft)
      setSelectedDraft(approvedDraft)
      setActionSuccess('Approved for review. This action did not send a WhatsApp message.')
      setRefreshKey((value) => value + 1)
    } catch (error) {
      setActionError(errorMessage(error, 'This draft could not be approved. It may be stale or no longer awaiting review.'))
      if (error instanceof ApiError && error.status === 409) setRefreshKey((value) => value + 1)
    } finally {
      actionInProgress.current = false
      setAction(null)
    }
  }

  async function handleReject() {
    if (!selectedDraft || selectedStatus !== 'draft_ready' || actionInProgress.current) return
    if (!window.confirm('Reject this AI draft? Rejection records the decision and does not send a message.')) return

    actionInProgress.current = true
    setAction('reject')
    setActionError(null)
    setActionSuccess(null)
    try {
      const result = await rejectAiDraft(selectedDraft.id)
      const rejectedDraft: AiReplyDraft = {
        ...(detailDraft ?? selectedDraft),
        status: result.draft.status,
      }
      setDetailDraft(rejectedDraft)
      setSelectedDraft(rejectedDraft)
      setActionSuccess('Draft rejected. No WhatsApp message was sent.')
      setRefreshKey((value) => value + 1)
    } catch (error) {
      setActionError(errorMessage(error, 'This draft could not be rejected. It may no longer be awaiting review.'))
      if (error instanceof ApiError && error.status === 409) setRefreshKey((value) => value + 1)
    } finally {
      actionInProgress.current = false
      setAction(null)
    }
  }

  async function handleSendApproved() {
    if (!selectedDraft || selectedStatus !== 'approved' || actionInProgress.current || sendLockedDrafts[selectedDraft.id]) return
    const confirmed = window.confirm(
      `Send the approved response to ${selectedCustomerLabel} through WhatsApp? This sends the approved text as-is. It cannot be edited in this action.`,
    )
    if (!confirmed) return

    actionInProgress.current = true
    setAction('send')
    setActionError(null)
    setActionSuccess(null)
    setSendFeedback(null)
    try {
      const result = await sendApprovedAiDraft(selectedDraft.id)
      const kind = result.draft.status === 'outcome_uncertain'
        ? 'uncertain'
        : result.draft.alreadySent === true
          ? 'already_sent'
          : 'sent'
      const message = kind === 'sent'
        ? 'Sent successfully through WhatsApp.'
        : kind === 'already_sent'
          ? 'This approved reply was already sent. No additional message was sent.'
          : 'The send outcome is uncertain. Check the WhatsApp conversation before doing anything else. Do not retry this send.'
      const nextStatus: AiReplyDraftStatus = kind === 'uncertain' ? 'send_uncertain' : 'sent'
      const updatedDraft = { ...(detailDraft ?? selectedDraft), status: nextStatus }
      setDetailDraft(updatedDraft)
      setSelectedDraft(updatedDraft)
      setSendFeedback({ draftId: selectedDraft.id, kind, message })
      if (kind === 'uncertain') setSendLockedDrafts((current) => ({ ...current, [selectedDraft.id]: true }))
      setRefreshKey((value) => value + 1)
    } catch (error) {
      const isDefinitiveRejection = error instanceof ApiError &&
        error.status === 502 && error.message === 'WhatsApp did not accept the approved message.'
      const isPotentiallyAmbiguous = !(error instanceof ApiError) || error.status === undefined || error.status >= 500
      if (isDefinitiveRejection) {
        const failedDraft = { ...(detailDraft ?? selectedDraft), status: 'send_failed' as const }
        setDetailDraft(failedDraft)
        setSelectedDraft(failedDraft)
        setSendFeedback({ draftId: selectedDraft.id, kind: 'definitive_failure', message: 'WhatsApp definitively rejected this message. It was not recorded as sent.' })
        setRefreshKey((value) => value + 1)
      } else if (isPotentiallyAmbiguous) {
        const uncertainDraft = { ...(detailDraft ?? selectedDraft), status: 'send_uncertain' as const }
        setDetailDraft(uncertainDraft)
        setSelectedDraft(uncertainDraft)
        setSendLockedDrafts((current) => ({ ...current, [selectedDraft.id]: true }))
        setSendFeedback({ draftId: selectedDraft.id, kind: 'uncertain', message: 'The send outcome could not be confirmed. Check the WhatsApp conversation before doing anything else. Do not retry this send.' })
      } else {
        setActionError(errorMessage(error, 'The approved reply could not be sent. The approved draft remains unchanged.'))
      }
    } finally {
      actionInProgress.current = false
      setAction(null)
    }
  }

  async function handleSetMode() {
    if (!selectedDraft || !desiredMode || modeSaving) return
    const prompt = desiredMode === 'ai'
      ? 'Set this conversation to AI mode? AI may generate drafts, but it will not send messages automatically.'
      : 'Set this conversation to Human mode? New AI draft generation for this conversation will be paused.'
    if (!window.confirm(prompt)) return

    setModeSaving(true)
    setModeError(null)
    setModeSuccess(null)
    try {
      const result = await updateConversationResponseMode(selectedDraft.conversationId, desiredMode)
      setResponseModes((current) => ({ ...current, [result.conversation.id]: result.conversation.responseMode }))
      setDesiredMode(result.conversation.responseMode)
      setModeSuccess(result.message)
    } catch (error) {
      setModeError(errorMessage(error, 'Conversation response mode could not be changed.'))
    } finally {
      setModeSaving(false)
    }
  }

  function selectDraft(draft: AiReplyDraft) {
    if (actionInProgress.current || modeSaving) return
    setSelectedDraft(draft)
    setDetailDraft(null)
    setEditedText(draft.approvedText ?? draft.generatedDraft ?? '')
    setActionError(null)
    setActionSuccess(null)
  }

  function changeStatus(nextStatus: typeof status) {
    setStatus(nextStatus)
    setPage(1)
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 rounded-2xl border border-emerald-100 bg-gradient-to-br from-white to-emerald-50/60 p-5 shadow-sm sm:flex-row sm:items-end sm:justify-between sm:p-7">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">Owner review</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">AI Drafts</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Review each suggested reply and decide whether it is suitable for your customer.
          </p>
        </div>
        <div className="rounded-xl border border-emerald-100 bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-medium text-slate-500">Pending review</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-950" aria-live="polite">{pendingCount}</p>
        </div>
      </section>

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
        AI suggestions require your review. Approval records your decision only; this page does not send WhatsApp messages. AI mode also does not enable automatic sending.
      </div>

      <section className="grid gap-5 lg:grid-cols-[minmax(18rem,0.82fr)_minmax(0,1.18fr)]">
        <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-950">Draft queue</h3>
                <p className="mt-1 text-xs text-slate-500">{pagination.totalItems} {pagination.totalItems === 1 ? 'draft' : 'drafts'}</p>
              </div>
              <button type="button" onClick={() => setRefreshKey((value) => value + 1)} disabled={listLoading} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-50">
                Refresh
              </button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter drafts by status">
              {reviewStatuses.map((option) => (
                <button key={option.value} type="button" aria-pressed={status === option.value} onClick={() => changeStatus(option.value)} className={`rounded-full px-3 py-1.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 ${status === option.value ? 'bg-emerald-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {listError && drafts.length > 0 && (
            <div className="border-b border-rose-100 bg-rose-50 p-4" role="alert">
              <p className="text-sm font-semibold text-rose-700">Drafts could not be refreshed</p>
              <p className="mt-1 text-sm leading-6 text-rose-800">{listError} Previously loaded drafts are still shown.</p>
              <button type="button" onClick={() => setRefreshKey((value) => value + 1)} className="mt-3 rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-800 outline-none hover:bg-rose-100 focus-visible:ring-2 focus-visible:ring-rose-600">Retry</button>
            </div>
          )}

          {listError && drafts.length === 0 ? (
            <div className="p-6" role="alert">
              <p className="text-sm font-semibold text-rose-700">Drafts could not be loaded</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">{listError}</p>
              <button type="button" onClick={() => setRefreshKey((value) => value + 1)} className="mt-4 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2">Retry</button>
            </div>
          ) : listLoading && drafts.length === 0 ? (
            <div className="flex min-h-56 items-center justify-center p-6" role="status" aria-live="polite">
              <span className="mr-3 h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-emerald-700" />
              <span className="text-sm text-slate-600">Loading drafts and conversation context…</span>
            </div>
          ) : drafts.length === 0 ? (
            <div className="p-7 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-lg text-slate-500" aria-hidden="true">✦</div>
              <h4 className="mt-4 font-semibold text-slate-900">No {status === 'draft_ready' ? 'drafts need review' : `${statusLabel(status).toLowerCase()} drafts`}</h4>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-600">When drafts are available for this status, they will appear here.</p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-slate-100">
                {drafts.map((draft) => {
                  const context = contexts[draft.id]
                  const customer = context?.conversation?.customer
                  const customerLabel = customer?.profileName?.trim() || customer?.phoneNumber || 'Customer details unavailable'
                  const active = selectedDraft?.id === draft.id
                  return (
                    <li key={draft.id}>
                      <button type="button" onClick={() => selectDraft(draft)} disabled={action !== null || modeSaving} aria-current={active ? 'true' : undefined} className={`block w-full p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600 disabled:cursor-wait sm:p-5 ${active ? 'bg-emerald-50/70' : 'hover:bg-slate-50'}`}>
                        <span className="flex items-start justify-between gap-3">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-slate-900">{customerLabel}</span>
                            {customer?.phoneNumber && customer?.profileName && <span className="mt-0.5 block text-xs text-slate-500">{customer.phoneNumber}</span>}
                          </span>
                          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${statusClasses(draft.status)}`}>{statusLabel(draft.status)}</span>
                        </span>
                        <span className="mt-3 block line-clamp-2 text-xs leading-5 text-slate-600">
                          {context?.sourceMessage?.text ?? context?.error ?? 'Customer message is not available from the current conversation history.'}
                        </span>
                        <span className="mt-3 block line-clamp-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-700">
                          {draft.generatedDraft ?? 'No generated response is available.'}
                        </span>
                        <span className="mt-3 block text-[11px] text-slate-400">Created {formatDate(draft.createdAt)}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 sm:px-5">
                <p className="text-xs text-slate-500">Page {currentPage} of {totalPages}</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || listLoading} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-40">Previous</button>
                  <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages || listLoading} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-40">Next</button>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="min-w-0 rounded-2xl border border-slate-200 bg-white shadow-sm">
          {!selectedDraft ? (
            <div className="flex min-h-80 flex-col items-center justify-center p-8 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-xl text-emerald-700" aria-hidden="true">✦</span>
              <h3 className="mt-4 font-semibold text-slate-900">Select a draft to review</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-600">The conversation and suggested reply will appear here for your review.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              <div className="flex flex-wrap items-start justify-between gap-3 p-5 sm:p-6">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Customer conversation</p>
                  <h3 className="mt-2 truncate text-lg font-semibold text-slate-950">{selectedCustomerLabel}</h3>
                  {selectedContext?.conversation?.customer?.phoneNumber && <p className="mt-1 text-sm text-slate-500">{selectedContext.conversation.customer.phoneNumber}</p>}
                </div>
                <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset ${statusClasses(selectedStatus ?? selectedDraft.status)}`}>{statusLabel(selectedStatus ?? selectedDraft.status)}</span>
              </div>

              <div className="space-y-5 p-5 sm:p-6">
                <section>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-slate-900">Customer message</h4>
                    <span className="text-xs text-slate-400">Inbound</span>
                  </div>
                  <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
                    {selectedContext?.sourceMessage?.text ?? 'The source message is not available in the current conversation history.'}
                  </div>
                  <p className="mt-2 text-xs leading-5 text-slate-500">This is the exact inbound message linked to this draft.</p>
                  {selectedContext?.error && <p role="alert" className="mt-2 text-xs text-rose-700">{selectedContext.error} Refresh the draft queue to retry.</p>}
                </section>

                {selectedContext?.recentMessages && selectedContext.recentMessages.length > 1 && (
                  <details className="rounded-xl border border-slate-200">
                    <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700 outline-none focus-visible:ring-2 focus-visible:ring-emerald-600">Recent conversation context</summary>
                    <ol className="space-y-3 border-t border-slate-100 p-4">
                      {selectedContext.recentMessages.slice(0, -1).map((message) => (
                        <li key={message.id} className="rounded-lg bg-slate-50 p-3">
                          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                            <span>{message.direction === 'inbound' ? 'Customer' : 'Business owner'}</span>
                            <time dateTime={message.timestamp ?? message.createdAt}>{formatDate(message.timestamp ?? message.createdAt)}</time>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-slate-700">{message.text}</p>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}

                <section>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="ai-draft-response" className="text-sm font-semibold text-slate-900">Suggested response</label>
                    <span className="text-xs text-slate-500">{responseLabel}</span>
                  </div>
                  <textarea id="ai-draft-response" value={editedText} onChange={(event) => setEditedText(event.target.value)} readOnly={!editorIsEditable} maxLength={4096} rows={7} className="mt-2 w-full resize-y rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm leading-6 text-slate-800 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 read-only:bg-slate-50" aria-describedby="draft-text-help" />
                  <div className="mt-2 flex items-start justify-between gap-3">
                    <p id="draft-text-help" className="text-xs leading-5 text-slate-500">{editorIsEditable ? 'Review and edit this response before approving.' : 'This draft is no longer editable.'}</p>
                    <span className="shrink-0 text-xs tabular-nums text-slate-400">{editedText.length}/4096</span>
                  </div>
                </section>

                {detailLoading && <p role="status" className="text-xs text-slate-500">Refreshing draft details…</p>}
                {actionError && <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800">{actionError}</div>}
                {actionSuccess && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">{actionSuccess}</div>}

                {selectedSendFeedback && (
                  <div role={selectedSendFeedback.kind === 'uncertain' ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm leading-6 ${selectedSendFeedback.kind === 'uncertain' ? 'border-orange-300 bg-orange-50 font-semibold text-orange-950' : selectedSendFeedback.kind === 'definitive_failure' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>
                    {selectedSendFeedback.message}
                  </div>
                )}

                {editorIsEditable && (
                  <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                    <button type="button" onClick={() => void handleReject()} disabled={action !== null || detailLoading} className="rounded-xl border border-rose-200 px-4 py-3 text-sm font-semibold text-rose-700 outline-none hover:bg-rose-50 focus-visible:ring-2 focus-visible:ring-rose-500 disabled:cursor-not-allowed disabled:opacity-50">{action === 'reject' ? 'Rejecting…' : 'Reject draft'}</button>
                    <button type="button" onClick={() => void handleApprove()} disabled={action !== null || detailLoading || !editedText.trim() || !selectedContext?.sourceMessage} className="rounded-xl bg-emerald-700 px-5 py-3 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">{action === 'approve' ? 'Approving…' : 'Approve edited response'}</button>
                  </div>
                )}

                {selectedStatus === 'approved' && !sendLockedDrafts[selectedDraft.id] && (
                  <div className="flex flex-col gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm leading-6 text-emerald-950">Sending will deliver the approved text to this customer through WhatsApp.</p>
                    <button type="button" onClick={() => void handleSendApproved()} disabled={action !== null || detailLoading} className="shrink-0 rounded-xl bg-emerald-700 px-5 py-3 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">{action === 'send' ? 'Sending…' : 'Send approved reply'}</button>
                  </div>
                )}
              </div>

              <section className="space-y-3 bg-slate-50/70 p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900">Conversation response mode</h4>
                    <p className="mt-1 text-xs text-slate-500">Draft created {formatDate(selectedDraft.createdAt)}</p>
                  </div>
                  {modeLoading ? (
                    <span role="status" className="text-xs text-slate-500">Loading mode…</span>
                  ) : currentMode ? (
                    <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${currentMode === 'ai' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'}`}>{currentMode === 'ai' ? 'AI mode' : 'Human mode'}</span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900">Mode unavailable</span>
                  )}
                </div>
                <p className="text-xs leading-5 text-slate-600">AI mode allows draft generation only. It does not send messages automatically.</p>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <label className="sr-only" htmlFor="response-mode">Choose conversation response mode</label>
                  <select id="response-mode" value={desiredMode} onChange={(event) => setDesiredMode(event.target.value as ConversationResponseMode | '')} disabled={modeLoading} className="min-h-11 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 disabled:opacity-60">
                    <option value="">Choose a mode</option>
                    <option value="human">Human mode</option>
                    <option value="ai">AI draft mode</option>
                  </select>
                  <button type="button" onClick={() => void handleSetMode()} disabled={!desiredMode || modeLoading || modeSaving} className="rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-50">{modeSaving ? 'Saving mode…' : 'Set response mode'}</button>
                  <button type="button" onClick={() => setModeRefresh((value) => value + 1)} disabled={modeLoading || modeSaving} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-600 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-50">Refresh mode</button>
                </div>
                {modeError && <p role="alert" className="text-sm text-rose-700">{modeError}</p>}
                {modeSuccess && <p role="status" className="text-sm text-emerald-800">{modeSuccess}</p>}
              </section>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
