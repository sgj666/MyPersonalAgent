/* Video download page: paste a link, read what is behind it, download with
 * live progress, then play it in place. The account card below the paste box
 * is the only place a user has to sign in, and only when a platform asks for
 * it (Bilibili HD, a note behind a login wall).
 *
 * The layout mirrors the console's view (docs/plans/video-download-ui.html):
 * one stage card that changes state without moving, and a right column with
 * access, platform support and the disclaimer. */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Film, FolderOpen, Link2, Play, RotateCw, Trash2, X } from 'lucide-react'
import apiClient from '../api/client'
import type { VideoItem, VideoProbe, VideoStatus } from '../api/client'
import { t } from '../i18n'

type Stage = 'idle' | 'probing' | 'ready' | 'downloading' | 'done' | 'error'

interface ProgressState {
  percent: number
  downloaded: number
  total: number
  speed: string
  eta: string
}

const PLATFORM_STYLE: Record<string, string> = {
  douyin: 'bg-[#FFE6EA] text-[#8E3B49]',
  xiaohongshu: 'bg-[#FFE9DC] text-[#96482A]',
  bilibili: 'bg-[#E7F0FA] text-[#2E6FA3]',
}

const PLATFORM_LABEL: Record<string, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  bilibili: 'B 站',
}

function fmtBytes(size?: number | null): string {
  if (!size) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = Number(size)
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return (i === 0 ? String(value) : value.toFixed(1)) + ' ' + units[i]
}

function fmtClock(seconds?: number | null): string {
  if (seconds == null || Number.isNaN(Number(seconds))) return ''
  const total = Math.round(Number(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
}

/** The id inside a downloaded file name names its platform. */
function platformOfFile(name: string): string {
  // Duplicates land as `title [id] (2).mp4`, so the suffix has to be optional.
  const match = /\[([A-Za-z0-9]+)\](?:\s*\(\d+\))?\.\w+$/.exec(name || '')
  const id = match ? match[1] : ''
  if (/^BV/i.test(id)) return 'bilibili'
  if (/^[0-9a-f]{24}$/i.test(id)) return 'xiaohongshu'
  // Douyin's aweme_id is 19 digits; a bare short number is Bilibili's `aid`.
  if (/^\d{15,}$/.test(id)) return 'douyin'
  if (/^\d{1,10}$/.test(id)) return 'bilibili'
  return ''
}

const ERROR_COPY: Record<string, [string, string]> = {
  needs_login: ['tw_video_err_login_title', 'tw_video_err_login_body'],
  no_browser: ['tw_video_err_browser_title', 'tw_video_err_browser_body'],
  not_found: ['tw_video_err_notfound_title', 'tw_video_err_notfound_body'],
  not_video: ['tw_video_err_notvideo_title', 'tw_video_err_notvideo_body'],
  unsupported: ['tw_video_err_unsupported_title', 'tw_video_err_unsupported_body'],
  unsupported_url: ['tw_video_err_unsupported_title', 'tw_video_err_unsupported_body'],
  no_link: ['tw_video_err_unsupported_title', 'tw_video_err_unsupported_body'],
}

const VideoPage: React.FC<{ baseUrl: string }> = ({ baseUrl }) => {
  const [stage, setStage] = useState<Stage>('idle')
  const [link, setLink] = useState('')
  const [quality, setQuality] = useState('best')
  const [info, setInfo] = useState<VideoProbe | null>(null)
  const [status, setStatus] = useState<VideoStatus | null>(null)
  const [recent, setRecent] = useState<VideoItem[]>([])
  const [progress, setProgress] = useState<ProgressState>({ percent: 0, downloaded: 0, total: 0, speed: '', eta: '' })
  const [result, setResult] = useState<{ path: string; size: number; title: string } | null>(null)
  const [error, setError] = useState<{ code: string; message: string; detail?: string } | null>(null)
  const [loginPlatform, setLoginPlatform] = useState('')
  const [loginState, setLoginState] = useState<{ qr?: string; key?: string; text: string; tone: 'muted' | 'ok' | 'warn' } | null>(null)
  const streamRef = useRef<EventSource | null>(null)
  const pollRef = useRef<number | null>(null)

  // null means "could not ask": either the backend predates this page or the
  // request failed. Both look identical from here, so the pill says which fix
  // applies instead of a bare "not ready".
  const [engineIssue, setEngineIssue] = useState<'missing' | 'installing' | 'stale' | ''>('')
  const statusTimer = useRef<number | null>(null)

  // The backend installs a missing engine on its own; keep asking until it is
  // ready or has given up, so the header resolves without the user doing
  // anything.
  const loadStatus = useCallback(async () => {
    if (statusTimer.current) {
      window.clearTimeout(statusTimer.current)
      statusTimer.current = null
    }
    try {
      const data = await apiClient.getVideoStatus()
      setStatus(data)
      if (data.installing) {
        setEngineIssue('installing')
        statusTimer.current = window.setTimeout(() => {
          void loadStatus()
        }, 2500)
        return
      }
      setEngineIssue(data.ytdlp ? '' : 'missing')
    } catch (e) {
      setStatus(null)
      const message = String((e as Error).message || '')
      setEngineIssue(/404|not found/i.test(message) ? 'stale' : 'missing')
    }
  }, [])

  const loadRecent = useCallback(async () => {
    try {
      const data = await apiClient.getRecentVideos()
      setRecent(data.items || [])
    } catch {
      setRecent([])
    }
  }, [])

  useEffect(() => {
    apiClient.setBaseUrl(baseUrl)
    loadStatus()
    loadRecent()
    return () => {
      streamRef.current?.close()
      if (pollRef.current) window.clearTimeout(pollRef.current)
    }
  }, [baseUrl, loadStatus, loadRecent])

  const closeStream = useCallback(() => {
    streamRef.current?.close()
    streamRef.current = null
  }, [])

  const reset = useCallback(() => {
    closeStream()
    setStage('idle')
    setLink('')
    setInfo(null)
    setResult(null)
    setError(null)
    setProgress({ percent: 0, downloaded: 0, total: 0, speed: '', eta: '' })
  }, [closeStream])

  const parse = useCallback(async () => {
    const text = link.trim()
    if (!text) return
    setStage('probing')
    try {
      const data = await apiClient.probeVideo(text)
      setInfo(data)
      setStage('ready')
    } catch (e) {
      const err = e as Error & { code?: string }
      setError({ code: err.code || 'unknown', message: err.message })
      setStage('error')
    }
  }, [link])

  const download = useCallback(() => {
    const text = link.trim()
    if (!text || streamRef.current) return
    setProgress({ percent: 0, downloaded: 0, total: 0, speed: '', eta: '' })
    setStage('downloading')

    const stream = apiClient.createVideoStream({
      url: text,
      quality,
      source: info?.source,
      title: info?.title,
    })
    streamRef.current = stream

    stream.onmessage = (event) => {
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload.stage === 'download') {
        setProgress({
          percent: Number(payload.percent || 0),
          downloaded: Number(payload.downloaded || 0),
          total: Number(payload.total || 0),
          speed: String(payload.speed || ''),
          eta: String(payload.eta || ''),
        })
      } else if (payload.stage === 'done') {
        closeStream()
        setResult({
          path: String(payload.path || ''),
          size: Number(payload.size || 0),
          title: String(payload.title || ''),
        })
        setStage('done')
        loadRecent()
        loadStatus()
      } else if (payload.stage === 'error') {
        closeStream()
        setError({
          code: String(payload.reason || 'unknown'),
          message: String(payload.message || ''),
          detail: String(payload.detail || ''),
        })
        setStage('error')
      }
    }
    stream.onerror = () => {
      if (stream.readyState === EventSource.CLOSED) {
        closeStream()
        setError({ code: 'network', message: t('tw_video_err_stream_body') })
        setStage('error')
      }
    }
  }, [link, quality, info, closeStream, loadRecent, loadStatus])

  const cancel = useCallback(() => {
    closeStream()
    apiClient.cancelVideo().catch(() => {})
    setProgress({ percent: 0, downloaded: 0, total: 0, speed: '', eta: '' })
    setStage(info ? 'ready' : 'idle')
  }, [closeStream, info])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      window.clearTimeout(pollRef.current)
      pollRef.current = null
    }
    if (loginPlatform && loginPlatform !== 'bilibili') {
      apiClient.videoLoginClose(loginPlatform).catch(() => {})
    }
    setLoginPlatform('')
    setLoginState(null)
  }, [loginPlatform])

  const pollLogin = useCallback(
    (platform: string, key: string) => {
      const tick = async () => {
        try {
          const data = await apiClient.videoLoginPoll(platform, key)
          if (data.state === 'ok') {
            setLoginState({ text: t('tw_video_login_ok'), tone: 'ok' })
            loadStatus()
            window.setTimeout(() => {
              stopPolling()
            }, 900)
            return
          }
          if (data.state === 'expired') {
            setLoginState({ text: t('tw_video_login_expired'), tone: 'warn' })
            return
          }
          setLoginState({
            text: data.state === 'scanned' ? t('tw_video_login_scanned') : t('tw_video_login_waiting'),
            tone: 'muted',
          })
          pollRef.current = window.setTimeout(tick, platform === 'bilibili' ? 1500 : 2500)
        } catch (e) {
          setLoginState({ text: (e as Error).message, tone: 'warn' })
        }
      }
      pollRef.current = window.setTimeout(tick, platform === 'bilibili' ? 800 : 2000)
    },
    [loadStatus, stopPolling]
  )

  const startLogin = useCallback(
    async (platform: string) => {
      setLoginPlatform(platform)
      setLoginState({ text: t('tw_video_login_working'), tone: 'muted' })
      try {
        const data = await apiClient.videoLoginStart(platform)
        const key = data.key || ''
        setLoginState(
          data.qr
            ? { qr: data.qr, key, text: t('tw_video_login_scan'), tone: 'muted' }
            : { text: t('tw_video_login_window_open'), tone: 'muted' }
        )
        pollLogin(platform, key)
      } catch (e) {
        setLoginState({ text: (e as Error).message, tone: 'warn' })
      }
    },
    [pollLogin]
  )

  const logout = useCallback(
    async (platform: string) => {
      try {
        setStatus(await apiClient.videoLogout(platform))
      } catch {
        /* the list simply stays as it was */
      }
    },
    []
  )

  const accounts = status?.accounts || {}
  const errorCopy = error ? ERROR_COPY[error.code] || null : null
  const busy = stage === 'downloading'

  return (
    <div className="h-full overflow-y-auto bg-[#FBF7F3] dark:bg-[#101418]">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-[18px] px-8 py-7 pb-14">
        {/* 页头 */}
        <header className="flex flex-wrap items-end justify-between gap-4 rounded-[20px] border border-[rgba(84,70,60,0.14)] bg-[#EDE6FE] px-6 py-5 dark:border-white/15 dark:bg-[#171C21]">
          <div>
            <h1 className="font-['ZCOOL_QingKe_HuangYou','PingFang_SC',system-ui] text-[32px] leading-none text-[#2A2630] dark:text-[#E9EFF5]">
              {t('tw_video_title')}
            </h1>
            <p className="mt-2 max-w-[560px] text-[13px] font-semibold text-[#6B6371] dark:text-[#A9B5C1]">
              {t('tw_video_desc')}
            </p>
          </div>
          <span className="inline-flex h-8 items-center gap-2 rounded-full border border-[rgba(84,70,60,0.14)] bg-white px-3 text-[11.5px] font-extrabold text-[#6B6371] dark:border-white/15 dark:bg-[#171C21] dark:text-[#A9B5C1]">
            <i className={`h-1.5 w-1.5 rounded-full ${status?.ytdlp ? 'bg-[#2C6B4F]' : 'bg-[#8A6A1F]'}`} />
            {status?.ytdlp
              ? `yt-dlp ${status.version || ''} · ffmpeg ${status.ffmpeg ? '✓' : '✗'}`
              : t(
                  engineIssue === 'stale'
                    ? 'tw_video_engine_stale'
                    : engineIssue === 'installing'
                    ? 'tw_video_engine_installing'
                    : 'tw_video_engine_missing'
                )}
          </span>
        </header>

        {engineIssue && (
          <p className="rounded-xl border border-[#8A6A1F]/25 bg-[#FBF1D9] px-3 py-2 text-[11.5px] font-bold leading-relaxed text-[#8A6A1F] dark:border-[#DFC070]/25 dark:bg-[#33290F] dark:text-[#DFC070]">
            {engineIssue === 'stale'
              ? t('tw_video_engine_stale_hint')
              : engineIssue === 'installing'
              ? t('tw_video_engine_installing_hint')
              : t('tw_video_engine_missing_hint')}
          </p>
        )}

        <div className="grid items-start gap-[22px] xl:grid-cols-[minmax(0,1fr)_312px]">
          <div className="flex min-w-0 flex-col gap-[18px]">
            {/* 主舞台 */}
            <section className="rounded-[18px] border border-[rgba(84,70,60,0.14)] bg-white p-5 shadow-sm dark:border-white/10 dark:bg-[#171C21]">
              {stage === 'idle' && (
                <div>
                  <div className="rounded-2xl border-[1.5px] border-dashed border-[rgba(84,70,60,0.26)] bg-gradient-to-b from-[#F8F3EE]/60 to-transparent p-5 focus-within:border-[#2C6B4F] dark:border-white/20">
                    <div className="mb-2 flex items-center gap-2 text-[10.5px] font-extrabold uppercase tracking-[0.1em] text-[#9A929F]">
                      <Link2 size={14} /> {t('tw_video_paste_label')}
                    </div>
                    <textarea
                      value={link}
                      onChange={(e) => setLink(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') parse()
                      }}
                      rows={3}
                      placeholder={t('tw_video_placeholder')}
                      className="w-full resize-none border-0 bg-transparent text-[14.5px] font-semibold leading-relaxed text-[#2A2630] outline-none placeholder:text-[#9A929F] dark:text-[#E9EFF5]"
                    />
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-1.5 text-[10.5px] font-extrabold">
                        <span className={`rounded-full px-2.5 py-1 ${PLATFORM_STYLE.douyin}`}>抖音</span>
                        <span className={`rounded-full px-2.5 py-1 ${PLATFORM_STYLE.xiaohongshu}`}>小红书</span>
                        <span className={`rounded-full px-2.5 py-1 ${PLATFORM_STYLE.bilibili}`}>B 站</span>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => navigator.clipboard?.readText().then((text) => text && setLink(text.trim())).catch(() => undefined)}
                          className="h-10 rounded-xl border border-[rgba(84,70,60,0.14)] bg-white px-4 text-[13.5px] font-extrabold text-[#2A2630] dark:border-white/15 dark:bg-[#171C21] dark:text-[#E9EFF5]"
                        >
                          {t('tw_video_paste_btn')}
                        </button>
                        <button
                          type="button"
                          disabled={!link.trim()}
                          onClick={parse}
                          className="h-10 rounded-xl bg-[#2C6B4F] px-5 text-[13.5px] font-extrabold text-white disabled:opacity-40 dark:bg-[#58C08C] dark:text-[#07130C]"
                        >
                          {t('tw_video_parse_btn')}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {stage === 'probing' && (
                <div className="animate-pulse space-y-3 py-4">
                  <div className="h-5 w-2/3 rounded bg-[#F6F1EC] dark:bg-[#1D2329]" />
                  <div className="h-3 w-1/3 rounded bg-[#F6F1EC] dark:bg-[#1D2329]" />
                  <div className="h-12 w-full rounded-xl bg-[#F6F1EC] dark:bg-[#1D2329]" />
                  <p className="text-[12px] font-bold text-[#9A929F]">{t('tw_video_parsing')}</p>
                </div>
              )}

              {(stage === 'ready' || stage === 'downloading') && info && (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-4 sm:flex-row">
                    {/* 封面：解析完就把平台封面摆出来，别让这一块空着 */}
                    <span className="relative grid aspect-video w-full shrink-0 place-items-center overflow-hidden rounded-xl border border-[rgba(84,70,60,0.14)] bg-gradient-to-br from-[#F2E9E2] to-[#E9E3F1] text-[#9A929F] sm:w-[220px] dark:border-white/15 dark:from-[#2A2622] dark:to-[#262331]">
                      <Film size={20} />
                      {info.thumbnail && (
                        <img
                          src={apiClient.getVideoThumbUrl(info.thumbnail)}
                          alt=""
                          className="absolute inset-0 h-full w-full object-cover"
                          onError={(e) => {
                            ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                          }}
                        />
                      )}
                      {info.duration ? (
                        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-extrabold tabular-nums text-white">
                          {fmtClock(info.duration)}
                        </span>
                      ) : null}
                    </span>

                    <div className="flex min-w-0 flex-1 flex-col gap-3">
                  <div className="flex items-center gap-3">
                    <span className={`rounded-full px-2.5 py-1 text-[10.5px] font-extrabold ${PLATFORM_STYLE[info.platform] || 'bg-[#F6F1EC] text-[#6B6371]'}`}>
                      {info.label || PLATFORM_LABEL[info.platform] || info.platform}
                    </span>
                    <strong className="min-w-0 flex-1 truncate text-[14px] font-extrabold text-[#2A2630] dark:text-[#E9EFF5]">
                      {info.title}
                    </strong>
                    {busy && (
                      <div className="text-[26px] font-extrabold leading-none text-[#2C6B4F] dark:text-[#58C08C]">
                        {Math.round(progress.percent)}%
                      </div>
                    )}
                  </div>

                  <dl className="flex flex-wrap gap-6 border-y border-[#EDE6E0] py-3 dark:border-white/10">
                    {[
                      [t('tw_video_spec_res'), info.width && info.height ? `${info.width} × ${info.height}` : '—'],
                      [t('tw_video_spec_size'), fmtBytes(info.size)],
                      [t('tw_video_spec_duration'), fmtClock(info.duration) || '—'],
                      [t('tw_video_spec_watermark'), t('tw_video_no')],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-[9.5px] font-extrabold uppercase tracking-[0.1em] text-[#9A929F]">{label}</dt>
                        <dd className="text-[12.5px] font-extrabold tabular-nums text-[#2A2630] dark:text-[#E9EFF5]">{value}</dd>
                      </div>
                    ))}
                  </dl>

                  {busy ? (
                    <div>
                      <div className="h-2.5 overflow-hidden rounded-full bg-[#F6F1EC] dark:bg-[#1D2329]">
                        <div
                          className="h-full rounded-full bg-[#2C6B4F] transition-[width] duration-300 dark:bg-[#58C08C]"
                          style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}
                        />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-6">
                        {[
                          [t('tw_video_downloaded'), progress.downloaded ? fmtBytes(progress.downloaded) : '—'],
                          [t('tw_video_speed'), progress.speed || '—'],
                          [t('tw_video_eta'), progress.eta || '—'],
                        ].map(([label, value]) => (
                          <div key={label}>
                            <div className="text-[9.5px] font-extrabold uppercase tracking-[0.1em] text-[#9A929F]">{label}</div>
                            <div className="text-[13px] font-extrabold tabular-nums text-[#2A2630] dark:text-[#E9EFF5]">{value}</div>
                          </div>
                        ))}
                        <span className="flex-1" />
                        <button
                          type="button"
                          onClick={cancel}
                          className="h-8 rounded-lg px-3 text-[12.5px] font-extrabold text-[#6B6371] hover:bg-[#F6F1EC] dark:text-[#A9B5C1] dark:hover:bg-[#1D2329]"
                        >
                          {t('tw_video_cancel')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="inline-flex rounded-[11px] border border-[rgba(84,70,60,0.14)] bg-[#F6F1EC] p-[3px] dark:border-white/15 dark:bg-[#1D2329]">
                        {['best', '1080', '720', '480'].map((value) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setQuality(value)}
                            aria-pressed={quality === value}
                            className={`rounded-lg px-3 py-1.5 text-[12px] font-extrabold ${
                              quality === value
                                ? 'bg-white text-[#2A2630] shadow-sm dark:bg-[#252C33] dark:text-[#E9EFF5]'
                                : 'text-[#6B6371] dark:text-[#A9B5C1]'
                            }`}
                          >
                            {value === 'best' ? t('tw_video_q_best') : value + 'P'}
                          </button>
                        ))}
                      </div>
                      <span className="flex-1" />
                      <button
                        type="button"
                        onClick={download}
                        className="h-11 rounded-[13px] bg-[#2C6B4F] px-6 text-[14px] font-extrabold text-white dark:bg-[#58C08C] dark:text-[#07130C]"
                      >
                        {t('tw_video_download')}
                      </button>
                    </div>
                  )}
                    </div>
                  </div>
                </div>
              )}

              {stage === 'done' && result && (
                <div>
                  <video
                    src={apiClient.getVideoFileUrl(result.path)}
                    // First frame of the file itself: a black rectangle before
                    // the user presses play reads as "nothing downloaded".
                    poster={apiClient.getVideoPosterUrl(result.path)}
                    controls
                    preload="metadata"
                    className="aspect-video w-full rounded-xl bg-black"
                  />
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="rounded border border-[rgba(84,70,60,0.14)] bg-[#F6F1EC] px-2 py-0.5 text-[9.5px] font-extrabold tracking-wider text-[#6B6371] dark:border-white/15 dark:bg-[#1D2329] dark:text-[#A9B5C1]">
                      MP4
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-bold text-[#6B6371] dark:text-[#A9B5C1]">
                      {result.path.split(/[\\/]/).pop()}
                    </span>
                    <span className="text-[11px] font-bold tabular-nums text-[#9A929F]">{fmtBytes(result.size)}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => apiClient.revealVideo(result.path).catch(() => {})}
                      className="h-8 rounded-lg border border-[rgba(84,70,60,0.14)] px-3 text-[12.5px] font-extrabold text-[#2A2630] dark:border-white/15 dark:text-[#E9EFF5]"
                    >
                      {t('tw_video_open_folder')}
                    </button>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard?.writeText(result.title || result.path).catch(() => {})}
                      className="h-8 rounded-lg px-3 text-[12.5px] font-extrabold text-[#6B6371] hover:bg-[#F6F1EC] dark:text-[#A9B5C1] dark:hover:bg-[#1D2329]"
                    >
                      {t('tw_video_copy_title')}
                    </button>
                    <button
                      type="button"
                      onClick={reset}
                      className="h-8 rounded-lg px-3 text-[12.5px] font-extrabold text-[#6B6371] hover:bg-[#F6F1EC] dark:text-[#A9B5C1] dark:hover:bg-[#1D2329]"
                    >
                      {t('tw_video_again')}
                    </button>
                  </div>
                </div>
              )}

              {stage === 'error' && (
                <div>
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-[11px] bg-[#FBEAE3] text-[15px] font-extrabold text-[#A9452A] dark:bg-[#33201A] dark:text-[#E8A07C]">
                      !
                    </span>
                    <div>
                      <h3 className="text-[14px] font-extrabold text-[#2A2630] dark:text-[#E9EFF5]">
                        {errorCopy ? t(errorCopy[0]) : t('tw_video_err_generic_title')}
                      </h3>
                      <p className="mt-1 max-w-[560px] text-[12.5px] font-semibold leading-relaxed text-[#6B6371] dark:text-[#A9B5C1]">
                        {error?.message || (errorCopy ? t(errorCopy[1]) : t('tw_video_err_generic_body'))}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {(error?.code === 'needs_login' || error?.code === 'no_browser') && (
                      <button
                        type="button"
                        onClick={() => startLogin(info?.platform || 'bilibili')}
                        className="h-8 rounded-lg bg-[#2C6B4F] px-3 text-[12.5px] font-extrabold text-white dark:bg-[#58C08C] dark:text-[#07130C]"
                      >
                        {t('tw_video_login_action')}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={reset}
                      className="h-8 rounded-lg px-3 text-[12.5px] font-extrabold text-[#6B6371] hover:bg-[#F6F1EC] dark:text-[#A9B5C1] dark:hover:bg-[#1D2329]"
                    >
                      {t('tw_video_change')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setStage('ready')
                        download()
                      }}
                      className="h-8 rounded-lg px-3 text-[12.5px] font-extrabold text-[#6B6371] hover:bg-[#F6F1EC] dark:text-[#A9B5C1] dark:hover:bg-[#1D2329]"
                    >
                      {t('tw_video_retry')}
                    </button>
                  </div>
                  {error?.detail && (
                    <details className="mt-3 border-t border-[#EDE6E0] pt-3 dark:border-white/10">
                      <summary className="cursor-pointer text-[11.5px] font-extrabold text-[#9A929F]">
                        {t('tw_video_raw')}
                      </summary>
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-[#F6F1EC] p-2.5 text-[11px] leading-relaxed text-[#6B6371] dark:bg-[#1D2329] dark:text-[#A9B5C1]">
                        {error.detail}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </section>

            {/* 最近下载 */}
            <section className="rounded-[18px] border border-[rgba(84,70,60,0.14)] bg-white p-5 shadow-sm dark:border-white/10 dark:bg-[#171C21]">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[17px] text-[#2A2630] dark:text-[#E9EFF5]">{t('tw_video_recent')}</h2>
              </div>
              {recent.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[rgba(84,70,60,0.2)] px-4 py-6 text-center text-[11.5px] font-bold leading-relaxed text-[#9A929F] dark:border-white/15">
                  {t('tw_video_empty_recent')}
                </div>
              ) : (
                <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-3">
                  {recent.map((item) => {
                    const platform = item.platform || platformOfFile(item.name)
                    const title = item.name.replace(/\s*\[[^\]]+\](?:\s*\(\d+\))?\.\w+$/, '').replace(/\.\w+$/, '')
                    return (
                      <div
                        key={item.path}
                        className="group relative min-w-0 overflow-hidden rounded-xl p-2 hover:bg-[#F6F1EC] dark:hover:bg-[#1D2329]"
                      >
                        {/* The play target is the whole tile; the folder action has
                            to sit outside it, or a click on it would start playback
                            first. */}
                        <button
                          type="button"
                          onClick={() => window.open(apiClient.getVideoFileUrl(item.path), '_blank')}
                          className="flex w-full min-w-0 flex-col gap-2 text-left"
                          title={title}
                        >
                          <span className="relative grid aspect-video w-full place-items-center overflow-hidden rounded-lg border border-[rgba(84,70,60,0.14)] bg-gradient-to-br from-[#F1EAE4] to-[#E6EDF5] text-[#9A929F] dark:border-white/15 dark:from-[#2A2622] dark:to-[#232A33]">
                            <Film size={18} />
                            {/* 首帧封面：后端用 ffmpeg 抽一帧并缓存，失败就只剩图标 */}
                            <img
                              src={apiClient.getVideoPosterUrl(item.path)}
                              alt=""
                              loading="lazy"
                              className="absolute inset-0 h-full w-full object-cover"
                              onError={(e) => {
                                ;(e.currentTarget as HTMLImageElement).style.display = 'none'
                              }}
                            />
                          </span>
                          {/* `truncate` collapses to the content width unless the
                              parent hands it one, which is how a long title used
                              to run across the neighbouring tiles. */}
                          <span className="block w-full truncate text-[12px] font-extrabold text-[#2A2630] dark:text-[#E9EFF5]">
                            {title}
                          </span>
                        </button>
                        <div className="mt-1.5 flex w-full items-center gap-1.5 text-[10.5px] font-bold tabular-nums text-[#9A929F]">
                          {platform && (
                            <span className={`rounded-full px-1.5 py-0.5 text-[9.5px] font-extrabold ${PLATFORM_STYLE[platform]}`}>
                              {PLATFORM_LABEL[platform]}
                            </span>
                          )}
                          {fmtBytes(item.size)}
                          <button
                            type="button"
                            onClick={() => apiClient.revealVideo(item.path).catch(() => {})}
                            title={t('tw_video_open_folder')}
                            aria-label={t('tw_video_open_folder')}
                            className="ml-auto grid h-6 w-6 place-items-center rounded-md border border-[rgba(84,70,60,0.14)] bg-white text-[#6B6371] hover:text-[#2A2630] dark:border-white/15 dark:bg-[#171C21] dark:text-[#A9B5C1] dark:hover:text-[#E9EFF5]"
                          >
                            <FolderOpen size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void apiClient
                                .deleteVideo(item.path)
                                .then(() => loadRecent())
                                .catch(() => undefined)
                            }}
                            title={t('tw_video_delete')}
                            aria-label={t('tw_video_delete')}
                            className="grid h-6 w-6 place-items-center rounded-md border border-[rgba(84,70,60,0.14)] bg-white text-[#6B6371] hover:border-[#A9452A] hover:bg-[#A9452A] hover:text-white dark:border-white/15 dark:bg-[#171C21] dark:text-[#A9B5C1]"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </div>

          {/* 右栏 */}
          <aside className="flex min-w-0 flex-col gap-4">
            <section className="rounded-[18px] border border-[rgba(84,70,60,0.14)] bg-white p-5 shadow-sm dark:border-white/10 dark:bg-[#171C21]">
              <h3 className="mb-3 text-[10.5px] font-extrabold uppercase tracking-[0.12em] text-[#9A929F]">
                {t('tw_video_access')}
              </h3>
              <div className="rounded-[11px] border border-[rgba(44,107,79,0.16)] bg-[#E8F4EC] p-3 text-[11.5px] font-bold leading-relaxed text-[#2C6B4F] dark:border-[#58C08C]/25 dark:bg-[#14302A] dark:text-[#58C08C]">
                {t('tw_video_guest_note')}
              </div>
              <ul className="mt-3 flex flex-col gap-1.5">
                {Object.keys(accounts).map((platform) => {
                  const account = accounts[platform]
                  return (
                    <li key={platform} className="flex items-center gap-2 rounded-lg bg-[#F6F1EC] px-2 py-1.5 dark:bg-[#1D2329]">
                      <span className="flex-1 text-[11.5px] font-extrabold text-[#2A2630] dark:text-[#E9EFF5]">
                        {PLATFORM_LABEL[platform] || platform}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                          account.logged_in
                            ? 'bg-[#E8F4EC] text-[#2C6B4F] dark:bg-[#14302A] dark:text-[#58C08C]'
                            : 'bg-white text-[#9A929F] dark:bg-[#171C21]'
                        }`}
                      >
                        {t(account.logged_in ? 'tw_video_logged_in' : 'tw_video_not_logged_in')}
                      </span>
                      <button
                        type="button"
                        onClick={() => (account.logged_in ? logout(platform) : startLogin(platform))}
                        className="rounded-md border border-[rgba(84,70,60,0.14)] bg-white px-2 py-0.5 text-[10.5px] font-extrabold text-[#6B6371] dark:border-white/15 dark:bg-[#171C21] dark:text-[#A9B5C1]"
                      >
                        {t(account.logged_in ? 'tw_video_logout' : 'tw_video_login')}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>

            <section className="rounded-[18px] border border-[rgba(84,70,60,0.14)] bg-white p-5 shadow-sm dark:border-white/10 dark:bg-[#171C21]">
              <h3 className="mb-2 text-[10.5px] font-extrabold uppercase tracking-[0.12em] text-[#9A929F]">
                {t('tw_video_support')}
              </h3>
              <ul className="divide-y divide-[#EDE6E0] text-[11.5px] dark:divide-white/10">
                {[
                  ['douyin', t('tw_video_s_douyin'), t('tw_video_no_login'), false],
                  ['xiaohongshu', t('tw_video_s_xhs'), t('tw_video_no_login'), false],
                  ['bilibili', t('tw_video_s_bili'), t('tw_video_no_login'), false],
                  ['bilibili', t('tw_video_s_bili_hd'), t('tw_video_need_account'), true],
                ].map(([platform, what, badge, locked], index) => (
                  <li key={index} className="flex items-center gap-2 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-[9.5px] font-extrabold ${PLATFORM_STYLE[platform as string]}`}>
                      {PLATFORM_LABEL[platform as string]}
                    </span>
                    <span className="flex-1 font-bold text-[#6B6371] dark:text-[#A9B5C1]">{what as string}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[9.5px] font-extrabold ${
                        locked
                          ? 'bg-[#FBF1D9] text-[#8A6A1F] dark:bg-[#33290F] dark:text-[#DFC070]'
                          : 'bg-[#E8F4EC] text-[#2C6B4F] dark:bg-[#14302A] dark:text-[#58C08C]'
                      }`}
                    >
                      {badge as string}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <p className="px-1 text-[10.5px] font-semibold leading-relaxed text-[#9A929F]">{t('tw_video_fineprint')}</p>
          </aside>
        </div>
      </div>

      {/* 登录浮层 */}
      {loginPlatform && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 p-4">
          <div className="relative w-[360px] max-w-full rounded-[18px] border border-[rgba(84,70,60,0.14)] bg-white p-6 text-center shadow-xl dark:border-white/15 dark:bg-[#171C21]">
            <button
              type="button"
              onClick={stopPolling}
              className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-lg text-[#9A929F] hover:bg-[#F6F1EC] dark:hover:bg-[#1D2329]"
              aria-label="close"
            >
              <X size={14} />
            </button>
            <h3 className="text-[19px] text-[#2A2630] dark:text-[#E9EFF5]">{t('tw_video_login_title')}</h3>
            <p className="mt-1 text-[12px] font-semibold leading-relaxed text-[#6B6371] dark:text-[#A9B5C1]">
              {loginPlatform === 'bilibili' ? t('tw_video_login_qr_hint') : t('tw_video_login_browser_hint')}
            </p>
            {loginState?.qr && (
              <img src={loginState.qr} alt="QR" className="mx-auto my-3 h-[196px] w-[196px] rounded-xl border border-[rgba(84,70,60,0.14)] bg-white p-2" />
            )}
            <p
              className={`my-3 min-h-[1.2em] text-[11.5px] font-bold ${
                loginState?.tone === 'ok'
                  ? 'text-[#2C6B4F] dark:text-[#58C08C]'
                  : loginState?.tone === 'warn'
                  ? 'text-[#8A6A1F] dark:text-[#DFC070]'
                  : 'text-[#9A929F]'
              }`}
            >
              {loginState?.text}
            </p>
            <div className="flex justify-center gap-2">
              <button
                type="button"
                onClick={stopPolling}
                className="h-9 rounded-xl border border-[rgba(84,70,60,0.14)] px-4 text-[13px] font-extrabold text-[#2A2630] dark:border-white/15 dark:text-[#E9EFF5]"
              >
                {t('tw_video_login_cancel')}
              </button>
              {loginPlatform === 'bilibili' && (
                <button
                  type="button"
                  onClick={() => startLogin('bilibili')}
                  className="flex h-9 items-center gap-1.5 rounded-xl bg-[#2C6B4F] px-4 text-[13px] font-extrabold text-white dark:bg-[#58C08C] dark:text-[#07130C]"
                >
                  <RotateCw size={13} /> {t('tw_video_login_refresh')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default VideoPage
