import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ApiError,
  getBusinessAiSettings,
  getBusinessProfile,
  getBusinessWhatsAppSettings,
  updateBusinessAiSettings,
  updateBusinessProfile,
  updateBusinessWhatsAppSettings,
  verifyBusinessWhatsAppSettings,
  type BusinessProfile,
  type BusinessProfileUpdate,
  type BusinessAiSettingsResponse,
  type BusinessWhatsAppSettings,
} from '../services/api'

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
  const [whatsappSettings, setWhatsappSettings] = useState<BusinessWhatsAppSettings | null>(null)
  const [whatsappPhoneNumberId, setWhatsappPhoneNumberId] = useState('')
  const [whatsappDisplayNumber, setWhatsappDisplayNumber] = useState('')
  const [whatsappLoading, setWhatsappLoading] = useState(true)
  const [whatsappLoadError, setWhatsappLoadError] = useState<string | null>(null)
  const [whatsappLoadAttempt, setWhatsappLoadAttempt] = useState(0)
  const [whatsappSaving, setWhatsappSaving] = useState(false)
  const whatsappSavingRef = useRef(false)
  const [whatsappVerifying, setWhatsappVerifying] = useState(false)
  const whatsappVerifyingRef = useRef(false)
  const [whatsappError, setWhatsappError] = useState<string | null>(null)
  const [whatsappSuccess, setWhatsappSuccess] = useState<string | null>(null)
  const [whatsappPhoneNumberIdError, setWhatsappPhoneNumberIdError] = useState<string | null>(null)
  const [whatsappDisplayNumberError, setWhatsappDisplayNumberError] = useState<string | null>(null)
  const [businessAiSettings, setBusinessAiSettings] = useState<BusinessAiSettingsResponse | null>(null)
  const [businessAiSettingsLoading, setBusinessAiSettingsLoading] = useState(true)
  const [businessAiSettingsError, setBusinessAiSettingsError] = useState<string | null>(null)
  const [businessAiSettingsRetry, setBusinessAiSettingsRetry] = useState(0)
  const [businessAiSettingsSaving, setBusinessAiSettingsSaving] = useState(false)
  const businessAiSettingsSavingRef = useRef(false)
  const [businessAiSettingsSuccess, setBusinessAiSettingsSuccess] = useState<string | null>(null)

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

  useEffect(() => {
    let isCurrent = true
    setWhatsappLoading(true)
    setWhatsappLoadError(null)

    void getBusinessWhatsAppSettings()
      .then((result) => {
        if (!isCurrent) return
        setWhatsappSettings(result.whatsapp)
        setWhatsappPhoneNumberId(result.whatsapp.phoneNumberId ?? '')
        setWhatsappDisplayNumber(result.whatsapp.displayNumber ?? '')
      })
      .catch((error: unknown) => {
        if (!isCurrent) return
        setWhatsappLoadError(
          error instanceof ApiError
            ? error.message
            : 'Unable to load WhatsApp number settings. Please retry.',
        )
      })
      .finally(() => {
        if (isCurrent) setWhatsappLoading(false)
      })

    return () => {
      isCurrent = false
    }
  }, [whatsappLoadAttempt])

  useEffect(() => {
    let isCurrent = true
    setBusinessAiSettingsLoading(true)
    setBusinessAiSettingsError(null)

    void getBusinessAiSettings()
      .then((result) => {
        if (isCurrent) setBusinessAiSettings(result)
      })
      .catch((error: unknown) => {
        if (!isCurrent) return
        setBusinessAiSettingsError(
          error instanceof ApiError
            ? error.message
            : 'Unable to load automatic-reply settings. Please retry.',
        )
      })
      .finally(() => {
        if (isCurrent) setBusinessAiSettingsLoading(false)
      })

    return () => {
      isCurrent = false
    }
  }, [businessAiSettingsRetry])

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

  async function handleWhatsAppSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (whatsappSavingRef.current) return

    const phoneNumberId = whatsappPhoneNumberId.trim()
    const displayNumber = whatsappDisplayNumber.trim()
    const phoneNumberIdError = /^\d{1,32}$/.test(phoneNumberId)
      ? null
      : 'Enter a Phone Number ID containing digits only.'
    const displayNumberError = displayNumber && !/^\+?[1-9]\d{6,14}$/.test(displayNumber)
      ? 'Enter an international phone number with 7–15 digits and an optional leading +.'
      : null

    setWhatsappPhoneNumberIdError(phoneNumberIdError)
    setWhatsappDisplayNumberError(displayNumberError)
    setWhatsappError(null)
    setWhatsappSuccess(null)
    if (phoneNumberIdError || displayNumberError) return

    whatsappSavingRef.current = true
    setWhatsappSaving(true)
    try {
      const result = await updateBusinessWhatsAppSettings({
        phoneNumberId,
        ...(displayNumber ? { displayNumber } : {}),
      })
      setWhatsappSettings(result.whatsapp)
      setWhatsappPhoneNumberId(result.whatsapp.phoneNumberId ?? '')
      setWhatsappDisplayNumber(result.whatsapp.displayNumber ?? '')
      setWhatsappSuccess('WhatsApp number settings saved. Verify the saved configuration separately.')
    } catch (error) {
      setWhatsappError(
        error instanceof ApiError
          ? error.message
          : 'Unable to save WhatsApp number settings. Please try again.',
      )
    } finally {
      whatsappSavingRef.current = false
      setWhatsappSaving(false)
    }
  }

  async function handleWhatsAppVerify() {
    if (whatsappVerifyingRef.current || whatsappSavingRef.current || !whatsappSettings?.phoneNumberId) return
    whatsappVerifyingRef.current = true
    setWhatsappVerifying(true)
    setWhatsappError(null)
    setWhatsappSuccess(null)
    setWhatsappSettings((current) => current ? {
      ...current,
      connectionStatus: 'verification_pending',
      verifiedPhoneNumberId: undefined,
      lastVerificationAt: undefined,
      verificationFailureCategory: undefined,
      verifiedDisplayNumber: undefined,
      verifiedName: undefined,
      qualityRating: undefined,
    } : current)

    try {
      const result = await verifyBusinessWhatsAppSettings()
      setWhatsappSettings(result.whatsapp)
      setWhatsappSuccess(result.message)
    } catch (error) {
      if (error instanceof ApiError && [422, 502, 504].includes(error.status ?? 0)) {
        setWhatsappSettings((current) => current ? { ...current, connectionStatus: 'verification_failed' } : current)
      } else {
        setWhatsappSettings((current) => current ? { ...current, connectionStatus: 'configured_not_verified' } : current)
      }
      setWhatsappError(
        error instanceof ApiError
          ? error.message
          : 'Unable to verify the WhatsApp configuration. Please try again.',
      )
    } finally {
      whatsappVerifyingRef.current = false
      setWhatsappVerifying(false)
    }
  }

  async function handleAutomaticRepliesChange(enabled: boolean) {
    const current = businessAiSettings
    if (!current || businessAiSettingsSavingRef.current) return
    if (enabled && !current.automaticSendAvailable) return
    if (enabled && !window.confirm(
      'Enable automatic replies for this business? Eligible AI Automatic conversations may send messages to customers without per-message owner approval. Unsupported questions will be escalated for review, and you can switch a conversation to Human mode at any time.',
    )) return

    businessAiSettingsSavingRef.current = true
    setBusinessAiSettingsSaving(true)
    setBusinessAiSettingsError(null)
    setBusinessAiSettingsSuccess(null)
    try {
      const saved = await updateBusinessAiSettings({ automaticRepliesEnabled: enabled })
      setBusinessAiSettings(saved)
      setBusinessAiSettingsSuccess(enabled
        ? 'Automatic-reply opt-in saved. Choose AI Automatic per conversation to make it eligible.'
        : 'Automatic-reply opt-in disabled for this business.')
      try {
        const refreshed = await getBusinessAiSettings()
        setBusinessAiSettings(refreshed)
      } catch {
        setBusinessAiSettingsError('Your setting was saved, but its latest status could not be refreshed. Retry to confirm current availability.')
      }
    } catch (error) {
      setBusinessAiSettingsError(
        error instanceof ApiError
          ? error.message
          : 'Unable to update automatic-reply settings. Please try again.',
      )
    } finally {
      businessAiSettingsSavingRef.current = false
      setBusinessAiSettingsSaving(false)
    }
  }

  const isDirty = (Object.keys(form) as ProfileField[]).some((field) => form[field] !== savedForm[field])
  const savedPhoneNumberId = whatsappSettings?.phoneNumberId ?? ''
  const whatsappNumberChanged = whatsappPhoneNumberId.trim() !== savedPhoneNumberId
  const displayedWhatsAppStatus = !whatsappPhoneNumberId.trim()
    ? 'not_configured'
    : whatsappNumberChanged
      ? 'configured_not_verified'
      : whatsappSettings?.connectionStatus ?? 'configured_not_verified'
  const hasCurrentVerification = displayedWhatsAppStatus === 'verified' &&
    whatsappSettings?.verifiedPhoneNumberId === savedPhoneNumberId &&
    !whatsappNumberChanged
  const automaticRepliesSettings = businessAiSettings?.aiSettings
  const automaticRepliesLastChangedAt = automaticRepliesSettings?.automaticRepliesEnabled
    ? automaticRepliesSettings.automaticRepliesEnabledAt ?? automaticRepliesSettings.automaticRepliesDisabledAt
    : automaticRepliesSettings?.automaticRepliesDisabledAt ?? automaticRepliesSettings?.automaticRepliesEnabledAt

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

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <div className="mb-6 flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 className="font-semibold text-slate-950">WhatsApp Cloud API</h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
              Configure the one WhatsApp Business number used by this workspace. Credentials remain on the backend.
            </p>
          </div>
          <span className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${
            displayedWhatsAppStatus === 'verified'
              ? 'bg-emerald-50 text-emerald-800'
              : displayedWhatsAppStatus === 'verification_failed'
                ? 'bg-rose-50 text-rose-800'
                : displayedWhatsAppStatus === 'verification_pending'
                  ? 'bg-sky-50 text-sky-800'
                  : displayedWhatsAppStatus === 'configured_not_verified'
                    ? 'bg-amber-50 text-amber-800'
                    : 'bg-slate-100 text-slate-600'
          }`}>
            {whatsappLoading ? 'Loading status…' :
              displayedWhatsAppStatus === 'verified' ? 'Verified' :
                displayedWhatsAppStatus === 'verification_failed' ? 'Verification failed' :
                  displayedWhatsAppStatus === 'verification_pending' ? 'Verifying…' :
                    displayedWhatsAppStatus === 'configured_not_verified' ? 'Configured — not verified' : 'Not configured'}
          </span>
        </div>

        {whatsappLoading ? (
          <div role="status" aria-live="polite" className="py-4 text-sm text-slate-600">
            Loading WhatsApp number settings…
          </div>
        ) : whatsappLoadError ? (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4">
            <p className="text-sm text-rose-800">{whatsappLoadError}</p>
            <button
              type="button"
              onClick={() => setWhatsappLoadAttempt((attempt) => attempt + 1)}
              className="mt-3 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-rose-800 outline-none hover:bg-rose-100 focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
            >
              Retry loading
            </button>
          </div>
        ) : (
          <form onSubmit={(event) => void handleWhatsAppSubmit(event)} noValidate className="space-y-5">
            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <label htmlFor="whatsapp-phone-number-id" className="text-sm font-medium text-slate-800">
                  WhatsApp Phone Number ID <span className="text-rose-600" aria-hidden="true">*</span>
                </label>
                <input
                  id="whatsapp-phone-number-id"
                  name="phoneNumberId"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  required
                  maxLength={32}
                  value={whatsappPhoneNumberId}
                  onChange={(event) => {
                    setWhatsappPhoneNumberId(event.target.value)
                    setWhatsappPhoneNumberIdError(null)
                    setWhatsappError(null)
                    setWhatsappSuccess(null)
                  }}
                  aria-invalid={Boolean(whatsappPhoneNumberIdError)}
                  aria-describedby={whatsappPhoneNumberIdError ? 'whatsapp-phone-number-id-error' : 'whatsapp-phone-number-id-hint'}
                  className={`${inputClassName} ${whatsappPhoneNumberIdError ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/10' : ''}`}
                />
                {whatsappPhoneNumberIdError
                  ? <p id="whatsapp-phone-number-id-error" className="mt-1.5 text-xs text-rose-700">{whatsappPhoneNumberIdError}</p>
                  : <p id="whatsapp-phone-number-id-hint" className="mt-1.5 text-xs leading-5 text-slate-500">Digits only, as shown in your Meta WhatsApp configuration.</p>}
              </div>
              <div>
                <label htmlFor="whatsapp-display-number" className="text-sm font-medium text-slate-800">Display phone number (optional)</label>
                <input
                  id="whatsapp-display-number"
                  name="displayNumber"
                  type="tel"
                  autoComplete="tel"
                  maxLength={16}
                  placeholder="+919876543210"
                  value={whatsappDisplayNumber}
                  onChange={(event) => {
                    setWhatsappDisplayNumber(event.target.value)
                    setWhatsappDisplayNumberError(null)
                    setWhatsappError(null)
                    setWhatsappSuccess(null)
                  }}
                  aria-invalid={Boolean(whatsappDisplayNumberError)}
                  aria-describedby={whatsappDisplayNumberError ? 'whatsapp-display-number-error' : 'whatsapp-display-number-hint'}
                  className={`${inputClassName} ${whatsappDisplayNumberError ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/10' : ''}`}
                />
                {whatsappDisplayNumberError
                  ? <p id="whatsapp-display-number-error" className="mt-1.5 text-xs text-rose-700">{whatsappDisplayNumberError}</p>
                  : <p id="whatsapp-display-number-hint" className="mt-1.5 text-xs leading-5 text-slate-500">International format, for example +919876543210. Leave blank to keep the saved display number.</p>}
              </div>
            </div>

            {whatsappError && <div role="alert" aria-live="polite" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">{whatsappError}</div>}
            {whatsappSuccess && <div role="status" aria-live="polite" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{whatsappSuccess}</div>}

            {hasCurrentVerification && whatsappSettings && (
              <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-sm text-emerald-950">
                <p className="font-medium">Meta confirmed this Phone Number ID.</p>
                {whatsappSettings.verifiedDisplayNumber && <p className="mt-1">Verified number: {whatsappSettings.verifiedDisplayNumber}</p>}
                {whatsappSettings.verifiedName && <p className="mt-1">Verified name: {whatsappSettings.verifiedName}</p>}
                {whatsappSettings.qualityRating && <p className="mt-1">Quality rating: {whatsappSettings.qualityRating}</p>}
              </div>
            )}
            {displayedWhatsAppStatus === 'verification_failed' && whatsappSettings?.verificationFailureCategory && (
              <p className="text-sm text-rose-800">Verification issue: {whatsappSettings.verificationFailureCategory.replaceAll('_', ' ')}.</p>
            )}
            {whatsappSettings?.lastVerificationAt && (
              <p className="text-xs text-slate-600">Last verification attempt: {new Date(whatsappSettings.lastVerificationAt).toLocaleString()}.</p>
            )}

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-xs leading-5 text-slate-500">
                Saving settings does not verify Meta access. Verification checks number metadata only and never sends a message. Save the current Phone Number ID before verifying. A verified status reflects the last check; token or permission changes require another verification.
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                <button
                  type="button"
                  onClick={() => void handleWhatsAppVerify()}
                  disabled={whatsappVerifying || whatsappSaving || whatsappLoading || !savedPhoneNumberId || whatsappNumberChanged}
                  className="shrink-0 rounded-xl border border-emerald-700 bg-white px-5 py-3 text-sm font-semibold text-emerald-800 outline-none transition hover:bg-emerald-50 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {whatsappVerifying ? 'Verifying…' : 'Verify connection'}
                </button>
                <button
                  type="submit"
                  disabled={whatsappSaving || !whatsappPhoneNumberId.trim()}
                  className="shrink-0 rounded-xl bg-emerald-700 px-5 py-3 text-sm font-semibold text-white outline-none transition hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {whatsappSaving ? 'Saving…' : 'Save WhatsApp settings'}
                </button>
              </div>
            </div>
          </form>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7" aria-labelledby="automatic-replies-heading">
        <div className="mb-6 flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h3 id="automatic-replies-heading" className="font-semibold text-slate-950">Automatic replies</h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
              Business opt-in is separate from choosing AI Automatic for an individual conversation.
            </p>
          </div>
          <span className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${
            businessAiSettingsLoading
              ? 'bg-slate-100 text-slate-600'
              : businessAiSettings?.automaticSendAvailable
                ? 'bg-emerald-50 text-emerald-800'
                : 'bg-amber-50 text-amber-900'
          }`}>
            {businessAiSettingsLoading
              ? 'Checking platform…'
              : businessAiSettings?.automaticSendAvailable
                ? 'Platform available'
                : 'Platform unavailable'}
          </span>
        </div>

        {businessAiSettingsLoading ? (
          <div role="status" aria-live="polite" className="py-3 text-sm text-slate-600">Loading automatic-reply settings…</div>
        ) : businessAiSettingsError && !businessAiSettings ? (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-4">
            <p className="text-sm text-rose-800">{businessAiSettingsError}</p>
            <button type="button" onClick={() => setBusinessAiSettingsRetry((attempt) => attempt + 1)} className="mt-3 rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-rose-800 outline-none hover:bg-rose-100 focus-visible:ring-2 focus-visible:ring-rose-600">
              Retry loading
            </button>
          </div>
        ) : businessAiSettings ? (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Platform authorization</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {businessAiSettings.automaticSendAvailable ? 'Available' : 'Unavailable'}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  {businessAiSettings.automaticSendAvailable
                    ? 'The application currently permits eligible automatic replies.'
                    : 'The application-level automatic-send gate is off. Enabling business opt-in cannot make automatic sending available.'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Business owner opt-in</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {businessAiSettings.aiSettings.automaticRepliesEnabled ? 'Enabled' : 'Disabled'}
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  This records your workspace consent. A conversation must also be set to AI Automatic before it is eligible.
                </p>
              </div>
            </div>

            {!businessAiSettings.automaticSendAvailable && (
              <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-5 text-amber-950" role="status">
                Automatic replies are unavailable because the platform gate is off. You can still disable an existing business opt-in.
              </p>
            )}

            <div className="flex flex-col gap-4 rounded-xl border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-2xl">
                <label htmlFor="automatic-replies-opt-in" className="text-sm font-semibold text-slate-900">Allow automatic replies for this business</label>
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  Eligible AI Automatic conversations may send without per-message approval. Unsupported questions are escalated, and Human mode remains available for immediate takeover.
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  Safety policy: {automaticRepliesSettings?.automaticRepliesPolicyVersion ? 'configured' : 'not reported'}.
                  {' '}Last opt-in change: {automaticRepliesLastChangedAt
                    ? new Date(automaticRepliesLastChangedAt).toLocaleString()
                    : 'not recorded'}.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs font-medium text-slate-600">{businessAiSettings.aiSettings.automaticRepliesEnabled ? 'Enabled' : 'Disabled'}</span>
                <input
                  id="automatic-replies-opt-in"
                  type="checkbox"
                  checked={businessAiSettings.aiSettings.automaticRepliesEnabled}
                  onChange={(event) => void handleAutomaticRepliesChange(event.target.checked)}
                  disabled={businessAiSettingsSaving || (businessAiSettings.automaticSendAvailable === false && !businessAiSettings.aiSettings.automaticRepliesEnabled)}
                  aria-describedby="automatic-replies-opt-in-hint"
                  className="h-5 w-5 accent-emerald-700 disabled:cursor-not-allowed"
                />
                <span id="automatic-replies-opt-in-hint" className="sr-only">Enabling requires confirmation and platform availability.</span>
              </div>
            </div>

            {businessAiSettingsError && <div role="alert" aria-live="polite" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">{businessAiSettingsError}</div>}
            {businessAiSettingsSuccess && <div role="status" aria-live="polite" className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{businessAiSettingsSuccess}</div>}
            {businessAiSettingsError && (
              <button type="button" onClick={() => setBusinessAiSettingsRetry((attempt) => attempt + 1)} disabled={businessAiSettingsLoading || businessAiSettingsSaving} className="rounded-lg border border-slate-200 px-3.5 py-2 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-50">
                Refresh settings
              </button>
            )}
            {businessAiSettingsSaving && <p role="status" className="text-sm text-slate-600">Saving owner opt-in…</p>}
          </div>
        ) : null}
      </section>
    </div>
  )
}
