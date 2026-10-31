import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, getBusinessProfile, updateBusinessProfile, type BusinessProfile, type BusinessProfileUpdate } from '../services/api'

type ProfileForm = {
  name: string
  description: string
  industry: string
  phone: string
  email: string
  website: string
  address: string
  timezone: string
}

type ProfileField = keyof ProfileForm
type FieldErrors = Partial<Record<ProfileField, string>>

const emptyForm: ProfileForm = {
  name: '',
  description: '',
  industry: '',
  phone: '',
  email: '',
  website: '',
  address: '',
  timezone: '',
}

const inputClassName =
  'mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10'

function profileToForm(profile: BusinessProfile): ProfileForm {
  return {
    name: profile.name,
    description: profile.description ?? '',
    industry: profile.industry ?? '',
    phone: profile.contactDetails.phone ?? '',
    email: profile.contactDetails.email ?? '',
    website: profile.contactDetails.website ?? '',
    address: profile.contactDetails.address ?? '',
    timezone: profile.timezone ?? '',
  }
}

function validateProfile(form: ProfileForm): FieldErrors {
  const errors: FieldErrors = {}
  if (!form.name.trim()) errors.name = 'Business name is required.'

  const email = form.email.trim()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = 'Enter a valid email address.'
  }

  const website = form.website.trim()
  if (website) {
    try {
      const url = new URL(website)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
        errors.website = 'Enter a valid website URL beginning with http:// or https://.'
      }
    } catch {
      errors.website = 'Enter a valid website URL beginning with http:// or https://.'
    }
  }

  return errors
}

function toUpdateData(form: ProfileForm): BusinessProfileUpdate {
  const update: BusinessProfileUpdate = { name: form.name.trim() }
  const description = form.description.trim()
  const industry = form.industry.trim()
  const phone = form.phone.trim()
  const email = form.email.trim()
  const website = form.website.trim()
  const address = form.address.trim()
  const timezone = form.timezone.trim()

  if (description) update.description = description
  if (industry) update.industry = industry
  if (timezone) update.timezone = timezone

  const contactDetails = {
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    ...(website ? { website } : {}),
    ...(address ? { address } : {}),
  }
  if (Object.keys(contactDetails).length > 0) update.contactDetails = contactDetails

  return update
}

function TextField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  maxLength,
  autoComplete,
  error,
  hint,
  required = false,
}: {
  id: ProfileField
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  maxLength: number
  autoComplete?: string
  error?: string
  hint?: string
  required?: boolean
}) {
  const helpId = error ? `${id}-error` : hint ? `${id}-hint` : undefined

  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium text-slate-800">
        {label}{required && <span className="ml-1 text-rose-600" aria-hidden="true">*</span>}
      </label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        maxLength={maxLength}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={Boolean(error)}
        aria-describedby={helpId}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClassName} ${error ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/10' : ''}`}
      />
      {error && <p id={helpId} className="mt-1.5 text-xs text-rose-700">{error}</p>}
      {!error && hint && <p id={helpId} className="mt-1.5 text-xs leading-5 text-slate-500">{hint}</p>}
    </div>
  )
}

export function BusinessProfilePage() {
  const [profile, setProfile] = useState<BusinessProfile | null>(null)
  const [form, setForm] = useState<ProfileForm>(emptyForm)
  const [savedForm, setSavedForm] = useState<ProfileForm>(emptyForm)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})

  useEffect(() => {
    let isCurrent = true
    setLoading(true)
    setLoadError(null)

    void getBusinessProfile()
      .then((result) => {
        if (!isCurrent) return
        const loadedForm = profileToForm(result.business)
        setProfile(result.business)
        setForm(loadedForm)
        setSavedForm(loadedForm)
      })
      .catch((error: unknown) => {
        if (!isCurrent) return
        setLoadError(
          error instanceof ApiError
            ? error.message
            : 'Unable to load your business profile. Please retry.',
        )
      })
      .finally(() => {
        if (isCurrent) setLoading(false)
      })

    return () => {
      isCurrent = false
    }
  }, [loadAttempt])

  function updateField(field: ProfileField, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: undefined }))
    setSaveError(null)
    setSuccessMessage(null)
  }

  function resetForm() {
    setForm(savedForm)
    setFieldErrors({})
    setSaveError(null)
    setSuccessMessage(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (savingRef.current) return

    const errors = validateProfile(form)
    setFieldErrors(errors)
    setSaveError(null)
    setSuccessMessage(null)
    if (Object.keys(errors).length > 0) return

    savingRef.current = true
    setSaving(true)
    try {
      const result = await updateBusinessProfile(toUpdateData(form))
      const persistedForm = profileToForm(result.business)
      setProfile(result.business)
      setForm(persistedForm)
      setSavedForm(persistedForm)
      setSuccessMessage('Profile saved. Blank optional fields were left unchanged.')
    } catch (error) {
      setSaveError(
        error instanceof ApiError
          ? error.message
          : 'Unable to save your business profile. Please try again.',
      )
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const isDirty = (Object.keys(form) as ProfileField[]).some((field) => form[field] !== savedForm[field])

  if (loading) {
    return (
      <div role="status" aria-live="polite" className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-200 border-t-emerald-700" />
          <p className="text-sm font-medium text-slate-700">Loading business profile…</p>
        </div>
      </div>
    )
  }

  if (loadError || !profile) {
    return (
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold text-rose-700">Profile unavailable</p>
        <h2 className="mt-2 text-xl font-semibold text-slate-950">We couldn’t load your business profile</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">{loadError ?? 'No business profile was returned.'}</p>
        <button
          type="button"
          onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          className="mt-5 rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
        >
          Retry loading
        </button>
      </section>
    )
  }

  return (
    <div className="space-y-6">
      <section>
        <p className="text-sm font-semibold text-emerald-700">Workspace settings</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">Business profile</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Keep your business information accurate for your workspace.
        </p>
      </section>

      <form onSubmit={handleSubmit} noValidate className="space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <div className="mb-6 border-b border-slate-100 pb-4">
            <h3 className="font-semibold text-slate-950">Business details</h3>
            <p className="mt-1 text-sm text-slate-500">Basic information about your business.</p>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <TextField
              id="name"
              label="Business name"
              value={form.name}
              onChange={(value) => updateField('name', value)}
              maxLength={150}
              autoComplete="organization"
              required
              error={fieldErrors.name}
            />
            <TextField
              id="industry"
              label="Industry"
              value={form.industry}
              onChange={(value) => updateField('industry', value)}
              maxLength={100}
              error={fieldErrors.industry}
            />
            <div className="md:col-span-2">
              <label htmlFor="description" className="text-sm font-medium text-slate-800">Description</label>
              <textarea
                id="description"
                name="description"
                value={form.description}
                maxLength={2000}
                rows={4}
                onChange={(event) => updateField('description', event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10"
              />
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <div className="mb-6 border-b border-slate-100 pb-4">
            <h3 className="font-semibold text-slate-950">Contact information</h3>
            <p className="mt-1 text-sm text-slate-500">The contact details customers can use to reach you.</p>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <TextField
              id="phone"
              label="Phone"
              value={form.phone}
              onChange={(value) => updateField('phone', value)}
              type="tel"
              maxLength={40}
              autoComplete="tel"
            />
            <TextField
              id="email"
              label="Email"
              value={form.email}
              onChange={(value) => updateField('email', value)}
              type="email"
              maxLength={254}
              autoComplete="email"
              error={fieldErrors.email}
            />
            <TextField
              id="website"
              label="Website"
              value={form.website}
              onChange={(value) => updateField('website', value)}
              type="url"
              maxLength={2048}
              autoComplete="url"
              error={fieldErrors.website}
              hint="Include https:// or http://."
            />
            <TextField
              id="timezone"
              label="Time zone"
              value={form.timezone}
              onChange={(value) => updateField('timezone', value)}
              maxLength={100}
              hint="Use an IANA name, for example Asia/Kolkata."
            />
            <div className="md:col-span-2">
              <label htmlFor="address" className="text-sm font-medium text-slate-800">Address</label>
              <textarea
                id="address"
                name="address"
                value={form.address}
                maxLength={500}
                rows={3}
                onChange={(event) => updateField('address', event.target.value)}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10"
              />
            </div>
          </div>
          <p className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-sm leading-5 text-amber-900">
            Optional fields cannot be cleared yet. Leave a field blank to keep its saved value unchanged.
          </p>
        </section>

        {saveError && (
          <div role="alert" aria-live="polite" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {saveError}
          </div>
        )}
        {successMessage && (
          <div role="status" aria-live="polite" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {successMessage}
          </div>
        )}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={resetForm}
            disabled={!isDirty || saving}
            className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-700 outline-none transition hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset changes
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-xl bg-emerald-700 px-5 py-3 text-sm font-semibold text-white outline-none transition hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </form>
    </div>
  )
}
