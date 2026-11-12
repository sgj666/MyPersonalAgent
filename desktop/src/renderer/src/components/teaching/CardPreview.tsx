// A rendered page at its real pixel size (1080×1440 card, 1920×1080 slide),
// scaled down to fit its box. The HTML arrives as text and goes in through
// srcdoc inside a sandbox with scripts off, so a rendered file can't reach
// the app.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { t } from '../../i18n'
import { InlineError } from './states'

export interface CardPreviewProps {
  html: string | null
  width: number
  height: number
  loading?: boolean
  error?: string
  onRetry?: () => void
  /** Shown when there is nothing to render yet. */
  emptyText: string
  /** A deck: show only `section.slide[data-slide=N]` (1-based). */
  slide?: number
  label: string
}

/** Hide every slide but one and pin it to the top-left of the frame. */
const slideOnly = (n: number): string =>
  `<style>html,body{margin:0!important;overflow:hidden!important}section.slide:not([data-slide="${n}"]){display:none!important}section.slide[data-slide="${n}"]{margin:0!important}</style>`

const CardPreview: React.FC<CardPreviewProps> = ({
  html,
  width,
  height,
  loading,
  error,
  onRetry,
  emptyText,
  slide,
  label,
}) => {
  const boxRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.3)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const fit = () => {
      const w = box.clientWidth
      const h = box.clientHeight
      if (!w || !h) return
      setScale(Math.min(w / width, h / height))
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(box)
    return () => observer.disconnect()
  }, [width, height])

  const doc = useMemo(() => {
    if (!html) return ''
    if (!slide) return html
    return html.includes('</head>') ? html.replace('</head>', `${slideOnly(slide)}</head>`) : slideOnly(slide) + html
  }, [html, slide])

  const frameStyle = { width: width * scale, height: height * scale }

  return (
    <div className="twt-preview-box" ref={boxRef}>
      <div className="twt-preview-frame" style={frameStyle}>
        {loading ? (
          <div className="twt-preview-skel" aria-busy="true" aria-label={t('tw_loading')} />
        ) : error ? (
          <div className="twt-preview-msg">
            <InlineError title={t('twt_preview_unavailable')} message={error} onRetry={onRetry} />
          </div>
        ) : doc ? (
          <iframe
            title={label}
            className="twt-preview-iframe"
            sandbox=""
            srcDoc={doc}
            style={{ width, height, transform: `scale(${scale})` }}
          />
        ) : (
          <div className="twt-preview-msg">
            <p>{emptyText}</p>
          </div>
        )}
      </div>
    </div>
  )
}

export default CardPreview
