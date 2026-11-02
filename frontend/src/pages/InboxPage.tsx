import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  ApiError,
  getConversationMessages,
  getConversationResponseMode,
  getConversations,
  sendConversationMessage,
  updateConversationResponseMode,
  type ConversationResponseMode,
  type InboxConversation,
  type InboxMessage,
  type ConversationListResponse,
  type ConversationMessagesResponse,
} from '../services/api'

const pageSize = 20
const maximumMessageLength = 4096

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

function isAmbiguousSendFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true

  const message = error.message.toLowerCase()
  if (message.includes('did not accept') || message.includes('not configured correctly')) return false
  if (message.includes('may have accepted') || message.includes('could not confirm')) return true
  if (error.status === undefined || (error.status >= 200 && error.status < 300)) return true
  return error.status >= 500
}

function withMessageChronology(messages: InboxMessage[]): InboxMessage[] {
  return [...messages].sort((left, right) =>
    Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id),
  )
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function customerHeading(conversation: InboxConversation): string {
  return conversation.customer?.profileName?.trim() || conversation.customer?.phoneNumber || 'Unknown customer'
}

function messageStatusLabel(status: InboxMessage['status']): string {
  switch (status) {
    case 'received': return 'Received'
    case 'sent': return 'Sent'
    case 'delivered': return 'Delivered'
    case 'read': return 'Read'
    case 'failed': return 'Failed'
  }
}

function ConversationItem({
  conversation,
  selected,
  disabled,
  onSelect,
}: {
  conversation: InboxConversation
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const profileName = conversation.customer?.profileName?.trim()

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={`w-full rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${
        selected
          ? 'border-emerald-300 bg-emerald-50/70'
          : 'border-slate-100 bg-white hover:border-slate-200 hover:bg-slate-50'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-slate-950">{customerHeading(conversation)}</p>
          {profileName && conversation.customer?.phoneNumber && (
            <p className="mt-1 truncate text-xs text-slate-500">{conversation.customer.phoneNumber}</p>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold capitalize ${
            conversation.status === 'open'
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          {conversation.status}
        </span>
      </div>
      <p className="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-slate-600">
        {conversation.lastMessagePreview || 'No message preview available.'}
      </p>
      <p className="mt-3 text-xs text-slate-400">{formatDate(conversation.lastActivityAt)}</p>
    </button>
  )
}

function MessageBubble({ message }: { message: InboxMessage }) {
  const outgoing = message.direction === 'outbound'

  return (
    <div className={`flex ${outgoing ? 'justify-end' : 'justify-start'}`}>
      <article
        className={`max-w-[88%] rounded-2xl px-4 py-3 shadow-sm sm:max-w-[78%] ${
          outgoing
            ? 'rounded-br-md bg-emerald-700 text-white'
            : 'rounded-bl-md border border-slate-200 bg-white text-slate-900'
        }`}
      >
        <p className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${outgoing ? 'text-emerald-100' : 'text-slate-400'}`}>
          {outgoing ? 'Business' : 'Customer'}
        </p>
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{message.text}</p>
        <div className={`mt-2 flex flex-wrap items-center justify-end gap-x-2 text-[10px] ${outgoing ? 'text-emerald-100' : 'text-slate-400'}`}>
          <time dateTime={message.timestamp ?? message.createdAt}>
            {formatDate(message.timestamp ?? message.createdAt)}
          </time>
          <span className={message.status === 'failed'
            ? 'font-semibold text-amber-200'
            : outgoing ? 'text-emerald-100' : 'text-slate-400'}>
            {messageStatusLabel(message.status)}
          </span>
        </div>
        {outgoing && message.status === 'failed' && message.providerErrorTitle && (
          <p className="mt-2 border-t border-emerald-600/70 pt-2 text-xs leading-5 text-emerald-50" role="note">
            {message.providerErrorTitle}
          </p>
        )}
      </article>
    </div>
  )
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" className="flex min-h-40 items-center justify-center rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-3 text-sm font-medium text-slate-600">
        <span aria-hidden="true" className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-emerald-700" />
        {label}
      </div>
    </div>
  )
}

function ErrorPanel({
  message,
  onRetry,
  compact = false,
}: {
  message: string
  onRetry: () => void
  compact?: boolean
}) {
  return (
    <div role="alert" className={`rounded-xl border border-rose-200 bg-rose-50 text-rose-900 ${compact ? 'p-4' : 'p-6'}`}>
      <p className="text-sm font-semibold">Unable to load this data</p>
      <p className="mt-1 text-sm leading-6 text-rose-800">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-rose-800 outline-none hover:bg-rose-100 focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
      >
        Retry
      </button>
    </div>
  )
}

export function InboxPage() {
  const [conversationPage, setConversationPage] = useState(1)
  const [conversationRetry, setConversationRetry] = useState(0)
  const [conversationResponse, setConversationResponse] = useState<ConversationListResponse | null>(null)
  const [conversationsLoading, setConversationsLoading] = useState(true)
  const [conversationsError, setConversationsError] = useState<string | null>(null)
  const [selectedConversation, setSelectedConversation] = useState<InboxConversation | null>(null)
  const [responseMode, setResponseMode] = useState<ConversationResponseMode | null>(null)
  const [responseModeLoading, setResponseModeLoading] = useState(false)
  const [responseModeSaving, setResponseModeSaving] = useState(false)
  const [responseModeError, setResponseModeError] = useState<string | null>(null)
  const [responseModeSuccess, setResponseModeSuccess] = useState<string | null>(null)
  const [responseModeRetry, setResponseModeRetry] = useState(0)
  const responseModeSavingRef = useRef(false)

  const [messages, setMessages] = useState<InboxMessage[]>([])
  const [historyPage, setHistoryPage] = useState(1)
  const [loadedHistoryPage, setLoadedHistoryPage] = useState(0)
  const [historyRetry, setHistoryRetry] = useState(0)
  const [historyResponse, setHistoryResponse] = useState<ConversationMessagesResponse | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [composerText, setComposerText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sendOutcomeUncertain, setSendOutcomeUncertain] = useState(false)
  const [scrollToNewest, setScrollToNewest] = useState(false)
  const sendingRef = useRef(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const conversationId = selectedConversation?.id
    if (!conversationId) {
      setResponseMode(null)
      setResponseModeError(null)
      setResponseModeSuccess(null)
      return
    }

    let current = true
    setResponseMode(null)
    setResponseModeLoading(true)
    setResponseModeError(null)
    setResponseModeSuccess(null)

    void getConversationResponseMode(conversationId)
      .then((result) => {
        if (current) setResponseMode(result.conversation.responseMode)
      })
      .catch((error: unknown) => {
        if (current) setResponseModeError(getErrorMessage(error, 'Unable to load this conversation’s response mode.'))
      })
      .finally(() => {
        if (current) setResponseModeLoading(false)
      })

    return () => { current = false }
  }, [selectedConversation?.id, responseModeRetry])

  useEffect(() => {
    let current = true
    setConversationsLoading(true)
    setConversationsError(null)

    void getConversations({ page: conversationPage, limit: pageSize })
      .then((response) => {
        if (!current) return
        const lastPage = Math.max(1, response.pagination.totalPages)
        if (conversationPage > lastPage) {
          setConversationPage(lastPage)
          return
        }
        setConversationResponse(response)
        setSelectedConversation((selected) =>
          response.conversations.find((item) => item.id === selected?.id) ?? selected,
        )
      })
      .catch((error: unknown) => {
        if (current) setConversationsError(getErrorMessage(error, 'Unable to load conversations. Please retry.'))
      })
      .finally(() => {
        if (current) setConversationsLoading(false)
      })

    return () => { current = false }
  }, [conversationPage, conversationRetry])

  useEffect(() => {
    const conversationId = selectedConversation?.id
    if (!conversationId) return

    let current = true
    setHistoryLoading(true)
    setHistoryError(null)

    void getConversationMessages(conversationId, { page: historyPage, limit: pageSize })
      .then((response) => {
        if (!current) return
        setHistoryResponse(response)
        setMessages((existing) => {
          if (historyPage === 1) return response.messages
          const pageIds = new Set(response.messages.map((message) => message.id))
          return [...response.messages, ...existing.filter((message) => !pageIds.has(message.id))]
        })
        setLoadedHistoryPage(historyPage)
      })
      .catch((error: unknown) => {
        if (current) setHistoryError(getErrorMessage(error, 'Unable to load conversation history. Please retry.'))
      })
      .finally(() => {
        if (current) setHistoryLoading(false)
      })

    return () => { current = false }
  }, [selectedConversation?.id, historyPage, historyRetry])

  useEffect(() => {
    if (!scrollToNewest) return
    messagesEndRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' })
    setScrollToNewest(false)
  }, [messages, scrollToNewest])

  function selectConversation(conversation: InboxConversation) {
    if (sendingRef.current || responseModeSaving || conversation.id === selectedConversation?.id) return
    setSelectedConversation(conversation)
    setMessages([])
    setHistoryResponse(null)
    setHistoryPage(1)
    setLoadedHistoryPage(0)
    setHistoryError(null)
    setComposerText('')
    setSendError(null)
    setSendOutcomeUncertain(false)
  }

  async function changeResponseMode(nextMode: ConversationResponseMode) {
    const conversation = selectedConversation
    if (!conversation || !responseMode || responseMode === nextMode || responseModeSavingRef.current) return
    const confirmation = nextMode === 'ai'
      ? 'Switch this conversation to AI mode? AI may generate owner-reviewed drafts, but it will not send messages automatically.'
      : 'Switch this conversation to Human mode? New AI draft generation will be paused.'
    if (!window.confirm(confirmation)) return

    responseModeSavingRef.current = true
    setResponseModeSaving(true)
    setResponseModeError(null)
    setResponseModeSuccess(null)
    try {
      const result = await updateConversationResponseMode(conversation.id, nextMode)
      if (result.conversation.id !== conversation.id) {
        throw new ApiError('The backend returned an unexpected conversation response.', 200)
      }
      setResponseMode(result.conversation.responseMode)
      setResponseModeSuccess(result.message)
    } catch (error) {
      setResponseModeError(getErrorMessage(error, 'Unable to update this conversation’s response mode.'))
      setResponseMode(null)
      setResponseModeLoading(true)
      try {
        const current = await getConversationResponseMode(conversation.id)
        if (current.conversation.id === conversation.id) setResponseMode(current.conversation.responseMode)
      } catch {
        // Keep mode unavailable until the owner refreshes it successfully.
      } finally {
        setResponseModeLoading(false)
      }
    } finally {
      responseModeSavingRef.current = false
      setResponseModeSaving(false)
    }
  }

  async function sendMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const conversation = selectedConversation
    const text = composerText.trim()
    if (!conversation || !text || text.length > maximumMessageLength || historyLoading || sendingRef.current) return

    sendingRef.current = true
    setSending(true)
    setSendError(null)
    setSendOutcomeUncertain(false)

    try {
      const response = await sendConversationMessage(conversation.id, text)
      const sentMessage = response.data.message
      const inboxMessage: InboxMessage = {
        id: sentMessage.id,
        direction: sentMessage.direction,
        messageType: sentMessage.messageType,
        text: sentMessage.text,
        status: sentMessage.status,
        timestamp: sentMessage.timestamp,
        createdAt: sentMessage.createdAt,
      }
      const alreadyRecorded = response.message === 'Message was already recorded.'

      setMessages((current) =>
        current.some((message) => message.id === inboxMessage.id)
          ? current
          : withMessageChronology([...current, inboxMessage]),
      )

      if (historyResponse) {
        if (!alreadyRecorded) {
          setHistoryResponse((current) => {
            if (!current) return current
            const totalItems = current.pagination.totalItems + 1
            return {
              ...current,
              pagination: {
                ...current.pagination,
                totalItems,
                totalPages: Math.ceil(totalItems / current.pagination.limit),
              },
            }
          })
        }
      } else {
        setHistoryPage(1)
        setHistoryRetry((retry) => retry + 1)
      }

      const lastActivityAt = sentMessage.timestamp ?? sentMessage.createdAt
      const updatedConversation = {
        ...conversation,
        lastMessagePreview: sentMessage.text.slice(0, 280),
        lastActivityAt,
      }
      setSelectedConversation(updatedConversation)
      setConversationResponse((current) => current
        ? {
            ...current,
            conversations: current.conversations.map((item) =>
              item.id === conversation.id ? updatedConversation : item,
            ),
          }
        : current)
      setComposerText('')
      setScrollToNewest(true)
    } catch (error) {
      setSendError(getErrorMessage(error, 'Unable to send this message. Please check the conversation before trying again.'))
      setSendOutcomeUncertain(isAmbiguousSendFailure(error))
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void sendMessage()
    }
  }

  const conversations = conversationResponse?.conversations ?? []
  const pagination = conversationResponse?.pagination
  const totalPages = Math.max(1, pagination?.totalPages ?? 1)
  const hasOlderMessages = loadedHistoryPage > 0 && loadedHistoryPage < (historyResponse?.pagination.totalPages ?? 0)

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-emerald-700">Customer conversations</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">Inbox</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">Review incoming WhatsApp conversations and their message history.</p>
        </div>
        <p className="text-sm text-slate-500" aria-live="polite">
          {conversationsLoading ? 'Loading conversations…' : `${pagination?.totalItems ?? 0} ${pagination?.totalItems === 1 ? 'conversation' : 'conversations'}`}
        </p>
      </section>

      <section className="grid h-[68svh] min-h-[520px] gap-4 md:grid-cols-[minmax(280px,0.85fr)_minmax(0,1.5fr)]">
        <aside className={`${selectedConversation ? 'hidden md:block' : 'block'} min-h-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm`} aria-label="Conversation list">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-4 sm:px-5">
            <div>
              <h3 className="font-semibold text-slate-950">Conversations</h3>
              <p className="mt-1 text-xs text-slate-500">Sorted by latest activity</p>
            </div>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{pagination?.totalItems ?? 0}</span>
          </div>

          {conversationsError ? (
            <div className="p-4"><ErrorPanel compact message={conversationsError} onRetry={() => setConversationRetry((value) => value + 1)} /></div>
          ) : conversationsLoading && !conversationResponse ? (
            <div className="p-4"><LoadingPanel label="Loading conversations…" /></div>
          ) : conversations.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <span aria-hidden="true" className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-sm font-bold text-emerald-800">IN</span>
              <h4 className="mt-4 text-sm font-semibold text-slate-900">Your inbox is empty</h4>
              <p className="mt-2 text-sm leading-6 text-slate-500">Conversations will appear here when customers message your connected WhatsApp number.</p>
            </div>
          ) : (
            <>
              <div className="max-h-[calc(68svh-125px)] space-y-2 overflow-y-auto p-3">
                {conversations.map((conversation) => (
                  <ConversationItem
                    key={conversation.id}
                    conversation={conversation}
                    selected={selectedConversation?.id === conversation.id}
                    disabled={sending || responseModeSaving}
                    onSelect={() => selectConversation(conversation)}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3">
                <p className="text-xs text-slate-500">Page {pagination?.page ?? conversationPage} of {totalPages}</p>
                <div className="flex gap-2">
                  <button type="button" disabled={conversationPage <= 1 || conversationsLoading} onClick={() => setConversationPage((page) => Math.max(1, page - 1))} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
                  <button type="button" disabled={conversationPage >= totalPages || conversationsLoading} onClick={() => setConversationPage((page) => Math.min(totalPages, page + 1))} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-50">Next</button>
                </div>
              </div>
            </>
          )}
        </aside>

        <section className={`${selectedConversation ? 'flex' : 'hidden md:flex'} min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm`} aria-label="Conversation history">
          {!selectedConversation ? (
            <div className="flex flex-1 flex-col items-center justify-center px-8 py-16 text-center">
              <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-lg font-bold text-emerald-800">WA</span>
              <h3 className="mt-5 text-lg font-semibold text-slate-950">Select a conversation</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">Choose a customer from the list to view their message history.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-4 sm:px-5">
                <button type="button" disabled={sending || responseModeSaving} onClick={() => setSelectedConversation(null)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-50 md:hidden">Back</button>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate font-semibold text-slate-950">{customerHeading(selectedConversation)}</h3>
                  {selectedConversation.customer?.phoneNumber && selectedConversation.customer.profileName && (
                    <p className="mt-1 truncate text-xs text-slate-500">{selectedConversation.customer.phoneNumber}</p>
                  )}
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold capitalize ${selectedConversation.status === 'open' ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
                  {selectedConversation.status}
                </span>
                <button
                  type="button"
                  disabled={historyLoading}
                  onClick={() => {
                    setHistoryPage(1)
                    setLoadedHistoryPage(0)
                    setMessages([])
                    setHistoryResponse(null)
                    setHistoryRetry((retry) => retry + 1)
                  }}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Refresh conversation messages"
                >
                  {historyLoading ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              <section className="border-b border-slate-100 bg-slate-50/70 px-4 py-3 sm:px-5" aria-label="Conversation response mode">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-slate-800">Response mode</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {responseModeLoading
                        ? 'Loading current mode…'
                        : responseMode
                          ? `Currently ${responseMode === 'ai' ? 'AI draft mode' : 'Human mode'}.`
                          : 'Current mode is unavailable.'}
                    </p>
                  </div>
                  <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1" role="group" aria-label="Set conversation response mode">
                    <button
                      type="button"
                      aria-pressed={responseMode === 'human'}
                      disabled={responseModeLoading || responseModeSaving || responseMode === null || responseMode === 'human'}
                      onClick={() => void changeResponseMode('human')}
                      className={`rounded-lg px-3 py-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed ${responseMode === 'human' ? 'bg-slate-800 text-white' : 'text-slate-700 hover:bg-slate-100 disabled:opacity-50'}`}
                    >
                      {responseModeSaving && responseMode === 'ai' ? 'Switching…' : 'Human'}
                    </button>
                    <button
                      type="button"
                      aria-pressed={responseMode === 'ai'}
                      disabled={responseModeLoading || responseModeSaving || responseMode === null || responseMode === 'ai'}
                      onClick={() => void changeResponseMode('ai')}
                      className={`rounded-lg px-3 py-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:cursor-not-allowed ${responseMode === 'ai' ? 'bg-emerald-700 text-white' : 'text-slate-700 hover:bg-slate-100 disabled:opacity-50'}`}
                    >
                      {responseModeSaving && responseMode === 'human' ? 'Switching…' : 'AI'}
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-[11px] leading-5 text-slate-500">AI mode can generate owner-reviewed drafts; it does not send messages automatically.</p>
                {responseModeLoading && <p role="status" className="sr-only">Loading conversation response mode.</p>}
                {responseModeError && (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2" role="alert">
                    <p className="text-xs text-rose-700">{responseModeError}</p>
                    <button type="button" onClick={() => setResponseModeRetry((value) => value + 1)} disabled={responseModeLoading || responseModeSaving} className="rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-800 outline-none hover:bg-rose-50 focus-visible:ring-2 focus-visible:ring-rose-600 disabled:opacity-50">Refresh mode</button>
                  </div>
                )}
                {responseModeSaving && <p role="status" className="mt-2 text-xs text-slate-600">Updating response mode…</p>}
                {responseModeSuccess && <p role="status" className="mt-2 text-xs text-emerald-800">{responseModeSuccess}</p>}
              </section>

              {historyError && <div className="border-b border-rose-100 p-3"><ErrorPanel compact message={historyError} onRetry={() => setHistoryRetry((value) => value + 1)} /></div>}

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-slate-50/70 p-4 sm:p-6" aria-live="polite" aria-relevant="additions text">
                {(historyLoading || (loadedHistoryPage === 0 && !historyError)) && messages.length === 0 ? (
                  <LoadingPanel label="Loading message history…" />
                ) : !historyLoading && !historyError && messages.length === 0 ? (
                  <div className="flex min-h-64 flex-col items-center justify-center text-center">
                    <h4 className="text-sm font-semibold text-slate-900">No messages yet</h4>
                    <p className="mt-2 text-sm text-slate-500">This conversation does not have any saved messages.</p>
                  </div>
                ) : (
                  <>
                    {hasOlderMessages && (
                      <div className="flex justify-center">
                        <button type="button" disabled={historyLoading} onClick={() => setHistoryPage(loadedHistoryPage + 1)} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-600 outline-none hover:border-emerald-300 hover:text-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-50">
                          {historyLoading ? 'Loading older messages…' : 'Load older messages'}
                        </button>
                      </div>
                    )}
                    {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
                    {historyLoading && messages.length > 0 && <p role="status" className="text-center text-xs text-slate-500">Loading older messages…</p>}
                    <div ref={messagesEndRef} aria-hidden="true" />
                  </>
                )}
              </div>
              {sendError && (
                <div className={`border-t px-4 py-3 ${sendOutcomeUncertain ? 'border-amber-200 bg-amber-50' : 'border-rose-100 bg-rose-50'}`} role="alert">
                  <p className={`text-sm font-semibold ${sendOutcomeUncertain ? 'text-amber-900' : 'text-rose-900'}`}>
                    {sendOutcomeUncertain ? 'Message outcome is uncertain' : 'Message was not sent'}
                  </p>
                  <p className={`mt-1 text-sm leading-5 ${sendOutcomeUncertain ? 'text-amber-900' : 'text-rose-800'}`}>{sendError}</p>
                  {sendOutcomeUncertain && <p className="mt-1 text-xs leading-5 text-amber-900">No automatic retry was made. Check this conversation before choosing to send again; a duplicate message is possible.</p>}
                </div>
              )}
              <form onSubmit={(event) => void sendMessage(event)} className="border-t border-slate-100 bg-white p-3 sm:p-4">
                <label htmlFor="inbox-message-composer" className="sr-only">Write a message</label>
                <div className="flex items-end gap-3">
                  <textarea
                    id="inbox-message-composer"
                    value={composerText}
                    onChange={(event) => setComposerText(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    disabled={!selectedConversation || sending || historyLoading}
                    maxLength={maximumMessageLength}
                    rows={3}
                    placeholder="Write a WhatsApp message…"
                    className="min-h-20 flex-1 resize-y rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-emerald-500 focus:bg-white focus:ring-4 focus:ring-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-60"
                    aria-describedby="inbox-composer-hint inbox-composer-count"
                  />
                  <button
                    type="submit"
                    disabled={!selectedConversation || !composerText.trim() || composerText.trim().length > maximumMessageLength || sending || historyLoading}
                    className="min-h-11 shrink-0 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white outline-none transition hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:px-5"
                  >
                    {sending ? 'Sending…' : sendOutcomeUncertain ? 'Send again' : 'Send'}
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 px-1">
                  <p id="inbox-composer-hint" className="text-xs text-slate-500">Enter to send · Shift+Enter for a new line</p>
                  <p id="inbox-composer-count" className={`text-xs ${composerText.trim().length >= maximumMessageLength ? 'text-amber-700' : 'text-slate-400'}`}>
                    {composerText.trim().length}/{maximumMessageLength}
                  </p>
                </div>
              </form>
            </>
          )}
        </section>
      </section>
    </div>
  )
}
