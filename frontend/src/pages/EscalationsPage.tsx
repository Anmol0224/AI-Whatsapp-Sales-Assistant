import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ApiError,
  getAiEscalation,
  getAiEscalations,
  getConversationMessages,
  resolveAiEscalation,
  type AiEscalationCounts,
  type AiReplyEscalation,
  type AiReplyEscalationCategory,
  type AiReplyEscalationDetail,
  type AiReplyEscalationReasonCode,
  type AiReplyEscalationResolutionOutcome,
  type AiReplyEscalationStatus,
  type AiReplyEscalationStatusFilter,
  type InboxMessage,
} from '../services/api'

const pageSize = 20
const historyPageSize = 50
const maximumNoteLength = 500

const statusFilters: { value: AiReplyEscalationStatusFilter; label: string }[] = [
  { value: 'open', label: 'Pending' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'All' },
]

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Time unavailable'
}

function statusLabel(status: AiReplyEscalationStatus): string {
  if (status === 'open') return 'Pending review'
  if (status === 'resolved') return 'Resolved'
  return 'Dismissed'
}

function statusClasses(status: AiReplyEscalationStatus): string {
  if (status === 'open') return 'bg-amber-50 text-amber-800 ring-amber-200'
  if (status === 'resolved') return 'bg-emerald-50 text-emerald-800 ring-emerald-200'
  return 'bg-slate-100 text-slate-700 ring-slate-200'
}

function categoryLabel(category: AiReplyEscalationCategory): string {
  const labels: Record<AiReplyEscalationCategory, string> = {
    needs_owner_review: 'Needs owner review',
    unsupported_information: 'Unsupported information',
    ambiguous_request: 'Ambiguous request',
    missing_business_information: 'Missing business information',
    policy_conflict: 'Policy or control change',
    invalid_or_empty_response: 'Invalid or unavailable response',
  }
  return labels[category]
}

function reasonDescription(reasonCode: AiReplyEscalationReasonCode): { title: string; summary: string } {
  const descriptions: Record<AiReplyEscalationReasonCode, { title: string; summary: string }> = {
    automatic_replies_disabled: {
      title: 'Automatic replies disabled',
      summary: 'Platform or business automatic replies were not enabled when this reply was checked.',
    },
    source_message_unavailable: {
      title: 'Source message unavailable',
      summary: 'The inbound customer message could not be verified for automatic reply.',
    },
    conversation_mode_mismatch: {
      title: 'Conversation mode changed',
      summary: 'The conversation was no longer in AI Automatic mode when the reply was evaluated.',
    },
    stale_control_version: {
      title: 'Conversation control changed',
      summary: 'The conversation response mode or control state changed before sending.',
    },
    stale_policy_version: {
      title: 'Business policy version changed',
      summary: 'The business automatic-reply settings changed while this reply was being processed.',
    },
    business_evidence_unavailable: {
      title: 'Business information unavailable',
      summary: 'Active FAQs or catalog records could not be loaded safely for verification.',
    },
    evidence_incomplete: {
      title: 'No matching FAQ or catalog record',
      summary: 'The customer request did not match an active FAQ or supported catalog query.',
    },
    faq_not_exact: {
      title: 'No exact FAQ match',
      summary: 'The customer question did not exactly match an active FAQ entry.',
    },
    faq_answers_conflict: {
      title: 'Conflicting FAQ answers',
      summary: 'Multiple active FAQs matched this question with different answers.',
    },
    catalog_intent_unsupported: {
      title: 'Unsupported catalog question',
      summary: 'The customer asked a catalog question that requires human judgment.',
    },
    catalog_item_missing: {
      title: 'Catalog item not found',
      summary: 'The requested product or service was not found in your active catalog.',
    },
    catalog_item_ambiguous: {
      title: 'Multiple matching catalog items',
      summary: 'More than one active catalog item matched the customer request.',
    },
    catalog_price_missing: {
      title: 'Catalog price not set',
      summary: 'The matching catalog item does not have a configured price.',
    },
    faq_exact_answer: {
      title: 'FAQ verification check',
      summary: 'This reply was held during FAQ safety verification.',
    },
    catalog_price_response: {
      title: 'Catalog price verification check',
      summary: 'This reply was held during catalog price verification.',
    },
    catalog_listing_response: {
      title: 'Catalog listing verification check',
      summary: 'This reply was held during catalog listing verification.',
    },
    generated_response_mismatch: {
      title: 'Generated reply did not match verified facts',
      summary: 'The candidate reply differed from the deterministic business answer and was blocked.',
    },
    generated_response_invalid: {
      title: 'Generated reply failed validation',
      summary: 'The candidate reply was empty or did not pass safety formatting checks.',
    },
    provider_generation_failed: {
      title: 'AI generation failed',
      summary: 'The AI provider could not generate a reply for this message.',
    },
    validation_failed: {
      title: 'Safety validation held this reply',
      summary: 'Automatic safety validation escalated this message for owner review.',
    },
  }
  return descriptions[reasonCode]
}

function customerLabel(escalation: AiReplyEscalation | null): string {
  const customer = escalation?.conversation?.customer
  return customer?.profileName?.trim() || customer?.phoneNumber || 'Customer details unavailable'
}

export function EscalationsPage({
  onOpenConversation,
}: {
  onOpenConversation?: (conversationId: string) => void
}) {
  const [statusFilter, setStatusFilter] = useState<AiReplyEscalationStatusFilter>('open')
  const [page, setPage] = useState(1)
  const [refreshKey, setRefreshKey] = useState(0)
  const [escalations, setEscalations] = useState<AiReplyEscalation[]>([])
  const [counts, setCounts] = useState<AiEscalationCounts>({ pending: 0, resolved: 0, dismissed: 0, total: 0 })
  const [pagination, setPagination] = useState({ page: 1, limit: pageSize, totalItems: 0, totalPages: 0 })
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [selectedEscalation, setSelectedEscalation] = useState<AiReplyEscalation | null>(null)
  const [detail, setDetail] = useState<AiReplyEscalationDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [recentMessages, setRecentMessages] = useState<InboxMessage[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [resolutionNote, setResolutionNote] = useState('')
  const [resolvingOutcome, setResolvingOutcome] = useState<AiReplyEscalationResolutionOutcome | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const actionInProgress = useRef(false)

  const activeEscalation = detail ?? selectedEscalation
  const activeStatus = activeEscalation?.status
  const isOpen = activeStatus === 'open'
  const currentPage = Math.max(1, pagination.page)
  const totalPages = Math.max(1, pagination.totalPages)

  const selectedCustomerName = useMemo(() => customerLabel(activeEscalation), [activeEscalation])

  useEffect(() => {
    let current = true
    setListLoading(true)
    setListError(null)

    void getAiEscalations({ page, limit: pageSize, status: statusFilter })
      .then((response) => {
        if (!current) return
        setEscalations(response.escalations)
        setCounts(response.counts)
        setPagination(response.pagination)
        setSelectedEscalation((existing) => {
          const refreshed = response.escalations.find((item) => item.id === existing?.id)
          if (refreshed) return refreshed
          if (existing && existing.status !== 'open' && statusFilter === 'open') return existing
          return response.escalations[0] ?? null
        })
      })
      .catch((error: unknown) => {
        if (current) setListError(errorMessage(error, 'Escalations could not be loaded. Please retry.'))
      })
      .finally(() => {
        if (current) setListLoading(false)
      })

    return () => { current = false }
  }, [page, refreshKey, statusFilter])

  useEffect(() => {
    const escalationId = selectedEscalation?.id
    const conversationId = selectedEscalation?.conversationId
    if (!escalationId || !conversationId) {
      setDetail(null)
      setDetailError(null)
      setRecentMessages([])
      setHistoryError(null)
      setResolutionNote('')
      return
    }

    let current = true
    setDetailLoading(true)
    setDetailError(null)
    setHistoryLoading(true)
    setHistoryError(null)
    setResolutionNote(selectedEscalation.resolutionNote ?? '')

    void getAiEscalation(escalationId)
      .then((response) => {
        if (!current) return
        setDetail(response.escalation)
        setResolutionNote(response.escalation.resolutionNote ?? '')
      })
      .catch((error: unknown) => {
        if (current) setDetailError(errorMessage(error, 'Escalation details could not be loaded.'))
      })
      .finally(() => {
        if (current) setDetailLoading(false)
      })

    void getConversationMessages(conversationId, { page: 1, limit: historyPageSize })
      .then((response) => {
        if (!current) return
        setRecentMessages(response.messages.slice(-10))
      })
      .catch(() => {
        if (current) {
          setRecentMessages([])
          setHistoryError('Conversation history could not be loaded.')
        }
      })
      .finally(() => {
        if (current) setHistoryLoading(false)
      })

    return () => { current = false }
  }, [selectedEscalation?.id, selectedEscalation?.conversationId])

  async function handleResolve(outcome: AiReplyEscalationResolutionOutcome) {
    if (!activeEscalation || activeEscalation.status !== 'open' || actionInProgress.current) return
    const trimmedNote = resolutionNote.trim()
    if (trimmedNote.length > maximumNoteLength) {
      setActionError(`Resolution notes must be ${maximumNoteLength} characters or fewer.`)
      return
    }

    const confirmText = outcome === 'dismissed'
      ? `Dismiss this escalation for ${selectedCustomerName}? This records your decision only and does not send a WhatsApp message.`
      : `Mark this escalation for ${selectedCustomerName} as resolved? This records your decision only and does not send a WhatsApp message.`
    if (!window.confirm(confirmText)) return

    actionInProgress.current = true
    setResolvingOutcome(outcome)
    setActionError(null)
    setActionSuccess(null)
    try {
      const response = await resolveAiEscalation(activeEscalation.id, {
        outcome,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      })
      const updatedFields = {
        status: response.escalation.status,
        resolvedAt: response.escalation.resolvedAt,
        ...(response.escalation.resolutionNote !== undefined
          ? { resolutionNote: response.escalation.resolutionNote }
          : {}),
      }
      setSelectedEscalation((existing) => existing ? { ...existing, ...updatedFields } : existing)
      setDetail((existing) => existing ? { ...existing, ...updatedFields } : existing)
      setActionSuccess(response.message)
      setRefreshKey((value) => value + 1)
    } catch (error) {
      setActionError(errorMessage(error, 'This escalation could not be updated. Please refresh and try again.'))
      if (error instanceof ApiError && error.status === 409) {
        setRefreshKey((value) => value + 1)
      }
    } finally {
      actionInProgress.current = false
      setResolvingOutcome(null)
    }
  }

  function selectEscalation(escalation: AiReplyEscalation) {
    if (actionInProgress.current) return
    setSelectedEscalation(escalation)
    setDetail(null)
    setActionError(null)
    setActionSuccess(null)
  }

  function changeStatusFilter(next: AiReplyEscalationStatusFilter) {
    if (actionInProgress.current) return
    setStatusFilter(next)
    setPage(1)
    setActionError(null)
    setActionSuccess(null)
  }

  const activeReason = activeEscalation ? reasonDescription(activeEscalation.reasonCode) : null

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 rounded-2xl border border-emerald-100 bg-gradient-to-br from-white to-emerald-50/60 p-5 shadow-sm sm:flex-row sm:items-end sm:justify-between sm:p-7">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">Automatic reply safety</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">Escalations</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Inspect customer messages that automatic reply validation held for your review, then record how you handled them.
          </p>
        </div>

        <dl className="grid grid-cols-3 gap-2.5 sm:gap-3" aria-label="Escalation summary counts">
          <div className="rounded-xl border border-amber-200/80 bg-white px-3.5 py-2.5 shadow-sm sm:px-4 sm:py-3">
            <dt className="text-xs font-medium text-slate-500">Pending</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-amber-900 sm:text-2xl" aria-live="polite">
              {counts.pending}
            </dd>
          </div>
          <div className="rounded-xl border border-emerald-100 bg-white px-3.5 py-2.5 shadow-sm sm:px-4 sm:py-3">
            <dt className="text-xs font-medium text-slate-500">Resolved</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-emerald-900 sm:text-2xl" aria-live="polite">
              {counts.resolved}
            </dd>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-sm sm:px-4 sm:py-3">
            <dt className="text-xs font-medium text-slate-500">Dismissed</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-slate-800 sm:text-2xl" aria-live="polite">
              {counts.dismissed}
            </dd>
          </div>
        </dl>
      </section>

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
        Resolving or dismissing an escalation records your review decision only. It never sends a WhatsApp message automatically. Use the Inbox to reply to the customer when needed.
      </div>

      <section className="grid gap-5 lg:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.15fr)]">
        <div className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-950">Escalation queue</h3>
                <p className="mt-1 text-xs text-slate-500">
                  {pagination.totalItems} {pagination.totalItems === 1 ? 'escalation' : 'escalations'} in this view
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRefreshKey((value) => value + 1)}
                disabled={listLoading || resolvingOutcome !== null}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter escalations by status">
              {statusFilters.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={statusFilter === option.value}
                  disabled={resolvingOutcome !== null}
                  onClick={() => changeStatusFilter(option.value)}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-50 ${
                    statusFilter === option.value
                      ? 'bg-emerald-700 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {listError && escalations.length > 0 && (
            <div className="border-b border-rose-100 bg-rose-50 p-4" role="alert">
              <p className="text-sm font-semibold text-rose-700">Escalations could not be refreshed</p>
              <p className="mt-1 text-sm leading-6 text-rose-800">{listError}</p>
              <button
                type="button"
                onClick={() => setRefreshKey((value) => value + 1)}
                className="mt-3 rounded-lg border border-rose-200 bg-white px-3 py-2 text-xs font-semibold text-rose-800 outline-none hover:bg-rose-100 focus-visible:ring-2 focus-visible:ring-rose-600"
              >
                Retry
              </button>
            </div>
          )}

          {listError && escalations.length === 0 ? (
            <div className="p-6" role="alert">
              <p className="text-sm font-semibold text-rose-700">Escalations could not be loaded</p>
              <p className="mt-2 text-sm leading-6 text-slate-600">{listError}</p>
              <button
                type="button"
                onClick={() => setRefreshKey((value) => value + 1)}
                className="mt-4 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
              >
                Retry
              </button>
            </div>
          ) : listLoading && escalations.length === 0 ? (
            <div className="flex min-h-56 items-center justify-center p-6" role="status" aria-live="polite">
              <span className="mr-3 h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-emerald-700" />
              <span className="text-sm text-slate-600">Loading escalations…</span>
            </div>
          ) : escalations.length === 0 ? (
            <div className="p-7 text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-xs font-bold text-slate-500" aria-hidden="true">
                ES
              </div>
              <h4 className="mt-4 font-semibold text-slate-900">
                {statusFilter === 'open'
                  ? 'No pending escalations'
                  : statusFilter === 'resolved'
                    ? 'No resolved escalations'
                    : statusFilter === 'dismissed'
                      ? 'No dismissed escalations'
                      : 'No escalations recorded'}
              </h4>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-600">
                When an automatic reply requires owner attention, it will appear here.
              </p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-slate-100">
                {escalations.map((escalation) => {
                  const customer = escalation.conversation?.customer
                  const name = customerLabel(escalation)
                  const reason = reasonDescription(escalation.reasonCode)
                  const active = selectedEscalation?.id === escalation.id
                  return (
                    <li key={escalation.id}>
                      <button
                        type="button"
                        onClick={() => selectEscalation(escalation)}
                        disabled={resolvingOutcome !== null}
                        aria-current={active ? 'true' : undefined}
                        className={`block w-full p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600 disabled:cursor-wait sm:p-5 ${
                          active ? 'bg-emerald-50/70' : 'hover:bg-slate-50'
                        }`}
                      >
                        <span className="flex items-start justify-between gap-3">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-slate-900">{name}</span>
                            {customer?.phoneNumber && customer?.profileName && (
                              <span className="mt-0.5 block text-xs text-slate-500">{customer.phoneNumber}</span>
                            )}
                          </span>
                          <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${statusClasses(escalation.status)}`}>
                            {statusLabel(escalation.status)}
                          </span>
                        </span>

                        <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                            {categoryLabel(escalation.category)}
                          </span>
                          <span className="text-xs font-medium text-slate-700">· {reason.title}</span>
                        </span>

                        <span className="mt-2.5 block line-clamp-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-700">
                          {escalation.inboundMessage?.text ?? 'Inbound customer message is unavailable.'}
                        </span>

                        <span className="mt-2.5 block text-[11px] text-slate-400">
                          Escalated {formatDate(escalation.createdAt)}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 sm:px-5">
                <p className="text-xs text-slate-500">Page {currentPage} of {totalPages}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    disabled={page <= 1 || listLoading || resolvingOutcome !== null}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
                    disabled={page >= totalPages || listLoading || resolvingOutcome !== null}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="min-w-0 rounded-2xl border border-slate-200 bg-white shadow-sm">
          {!activeEscalation ? (
            <div className="flex min-h-80 flex-col items-center justify-center p-8 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-sm font-bold text-emerald-700" aria-hidden="true">
                ES
              </span>
              <h3 className="mt-4 font-semibold text-slate-900">Select an escalation to inspect</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-600">
                The escalation reason, customer message, conversation context, and resolution controls will appear here.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              <div className="flex flex-wrap items-start justify-between gap-3 p-5 sm:p-6">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Escalated conversation</p>
                  <h3 className="mt-2 truncate text-lg font-semibold text-slate-950">{selectedCustomerName}</h3>
                  {activeEscalation.conversation?.customer?.phoneNumber && (
                    <p className="mt-1 text-sm text-slate-500">{activeEscalation.conversation.customer.phoneNumber}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 ring-inset ${statusClasses(activeEscalation.status)}`}>
                    {statusLabel(activeEscalation.status)}
                  </span>
                  {onOpenConversation && (
                    <button
                      type="button"
                      onClick={() => onOpenConversation(activeEscalation.conversationId)}
                      disabled={resolvingOutcome !== null}
                      className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs font-semibold text-emerald-800 outline-none hover:bg-emerald-100 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-50"
                    >
                      Open in Inbox
                    </button>
                  )}
                </div>
              </div>

              <div className="space-y-5 p-5 sm:p-6">
                <section aria-labelledby="escalation-reason-heading" className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 id="escalation-reason-heading" className="text-sm font-semibold text-slate-900">
                      {activeReason?.title ?? 'Escalation reason'}
                    </h4>
                    <span className="rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 ring-1 ring-slate-200">
                      {categoryLabel(activeEscalation.category)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-700">{activeReason?.summary}</p>
                  <dl className="mt-3 grid gap-2 border-t border-slate-200/80 pt-3 text-xs text-slate-600 sm:grid-cols-2">
                    <div>
                      <dt className="font-medium text-slate-500">Reason code</dt>
                      <dd className="mt-0.5 font-mono text-slate-800">{activeEscalation.reasonCode}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-slate-500">Created</dt>
                      <dd className="mt-0.5 text-slate-800">{formatDate(activeEscalation.createdAt)}</dd>
                    </div>
                    {(activeEscalation.policyVersion || activeEscalation.expectedPolicyVersion) && (
                      <div>
                        <dt className="font-medium text-slate-500">Policy version</dt>
                        <dd className="mt-0.5 font-mono text-slate-800">
                          {activeEscalation.policyVersion ?? '—'}
                          {activeEscalation.expectedPolicyVersion && activeEscalation.expectedPolicyVersion !== activeEscalation.policyVersion
                            ? ` (expected ${activeEscalation.expectedPolicyVersion})`
                            : ''}
                        </dd>
                      </div>
                    )}
                    {(activeEscalation.controlVersion !== undefined || activeEscalation.expectedControlVersion !== undefined) && (
                      <div>
                        <dt className="font-medium text-slate-500">Conversation control version</dt>
                        <dd className="mt-0.5 font-mono text-slate-800">
                          {activeEscalation.controlVersion ?? '—'}
                          {activeEscalation.expectedControlVersion !== undefined && activeEscalation.expectedControlVersion !== activeEscalation.controlVersion
                            ? ` (expected ${activeEscalation.expectedControlVersion})`
                            : ''}
                        </dd>
                      </div>
                    )}
                  </dl>
                </section>

                <section>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-slate-900">Inbound customer message</h4>
                    {activeEscalation.inboundMessage && (
                      <time
                        dateTime={activeEscalation.inboundMessage.timestamp ?? activeEscalation.inboundMessage.createdAt}
                        className="text-xs text-slate-400"
                      >
                        {formatDate(activeEscalation.inboundMessage.timestamp ?? activeEscalation.inboundMessage.createdAt)}
                      </time>
                    )}
                  </div>
                  <div className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-800">
                    {activeEscalation.inboundMessage?.text ?? 'The inbound customer message is not available.'}
                  </div>
                </section>

                {detail && detail.evidence.length > 0 && (
                  <section>
                    <h4 className="text-sm font-semibold text-slate-900">Referenced business records</h4>
                    <ul className="mt-2 space-y-2">
                      {detail.evidence.map((item) => (
                        <li
                          key={`${item.kind}-${item.recordId}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs"
                        >
                          <span className="font-medium text-slate-800">
                            {item.label ?? 'Record no longer available in active catalog or FAQs'}
                          </span>
                          <span className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold uppercase text-[10px] text-slate-600">
                            {item.kind === 'faq' ? 'FAQ' : 'Catalog item'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <section>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-slate-900">Recent conversation history</h4>
                    <span className="text-xs text-slate-400">
                      {historyLoading ? 'Loading…' : `${recentMessages.length} ${recentMessages.length === 1 ? 'message' : 'messages'}`}
                    </span>
                  </div>
                  {historyError ? (
                    <p role="alert" className="mt-2 text-xs text-rose-700">{historyError}</p>
                  ) : historyLoading && recentMessages.length === 0 ? (
                    <p role="status" className="mt-2 text-xs text-slate-500">Loading conversation messages…</p>
                  ) : recentMessages.length === 0 ? (
                    <p className="mt-2 text-xs text-slate-500">No messages found for this conversation.</p>
                  ) : (
                    <ol className="mt-2 max-h-64 space-y-2.5 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/60 p-3">
                      {recentMessages.map((message) => {
                        const isTrigger = message.id === activeEscalation.inboundMessage?.id
                        return (
                          <li
                            key={message.id}
                            className={`rounded-lg border p-3 ${
                              isTrigger
                                ? 'border-amber-300 bg-amber-50/70'
                                : message.direction === 'outbound'
                                  ? 'border-emerald-200 bg-emerald-50/50'
                                  : 'border-slate-200 bg-white'
                            }`}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                              <span className="font-semibold text-slate-700">
                                {message.direction === 'inbound' ? 'Customer' : 'Business'}
                                {isTrigger ? ' · Escalated message' : ''}
                              </span>
                              <time dateTime={message.timestamp ?? message.createdAt}>
                                {formatDate(message.timestamp ?? message.createdAt)}
                              </time>
                            </div>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-slate-800">
                              {message.text}
                            </p>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </section>

                {detailLoading && <p role="status" className="text-xs text-slate-500">Refreshing escalation details…</p>}
                {detailError && (
                  <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800">
                    {detailError}
                  </div>
                )}
                {actionError && (
                  <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800">
                    {actionError}
                  </div>
                )}
                {actionSuccess && (
                  <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">
                    {actionSuccess}
                  </div>
                )}

                {isOpen ? (
                  <section aria-labelledby="owner-resolution-heading" className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                    <div>
                      <h4 id="owner-resolution-heading" className="text-sm font-semibold text-slate-900">
                        Owner resolution decision
                      </h4>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        Record how this escalation was handled. This updates the escalation status only and never sends a WhatsApp message.
                      </p>
                    </div>
                    <div>
                      <label htmlFor="escalation-resolution-note" className="block text-xs font-semibold text-slate-700">
                        Resolution note (optional)
                      </label>
                      <textarea
                        id="escalation-resolution-note"
                        value={resolutionNote}
                        onChange={(event) => setResolutionNote(event.target.value)}
                        disabled={resolvingOutcome !== null}
                        maxLength={maximumNoteLength}
                        rows={3}
                        placeholder="Add an optional note about how you handled or replied to this customer…"
                        className="mt-1.5 w-full resize-y rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm leading-6 text-slate-800 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100 disabled:opacity-60"
                      />
                      <div className="mt-1 flex justify-between text-xs text-slate-400">
                        <span>Visible only to the business owner</span>
                        <span className="tabular-nums">{resolutionNote.trim().length}/{maximumNoteLength}</span>
                      </div>
                    </div>
                    <div className="flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
                      <button
                        type="button"
                        onClick={() => void handleResolve('dismissed')}
                        disabled={resolvingOutcome !== null || detailLoading}
                        className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {resolvingOutcome === 'dismissed' ? 'Dismissing…' : 'Dismiss escalation'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResolve('resolved')}
                        disabled={resolvingOutcome !== null || detailLoading}
                        className="rounded-xl bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {resolvingOutcome === 'resolved' ? 'Marking resolved…' : 'Mark as resolved'}
                      </button>
                    </div>
                  </section>
                ) : (
                  <section aria-labelledby="resolution-summary-heading" className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h4 id="resolution-summary-heading" className="text-sm font-semibold text-slate-900">
                        Resolution record
                      </h4>
                      <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${statusClasses(activeEscalation.status)}`}>
                        {statusLabel(activeEscalation.status)}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-slate-600">
                      {activeEscalation.resolvedAt
                        ? `${activeEscalation.status === 'dismissed' ? 'Dismissed' : 'Resolved'} by owner on ${formatDate(activeEscalation.resolvedAt)}.`
                        : 'Closed by owner.'}
                    </p>
                    {activeEscalation.resolutionNote && (
                      <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-sm leading-6 text-slate-800">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Owner note</p>
                        <p className="mt-1 whitespace-pre-wrap break-words">{activeEscalation.resolutionNote}</p>
                      </div>
                    )}
                  </section>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
