// Two-line clamp that actually works in this Chromium: `display:-webkit-box`
// computes to flow-root here, so the CSS line-clamp never truncated anything.
// Measure the real box, then binary-search a cut that fits with an ellipsis;
// the full sentence stays in the tooltip.
import React, { useEffect, useRef } from 'react'

interface ClampedTextProps {
  text: string
  lines?: number
  className?: string
}

const ClampedText: React.FC<ClampedTextProps> = ({ text, lines = 2, className }) => {
  const ref = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const clamp = () => {
      el.textContent = text
      const style = getComputedStyle(el)
      const lineHeight = parseFloat(style.lineHeight) || 22
      const max = lineHeight * lines + 1
      if (el.scrollHeight <= max) return
      let lo = 0
      let hi = text.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        el.textContent = text.slice(0, mid) + '…'
        if (el.scrollHeight <= max) lo = mid
        else hi = mid - 1
      }
      el.textContent = text.slice(0, lo).replace(/[，、；：,;:\s]+$/, '') + '…'
    }
    clamp()
    const observer = new ResizeObserver(clamp)
    observer.observe(el)
    return () => observer.disconnect()
  }, [text, lines])

  return (
    <p ref={ref} className={className} title={text}>
      {text}
    </p>
  )
}

export default ClampedText
