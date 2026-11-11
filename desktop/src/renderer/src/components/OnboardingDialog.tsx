import React, { useEffect, useMemo, useState } from 'react'
import { Compass, Loader2 } from 'lucide-react'
import { t } from '../i18n'
import type { TeacherProfile, TeacherProfileFields } from '../types'

/**
 * The profile draft keeps the two list fields as the comma-separated text the
 * teacher typed, so a trailing separator or a half-typed class name is not
 * destroyed while they type. Only the save path splits it into the store's
 * lists.
 */
export interface ProfileDraft {
  name: string
  subjects: string
  classes: string
  textbook: string
  school: string
}

export const draftFromProfile = (profile?: TeacherProfile | null): ProfileDraft => ({
  name: profile?.name || '',
  subjects: (profile?.subjects || []).join('、'),
  classes: (profile?.classes || []).join('、'),
  textbook: profile?.textbook || '',
  school: profile?.school || '',
})

/** Accept the separators the dialog's hint shows, plus the ASCII comma. */
export const splitLabels = (text: string): string[] => {
  const seen: string[] = []
  for (const part of text.split(/[,，、;；]+/)) {
    const label = part.trim()
    if (label && !seen.includes(label)) seen.push(label)
  }
  return seen
}

export const draftToFields = (draft: ProfileDraft): TeacherProfileFields => ({
  name: draft.name.trim(),
  subjects: splitLabels(draft.subjects),
  classes: splitLabels(draft.classes),
  textbook: draft.textbook.trim(),
  school: draft.school.trim(),
})

interface ProfileFieldsFormProps {
  value: ProfileDraft
  onChange: (next: ProfileDraft) => void
  disabled?: boolean
  /** Prefix for input ids; two forms can be on screen in different views. */
  idPrefix: string
  /** The name field is focused when the form opens (the dialog only). */
  autoFocusName?: boolean
}

/** The five profile inputs, shared by the first-run dialog and settings. */
export const ProfileFieldsForm: React.FC<ProfileFieldsFormProps> = ({
  value,
  onChange,
  disabled,
  idPrefix,
  autoFocusName,
}) => {
  const classes = useMemo(() => splitLabels(value.classes), [value.classes])
  const set = (patch: Partial<ProfileDraft>) => onChange({ ...value, ...patch })

  return (
    <div className="twb-form-body">
      <label className="twb-field" htmlFor={`${idPrefix}-name`}>
        <span>
          {t('tw_profile_name')}
          <b className="twb-required">*</b>
        </span>
        <input
          id={`${idPrefix}-name`}
          className="twb-input"
          value={value.name}
          maxLength={20}
          disabled={disabled}
          autoFocus={autoFocusName}
          placeholder={t('tw_profile_name_ph')}
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>

      <label className="twb-field" htmlFor={`${idPrefix}-subjects`}>
        <span>{t('tw_profile_subjects')}</span>
        <input
          id={`${idPrefix}-subjects`}
          className="twb-input"
          value={value.subjects}
          disabled={disabled}
          placeholder={t('tw_profile_subjects_ph')}
          onChange={(e) => set({ subjects: e.target.value })}
        />
      </label>

      <label className="twb-field" htmlFor={`${idPrefix}-classes`}>
        <span>{t('tw_profile_classes')}</span>
        <input
          id={`${idPrefix}-classes`}
          className="twb-input"
          value={value.classes}
          disabled={disabled}
          placeholder={t('tw_profile_classes_ph')}
          onChange={(e) => set({ classes: e.target.value })}
        />
      </label>
      {classes.length > 0 && (
        <div className="twb-profile-pills" aria-live="polite">
          {classes.map((label) => (
            <span key={label} className="twb-profile-pill">
              {label}
            </span>
          ))}
        </div>
      )}
      <p className="twb-hint">{t('tw_profile_classes_hint')}</p>

      <div className="twb-field-row">
        <label className="twb-field" htmlFor={`${idPrefix}-textbook`}>
          <span>{t('tw_profile_textbook')}</span>
          <input
            id={`${idPrefix}-textbook`}
            className="twb-input"
            value={value.textbook}
            maxLength={40}
            disabled={disabled}
            placeholder={t('tw_profile_textbook_ph')}
            onChange={(e) => set({ textbook: e.target.value })}
          />
        </label>
        <label className="twb-field" htmlFor={`${idPrefix}-school`}>
          <span>{t('tw_profile_school')}</span>
          <input
            id={`${idPrefix}-school`}
            className="twb-input"
            value={value.school}
            maxLength={40}
            disabled={disabled}
            placeholder={t('tw_profile_school_ph')}
            onChange={(e) => set({ school: e.target.value })}
          />
        </label>
      </div>
    </div>
  )
}

interface OnboardingDialogProps {
  open: boolean
  initial: TeacherProfile | null
  busy: boolean
  /** The save error, already localized by the caller. */
  error: string
  onSave: (fields: TeacherProfileFields) => void
}

/**
 * The first-run dialog. It has no close control and ignores the scrim: the
 * profile is what lets the Backend and the model address the teacher by name,
 * so it is answered once rather than dismissed. A failed save keeps the dialog
 * open with the reason, and the same button retries.
 */
const OnboardingDialog: React.FC<OnboardingDialogProps> = ({ open, initial, busy, error, onSave }) => {
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(initial))
  const [nameError, setNameError] = useState('')

  useEffect(() => {
    if (!open) return
    setDraft(draftFromProfile(initial))
    setNameError('')
  }, [open, initial])

  if (!open) return null

  const save = () => {
    if (!draft.name.trim()) {
      setNameError(t('tw_profile_name_required'))
      return
    }
    setNameError('')
    onSave(draftToFields(draft))
  }

  return (
    <div className="twb-modal" role="presentation">
      <div className="twb-modal-scrim" />
      <div
        className="twb-modal-card twb-onboarding-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="twb-onboarding-title"
        aria-describedby="twb-onboarding-desc"
      >
        <div className="twb-onboarding-head">
          <span className="twb-onboarding-badge" aria-hidden="true">
            <Compass size={18} />
          </span>
          <div>
            <h2 id="twb-onboarding-title">{t('tw_onboarding_title')}</h2>
            <p id="tw-onboarding-desc">{t('tw_onboarding_desc')}</p>
          </div>
        </div>

        <ProfileFieldsForm
          value={draft}
          onChange={setDraft}
          disabled={busy}
          idPrefix="twb-onboarding"
          autoFocusName
        />
        {nameError && <p className="twb-status is-error">{nameError}</p>}
        {error && <p className="twb-status is-error">{error}</p>}

        <div className="twb-modal-actions">
          <button type="button" className="twb-btn twb-btn-primary" disabled={busy} onClick={save}>
            {busy ? <Loader2 size={14} className="twb-spin" /> : null}
            <span>{busy ? t('tw_onboarding_saving') : t('tw_onboarding_save')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}

export default OnboardingDialog
