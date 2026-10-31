import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ApiError,
  createFaq,
  deactivateFaq,
  getFaqs,
  updateFaq,
  type Faq,
  type FaqCreateData,
  type FaqsResponse,
} from '../services/api'

const fieldClass =
  'mt-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10'

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

function FaqForm({
  faq,
  saving,
  onClose,
  onSave,
}: {
  faq: Faq | null
  saving: boolean
  onClose: () => void
  onSave: (data: FaqCreateData, id?: string) => Promise<void>
}) {
  const [question, setQuestion] = useState(faq?.question ?? '')
  const [answer, setAnswer] = useState(faq?.answer ?? '')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<{ question?: string; answer?: string }>({})

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanQuestion = question.trim()
    const cleanAnswer = answer.trim()
    const errors = {
      ...(!cleanQuestion ? { question: 'Enter a question.' } : {}),
      ...(!cleanAnswer ? { answer: 'Enter an answer.' } : {}),
    }
    setFieldErrors(errors)
    setError(null)
    if (Object.keys(errors).length) return

    try {
      await onSave({ question: cleanQuestion, answer: cleanAnswer }, faq?.id)
    } catch (saveError) {
      setError(errorMessage(saveError, 'Unable to save this FAQ. Please try again.'))
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}>
      <section role="dialog" aria-modal="true" aria-labelledby="faq-form-title" className="my-auto w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl sm:p-7">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">Business knowledge</p>
        <h2 id="faq-form-title" className="mt-2 text-xl font-semibold text-slate-950">{faq ? 'Edit FAQ' : 'Add FAQ'}</h2>
        <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-5" noValidate>
          <div>
            <label htmlFor="faq-question" className="text-sm font-medium text-slate-800">Question <span className="text-rose-600" aria-hidden="true">*</span></label>
            <input id="faq-question" autoFocus required maxLength={500} value={question} onChange={(event) => setQuestion(event.target.value)} className={`${fieldClass} ${fieldErrors.question ? 'border-rose-400' : ''}`} aria-invalid={Boolean(fieldErrors.question)} aria-describedby={fieldErrors.question ? 'faq-question-error' : undefined} placeholder="What do customers often ask?" />
            {fieldErrors.question && <p id="faq-question-error" className="mt-1.5 text-xs text-rose-700">{fieldErrors.question}</p>}
          </div>
          <div>
            <label htmlFor="faq-answer" className="text-sm font-medium text-slate-800">Answer <span className="text-rose-600" aria-hidden="true">*</span></label>
            <textarea id="faq-answer" required maxLength={5000} rows={6} value={answer} onChange={(event) => setAnswer(event.target.value)} className={`${fieldClass} resize-y ${fieldErrors.answer ? 'border-rose-400' : ''}`} aria-invalid={Boolean(fieldErrors.answer)} aria-describedby={fieldErrors.answer ? 'faq-answer-error' : undefined} placeholder="Write a clear answer for your customers." />
            {fieldErrors.answer && <p id="faq-answer-error" className="mt-1.5 text-xs text-rose-700">{fieldErrors.answer}</p>}
          </div>
          {error && <div role="alert" aria-live="polite" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>}
          <div className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:justify-end">
            <button type="button" onClick={onClose} disabled={saving} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:opacity-50">Cancel</button>
            <button type="submit" disabled={saving} className="rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60">{saving ? 'Saving…' : faq ? 'Save changes' : 'Add FAQ'}</button>
          </div>
        </form>
      </section>
    </div>
  )
}

export function FaqsPage() {
  const [result, setResult] = useState<FaqsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [editingFaq, setEditingFaq] = useState<Faq | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [deactivatingFaq, setDeactivatingFaq] = useState<Faq | null>(null)
  const [deactivating, setDeactivating] = useState(false)
  const deactivatingRef = useRef(false)
  const [deactivateError, setDeactivateError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    setLoading(true)
    setLoadError(null)
    void getFaqs({ isActive: true })
      .then((response) => { if (current) setResult(response) })
      .catch((error: unknown) => { if (current) setLoadError(errorMessage(error, 'Unable to load FAQs. Please retry.')) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [refreshVersion])

  async function saveFaq(data: FaqCreateData, id?: string) {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      if (id) {
        await updateFaq(id, data)
        setSuccessMessage('FAQ updated successfully.')
      } else {
        await createFaq(data)
        setSuccessMessage('FAQ added successfully.')
      }
      setFormOpen(false)
      setEditingFaq(null)
      setRefreshVersion((version) => version + 1)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  async function confirmDeactivate() {
    if (!deactivatingFaq || deactivatingRef.current) return
    deactivatingRef.current = true
    setDeactivating(true)
    setDeactivateError(null)
    try {
      await deactivateFaq(deactivatingFaq.id)
      setSuccessMessage('FAQ deactivated and removed from the active list.')
      setDeactivatingFaq(null)
      setRefreshVersion((version) => version + 1)
    } catch (error) {
      setDeactivateError(errorMessage(error, 'Unable to deactivate this FAQ. Please try again.'))
    } finally {
      deactivatingRef.current = false
      setDeactivating(false)
    }
  }

  const faqs = result?.faqs ?? []

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-emerald-700">Workspace management</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">FAQs</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">Keep clear answers to common customer questions in one place.</p>
        </div>
        <button type="button" onClick={() => { setEditingFaq(null); setFormOpen(true); setSuccessMessage(null) }} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"><span aria-hidden="true" className="mr-2 text-lg leading-none">+</span> Add FAQ</button>
      </section>

      <section className="flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm sm:px-5">
        <p className="text-sm text-slate-600" aria-live="polite">{loading ? 'Loading FAQs…' : `${faqs.length} active ${faqs.length === 1 ? 'FAQ' : 'FAQs'}`}</p>
      </section>

      {successMessage && <div role="status" aria-live="polite" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{successMessage}</div>}

      {loadError ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-sm font-semibold text-rose-700">FAQs unavailable</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">{loadError}</p>
          <button type="button" onClick={() => setRefreshVersion((version) => version + 1)} className="mt-5 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2">Retry loading</button>
        </section>
      ) : loading ? (
        <div role="status" aria-live="polite" className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm"><div className="flex items-center gap-3"><div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-emerald-700" /><p className="text-sm font-medium text-slate-700">Loading FAQs…</p></div></div>
      ) : faqs.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center shadow-sm">
          <div aria-hidden="true" className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-sm font-bold text-emerald-800">FAQ</div>
          <h3 className="mt-4 text-lg font-semibold text-slate-950">No FAQs yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">Add answers to common customer questions so your business information stays organized.</p>
          <button type="button" onClick={() => { setEditingFaq(null); setFormOpen(true) }} className="mt-5 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2">Add your first FAQ</button>
        </section>
      ) : (
        <section aria-label="Active frequently asked questions" className="grid gap-4 lg:grid-cols-2">
          {faqs.map((faq) => (
            <article key={faq.id} className="flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <h3 className="break-words text-base font-semibold leading-6 text-slate-950">{faq.question}</h3>
              <p className="mt-3 flex-1 whitespace-pre-wrap break-words text-sm leading-6 text-slate-600">{faq.answer}</p>
              <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
                <button type="button" onClick={() => { setEditingFaq(faq); setFormOpen(true); setSuccessMessage(null) }} aria-label={`Edit FAQ: ${faq.question}`} className="rounded-lg px-3 py-2 text-sm font-medium text-emerald-800 outline-none hover:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-1">Edit</button>
                <button type="button" onClick={() => { setDeactivatingFaq(faq); setDeactivateError(null); setSuccessMessage(null) }} aria-label={`Deactivate FAQ: ${faq.question}`} className="rounded-lg px-3 py-2 text-sm font-medium text-rose-700 outline-none hover:bg-rose-50 focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-1">Deactivate</button>
              </div>
            </article>
          ))}
        </section>
      )}

      {formOpen && <FaqForm faq={editingFaq} saving={saving} onClose={() => { if (!saving) { setFormOpen(false); setEditingFaq(null) } }} onSave={saveFaq} />}

      {deactivatingFaq && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <section role="alertdialog" aria-modal="true" aria-labelledby="faq-deactivate-title" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-rose-700">Confirm deactivation</p>
            <h2 id="faq-deactivate-title" className="mt-2 text-xl font-semibold text-slate-950">Deactivate this FAQ?</h2>
            <p className="mt-3 break-words text-sm leading-6 text-slate-600">“{deactivatingFaq.question}” will be hidden from the active FAQ list. It will not be permanently deleted.</p>
            {deactivateError && <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">{deactivateError}</p>}
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button type="button" disabled={deactivating} onClick={() => setDeactivatingFaq(null)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:opacity-50">Cancel</button>
              <button type="button" disabled={deactivating} onClick={() => void confirmDeactivate()} className="rounded-xl bg-rose-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-rose-800 focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60">{deactivating ? 'Deactivating…' : 'Deactivate FAQ'}</button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
