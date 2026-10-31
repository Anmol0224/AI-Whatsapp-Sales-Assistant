import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ApiError,
  createCatalogItem,
  deactivateCatalogItem,
  getCatalogItems,
  updateCatalogItem,
  type CatalogItem,
  type CatalogItemCreateData,
  type CatalogItemKind,
  type CatalogItemsResponse,
  type CatalogItemUpdateData,
} from '../services/api'

const pageSize = 20
type KindFilter = 'all' | CatalogItemKind

type ItemForm = {
  kind: CatalogItemKind
  name: string
  description: string
  priceInRupees: string
  availability: string
}

function formatRupees(paise: number): string {
  const rupees = Math.floor(paise / 100)
  const fraction = String(paise % 100).padStart(2, '0')
  return `₹${rupees.toLocaleString('en-IN')}.${fraction}`
}

function parseRupees(input: string): { priceInPaise?: number; error?: string } {
  const value = input.trim()
  if (!value) return {}

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) {
    return { error: 'Enter a non-negative rupee amount with no more than two decimal places.' }
  }

  const wholeRupees = Number(match[1])
  const paisePart = Number((match[2] ?? '').padEnd(2, '0') || '0')
  const priceInPaise = wholeRupees * 100 + paisePart

  if (
    !Number.isFinite(wholeRupees) ||
    !Number.isFinite(priceInPaise) ||
    !Number.isSafeInteger(priceInPaise) ||
    priceInPaise < 0
  ) {
    return { error: 'Enter a finite amount that can be represented safely in paise.' }
  }

  return { priceInPaise }
}

function itemToForm(item: CatalogItem): ItemForm {
  return {
    kind: item.kind,
    name: item.name,
    description: item.description ?? '',
    priceInRupees: item.priceInPaise === undefined ? '' : formatRupees(item.priceInPaise),
    availability: item.availability ?? '',
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

function CatalogItemForm({
  item,
  onClose,
  onSave,
}: {
  item: CatalogItem | null
  onClose: () => void
  onSave: (data: CatalogItemCreateData, itemId?: string) => Promise<void>
}) {
  const [form, setForm] = useState<ItemForm>(
    item
      ? itemToForm(item)
      : { kind: 'product', name: '', description: '', priceInRupees: '', availability: '' },
  )
  const [nameError, setNameError] = useState<string | null>(null)
  const [priceError, setPriceError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !savingRef.current) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function setField<K extends keyof ItemForm>(field: K, value: ItemForm[K]) {
    setForm((current) => ({ ...current, [field]: value }))
    if (field === 'name') setNameError(null)
    if (field === 'priceInRupees') setPriceError(null)
    setSubmitError(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (savingRef.current) return

    const trimmedName = form.name.trim()
    const parsedPrice = parseRupees(form.priceInRupees)
    setNameError(trimmedName ? null : 'Name is required.')
    setPriceError(parsedPrice.error ?? null)
    setSubmitError(null)
    if (!trimmedName || parsedPrice.error) return

    const description = form.description.trim()
    const availability = form.availability.trim()
    const data: CatalogItemCreateData = {
      kind: form.kind,
      name: trimmedName,
      currency: 'INR',
      ...(item || description ? { description } : {}),
      ...(item || availability ? { availability } : {}),
      ...(parsedPrice.priceInPaise !== undefined
        ? { priceInPaise: parsedPrice.priceInPaise }
        : {}),
    }

    savingRef.current = true
    setSaving(true)
    try {
      await onSave(data, item?.id)
    } catch (error) {
      setSubmitError(getErrorMessage(error, 'Unable to save this catalog item. Please try again.'))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/40 p-0 sm:items-center sm:p-5">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="catalog-form-title"
        className="max-h-[95svh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-xl sm:rounded-3xl sm:p-7"
      >
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              {item ? 'Edit catalog item' : 'New catalog item'}
            </p>
            <h2 id="catalog-form-title" className="mt-2 text-xl font-semibold text-slate-950">
              {item ? 'Update item details' : 'Add a product or service'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close form"
            className="rounded-lg px-2 py-1 text-xl leading-none text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-50"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {item ? (
            <div>
              <span className="text-sm font-medium text-slate-800">Kind</span>
              <p className="mt-2 rounded-xl bg-slate-50 px-3.5 py-3 text-sm capitalize text-slate-700">{item.kind}</p>
            </div>
          ) : (
            <div>
              <label htmlFor="catalog-kind" className="text-sm font-medium text-slate-800">Kind <span className="text-rose-600">*</span></label>
              <select
                id="catalog-kind"
                value={form.kind}
                onChange={(event) => setField('kind', event.target.value as CatalogItemKind)}
                className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3.5 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10"
              >
                <option value="product">Product</option>
                <option value="service">Service</option>
              </select>
            </div>
          )}

          <div>
            <label htmlFor="catalog-name" className="text-sm font-medium text-slate-800">Name <span className="text-rose-600">*</span></label>
            <input
              id="catalog-name"
              value={form.name}
              onChange={(event) => setField('name', event.target.value)}
              maxLength={150}
              required
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? 'catalog-name-error' : undefined}
              autoFocus
              className={`mt-2 h-11 w-full rounded-xl border bg-white px-3.5 text-sm text-slate-900 outline-none focus:ring-4 ${nameError ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/10' : 'border-slate-200 focus:border-emerald-500 focus:ring-emerald-500/10'}`}
            />
            {nameError && <p id="catalog-name-error" className="mt-1 text-xs text-rose-700">{nameError}</p>}
          </div>

          <div>
            <label htmlFor="catalog-description" className="text-sm font-medium text-slate-800">Description</label>
            <textarea
              id="catalog-description"
              value={form.description}
              onChange={(event) => setField('description', event.target.value)}
              rows={3}
              maxLength={2000}
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10"
            />
          </div>

          <div>
            <label htmlFor="catalog-price" className="text-sm font-medium text-slate-800">Price (INR)</label>
            <div className="relative mt-2">
              <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-sm text-slate-500">₹</span>
              <input
                id="catalog-price"
                inputMode="decimal"
                type="text"
                value={form.priceInRupees}
                onChange={(event) => setField('priceInRupees', event.target.value)}
                placeholder="450.50"
                aria-invalid={Boolean(priceError)}
                aria-describedby={priceError ? 'catalog-price-error' : 'catalog-price-hint'}
                className={`h-11 w-full rounded-xl border bg-white pl-8 pr-3.5 text-sm text-slate-900 outline-none focus:ring-4 ${priceError ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/10' : 'border-slate-200 focus:border-emerald-500 focus:ring-emerald-500/10'}`}
              />
            </div>
            {priceError ? (
              <p id="catalog-price-error" className="mt-1 text-xs text-rose-700">{priceError}</p>
            ) : (
              <p id="catalog-price-hint" className="mt-1 text-xs leading-5 text-slate-500">
                Enter up to two decimal places. {item ? 'Leave blank to keep the current price.' : 'Price is optional.'}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="catalog-availability" className="text-sm font-medium text-slate-800">Availability</label>
            <textarea
              id="catalog-availability"
              value={form.availability}
              onChange={(event) => setField('availability', event.target.value)}
              rows={2}
              maxLength={1000}
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-900 outline-none focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10"
            />
          </div>

          {submitError && (
            <div role="alert" aria-live="polite" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {submitError}
            </div>
          )}

          <div className="flex flex-col-reverse gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Saving…' : item ? 'Save changes' : 'Add item'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

function DeactivateDialog({
  item,
  saving,
  error,
  onCancel,
  onConfirm,
}: {
  item: CatalogItem
  saving: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <section role="alertdialog" aria-modal="true" aria-labelledby="deactivate-title" className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-rose-700">Confirm deactivation</p>
        <h2 id="deactivate-title" className="mt-2 text-xl font-semibold text-slate-950">Deactivate {item.name}?</h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          This hides the item from the active catalog but does not permanently delete it.
        </p>
        {error && <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>}
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" disabled={saving} onClick={onCancel} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:opacity-50">
            Cancel
          </button>
          <button type="button" disabled={saving} onClick={onConfirm} className="rounded-xl bg-rose-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-rose-800 focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60">
            {saving ? 'Deactivating…' : 'Deactivate item'}
          </button>
        </div>
      </section>
    </div>
  )
}

export function CatalogPage() {
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [page, setPage] = useState(1)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [result, setResult] = useState<CatalogItemsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [activeForm, setActiveForm] = useState<{ item: CatalogItem | null } | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [deactivateItem, setDeactivateItem] = useState<CatalogItem | null>(null)
  const [deactivating, setDeactivating] = useState(false)
  const deactivatingRef = useRef(false)
  const [deactivateError, setDeactivateError] = useState<string | null>(null)

  useEffect(() => {
    let isCurrent = true
    setLoading(true)
    setLoadError(null)

    void getCatalogItems({
      page,
      limit: pageSize,
      kind: kindFilter === 'all' ? undefined : kindFilter,
      isActive: true,
    })
      .then((response) => {
        if (!isCurrent) return
        const lastPage = Math.max(1, response.pagination.totalPages)
        if (page > lastPage) {
          setPage(lastPage)
          return
        }
        setResult(response)
      })
      .catch((error: unknown) => {
        if (isCurrent) setLoadError(getErrorMessage(error, 'Unable to load the catalog. Please retry.'))
      })
      .finally(() => {
        if (isCurrent) setLoading(false)
      })

    return () => {
      isCurrent = false
    }
  }, [kindFilter, page, refreshVersion])

  function changeFilter(filter: KindFilter) {
    if (filter === kindFilter) return
    setKindFilter(filter)
    setPage(1)
    setSuccessMessage(null)
  }

  async function handleSave(data: CatalogItemCreateData, itemId?: string): Promise<void> {
    if (itemId) {
      const update: CatalogItemUpdateData = {
        name: data.name,
        description: data.description ?? '',
        availability: data.availability ?? '',
        ...(data.priceInPaise !== undefined ? { priceInPaise: data.priceInPaise } : {}),
      }
      await updateCatalogItem(itemId, update)
      setSuccessMessage('Catalog item updated successfully.')
    } else {
      await createCatalogItem(data)
      setSuccessMessage('Catalog item added successfully.')
      setPage(1)
    }
    setActiveForm(null)
    setRefreshVersion((version) => version + 1)
  }

  async function confirmDeactivation() {
    if (!deactivateItem || deactivatingRef.current) return
    deactivatingRef.current = true
    setDeactivating(true)
    setDeactivateError(null)
    try {
      await deactivateCatalogItem(deactivateItem.id)
      setSuccessMessage(`${deactivateItem.name} was deactivated and removed from the active catalog.`)
      setDeactivateItem(null)
      setRefreshVersion((version) => version + 1)
    } catch (error) {
      setDeactivateError(getErrorMessage(error, 'Unable to deactivate this item. Please try again.'))
    } finally {
      deactivatingRef.current = false
      setDeactivating(false)
    }
  }

  const filters: { label: string; value: KindFilter }[] = [
    { label: 'All', value: 'all' },
    { label: 'Products', value: 'product' },
    { label: 'Services', value: 'service' },
  ]
  const items = result?.items ?? []
  const pagination = result?.pagination
  const displayTotalPages = Math.max(1, pagination?.totalPages ?? 1)

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-emerald-700">Workspace management</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Products & Services</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">Manage the products and services in your business catalog.</p>
        </div>
        <button
          type="button"
          onClick={() => { setActiveForm({ item: null }); setSuccessMessage(null) }}
          className="inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
        >
          <span aria-hidden="true" className="mr-2 text-lg leading-none">+</span> Add Item
        </button>
      </section>

      <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter catalog by kind">
          {filters.map((filter) => {
            const active = kindFilter === filter.value
            return (
              <button
                key={filter.value}
                type="button"
                aria-pressed={active}
                onClick={() => changeFilter(filter.value)}
                className={`rounded-lg px-3.5 py-2 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 ${active ? 'bg-emerald-700 text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}
              >
                {filter.label}
              </button>
            )
          })}
        </div>
        <p className="text-sm text-slate-500" aria-live="polite">
          {loading ? 'Loading items…' : `${pagination?.totalItems ?? 0} ${pagination?.totalItems === 1 ? 'item' : 'items'}`}
        </p>
      </section>

      {successMessage && (
        <div role="status" aria-live="polite" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          {successMessage}
        </div>
      )}

      {loadError ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-sm font-semibold text-rose-700">Catalog unavailable</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">{loadError}</p>
          <button
            type="button"
            onClick={() => setRefreshVersion((version) => version + 1)}
            className="mt-5 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
          >
            Retry loading
          </button>
        </section>
      ) : loading ? (
        <div role="status" aria-live="polite" className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-emerald-700" />
            <p className="text-sm font-medium text-slate-700">Loading catalog items…</p>
          </div>
        </div>
      ) : items.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-sm font-bold text-emerald-800" aria-hidden="true">PS</div>
          <h3 className="mt-4 text-lg font-semibold text-slate-950">No {kindFilter === 'all' ? 'catalog items' : `${kindFilter}s`} yet</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-600">
            Add a product or service to start building your business catalog.
          </p>
          <button type="button" onClick={() => setActiveForm({ item: null })} className="mt-5 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2">
            Add your first item
          </button>
        </section>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[850px] border-collapse text-left">
                <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-5 py-4">Item</th>
                    <th scope="col" className="px-5 py-4">Kind</th>
                    <th scope="col" className="px-5 py-4">Price</th>
                    <th scope="col" className="px-5 py-4">Availability</th>
                    <th scope="col" className="px-5 py-4">Status</th>
                    <th scope="col" className="px-5 py-4"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item) => (
                    <tr key={item.id} className="align-top">
                      <td className="max-w-sm px-5 py-4">
                        <p className="font-medium text-slate-900">{item.name}</p>
                        <p className="mt-1 line-clamp-2 text-sm text-slate-500">{item.description || 'No description'}</p>
                      </td>
                      <td className="px-5 py-4 text-sm capitalize text-slate-600">{item.kind}</td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm text-slate-700">{item.priceInPaise === undefined ? '—' : formatRupees(item.priceInPaise)}</td>
                      <td className="max-w-xs px-5 py-4 text-sm text-slate-600">{item.availability || '—'}</td>
                      <td className="px-5 py-4"><StatusBadge active={item.isActive} /></td>
                      <td className="whitespace-nowrap px-5 py-4 text-right">
                        <ItemActions item={item} onEdit={() => { setActiveForm({ item }); setSuccessMessage(null) }} onDeactivate={() => { setDeactivateItem(item); setDeactivateError(null) }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-3 md:hidden">
            {items.map((item) => (
              <article key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-words font-semibold text-slate-950">{item.name}</h3>
                    <p className="mt-1 text-xs capitalize text-slate-500">{item.kind}</p>
                  </div>
                  <StatusBadge active={item.isActive} />
                </div>
                <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-5 text-slate-600">{item.description || 'No description'}</p>
                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm">
                  <div>
                    <dt className="text-xs font-medium text-slate-500">Price</dt>
                    <dd className="mt-1 font-medium text-slate-800">{item.priceInPaise === undefined ? '—' : formatRupees(item.priceInPaise)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-slate-500">Availability</dt>
                    <dd className="mt-1 break-words text-slate-700">{item.availability || '—'}</dd>
                  </div>
                </dl>
                <div className="mt-4 flex justify-end border-t border-slate-100 pt-3">
                  <ItemActions item={item} onEdit={() => { setActiveForm({ item }); setSuccessMessage(null) }} onDeactivate={() => { setDeactivateItem(item); setDeactivateError(null) }} />
                </div>
              </article>
            ))}
          </div>

          <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <p className="text-sm text-slate-600">
              Page {pagination?.page ?? page} of {displayTotalPages} · {pagination?.totalItems ?? 0} total
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                className="rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={page >= displayTotalPages || loading}
                onClick={() => setPage((current) => Math.min(displayTotalPages, current + 1))}
                className="rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-medium text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}

      {activeForm && (
        <CatalogItemForm
          item={activeForm.item}
          onClose={() => setActiveForm(null)}
          onSave={handleSave}
        />
      )}

      {deactivateItem && (
        <DeactivateDialog
          item={deactivateItem}
          saving={deactivating}
          error={deactivateError}
          onCancel={() => { if (!deactivating) setDeactivateItem(null) }}
          onConfirm={confirmDeactivation}
        />
      )}
    </div>
  )
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${active ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
      {active ? 'Active' : 'Inactive'}
    </span>
  )
}

function ItemActions({
  item,
  onEdit,
  onDeactivate,
}: {
  item: CatalogItem
  onEdit: () => void
  onDeactivate: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={onEdit} aria-label={`Edit ${item.name}`} className="rounded-lg px-3 py-2 text-sm font-medium text-emerald-800 outline-none hover:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-1">
        Edit
      </button>
      {item.isActive && (
        <button type="button" onClick={onDeactivate} aria-label={`Deactivate ${item.name}`} className="rounded-lg px-3 py-2 text-sm font-medium text-rose-700 outline-none hover:bg-rose-50 focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-1">
          Deactivate
        </button>
      )}
    </div>
  )
}
