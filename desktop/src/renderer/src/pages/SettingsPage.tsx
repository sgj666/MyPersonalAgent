import React, { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Loader2, UserRound } from 'lucide-react'
import { t, tf } from '../i18n'
import { product } from '@product'
import apiClient from '../api/client'
import {
  draftFromProfile,
  draftToFields,
  ProfileFieldsForm,
  type ProfileDraft,
} from '../components/OnboardingDialog'
import { Card } from './settings/primitives'
import BasicSettings from './settings/BasicSettings'
import ModelsTab from './settings/ModelsTab'
import IntegrationsTab from './settings/IntegrationsTab'

interface SettingsPageProps {
  baseUrl: string
  onLangChange?: () => void
}

type Tab = 'basic' | 'models' | 'integrations'

/**
 * 「我的信息」: the same document the first-run dialog writes, editable later.
 * Saving also re-writes the Agent's USER.md block, which is why the success
 * line names that file rather than just saying "saved".
 */
const TeacherProfileCard: React.FC<{ baseUrl: string }> = ({ baseUrl }) => {
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(null))
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    apiClient.setBaseUrl(baseUrl)
    apiClient
      .getTeachingProfile()
      .then((profile) => {
        if (!alive) return
        setDraft(draftFromProfile(profile))
        setError('')
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [baseUrl])

  const save = async () => {
    if (busy) return
    if (!draft.name.trim()) {
      setStatus('')
      setError(t('tw_profile_name_required'))
      return
    }
    setBusy(true)
    setStatus('')
    setError('')
    try {
      const result = await apiClient.saveTeachingProfile(draftToFields(draft))
      setStatus(
        result.synced
          ? t('tw_settings_profile_synced')
          : tf('tw_settings_profile_unsynced', { path: result.path })
      )
    } catch (err) {
      setError(tf('tw_profile_save_failed', { msg: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card icon={<UserRound size={16} />} title={t('tw_settings_profile_title')} subtitle={t('tw_settings_profile_desc')}>
      {loading ? (
        <p className="text-sm text-content-tertiary">{t('tw_loading')}</p>
      ) : (
        <>
          <div className="twb-profile-form">
            <ProfileFieldsForm value={draft} onChange={setDraft} disabled={busy} idPrefix="twb-settings-profile" />
          </div>
          {error && <p className="text-xs text-danger mt-2">{error}</p>}
          <div className="flex items-center justify-end gap-3 pt-3">
            <span className="text-xs text-accent">{status}</span>
            <button
              type="button"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-btn bg-accent text-accent-contrast hover:bg-accent-hover text-sm font-medium cursor-pointer transition-colors disabled:opacity-60"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? <Loader2 size={14} className="twb-spin" /> : null}
              <span>{t('tw_settings_profile_save')}</span>
            </button>
          </div>
        </>
      )}
    </Card>
  )
}

const SettingsPage: React.FC<SettingsPageProps> = ({ baseUrl, onLangChange }) => {
  const location = useLocation()
  const navigate = useNavigate()
  const modelsTabHidden = product.models?.hideModelsTab === true
  // Deep links: /settings?tab=models, /settings?tab=integrations. The tab also
  // lives in the URL so a remount (e.g. after a backend restart) keeps it.
  const requested = new URLSearchParams(location.search).get('tab')
  const initial: Tab =
    requested === 'integrations' ? 'integrations' : !modelsTabHidden && requested === 'models' ? 'models' : 'basic'
  const [tab, setTab] = useState<Tab>(initial)
  const [focusPassword, setFocusPassword] = useState(false)

  const switchTab = (next: Tab) => {
    setTab(next)
    navigate({ search: next === 'basic' ? '' : `?tab=${next}` }, { replace: true })
  }

  const clearFocusPassword = useCallback(() => setFocusPassword(false), [])

  const tabs: { key: Tab; label: string }[] = [
    { key: 'basic', label: t('settings_tab_basic') },
    ...(modelsTabHidden ? [] : [{ key: 'models' as Tab, label: t('settings_tab_models') }]),
    { key: 'integrations', label: t('settings_tab_integrations') },
  ]

  return (
    <div className="clay-legacy flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto">
        <div className="clay-head clay-head-flat mb-5">
          <h2 className="clay-head-title text-xl font-bold text-content">{t('menu_settings')}</h2>
          <p className="clay-head-desc text-sm text-content-tertiary mt-1">{t('config_desc')}</p>
        </div>

        {/* Tab bar */}
        <div className="clay-tabs clay-tabs-bare flex items-center gap-1 mb-6 border-b border-default">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => switchTab(tb.key)}
              className={`clay-tab relative px-4 py-2.5 text-sm font-medium cursor-pointer transition-colors -mb-px border-b-2 ${
                tab === tb.key
                  ? 'clay-tab-on text-accent border-accent'
                  : 'text-content-tertiary border-transparent hover:text-content-secondary'
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        {tab === 'integrations' ? (
          <IntegrationsTab
            baseUrl={baseUrl}
            onGoToPassword={() => {
              switchTab('basic')
              setFocusPassword(true)
            }}
          />
        ) : tab === 'models' && !modelsTabHidden ? (
          <ModelsTab baseUrl={baseUrl} />
        ) : (
          <div className="grid gap-5">
            <TeacherProfileCard baseUrl={baseUrl} />
            <BasicSettings
              baseUrl={baseUrl}
              onLangChange={onLangChange}
              onOpenModels={modelsTabHidden ? undefined : () => switchTab('models')}
              focusPassword={focusPassword}
              onPasswordFocused={clearFocusPassword}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default SettingsPage
