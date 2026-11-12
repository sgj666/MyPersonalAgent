// One async read with its loading / error / retry state, so every region of
// a tool page can show a skeleton, a readable error and a retry button.
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '../../lib/teaching'

export interface Loaded<T> {
  data: T
  loading: boolean
  error: string
  reload: () => void
}

/**
 * Run `load` now and whenever `key` changes. A reply that arrives after a
 * newer request started is dropped, so a fast class switch can't show the
 * previous class's facts.
 */
export function useLoad<T>(load: () => Promise<T>, initial: T, key: string, enabled = true): Loaded<T> {
  const [data, setData] = useState<T>(initial)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load

  const reload = useCallback(() => {
    const mine = ++seq.current
    setLoading(true)
    setError('')
    loadRef
      .current()
      .then((value) => {
        if (mine === seq.current) setData(value)
      })
      .catch((err: unknown) => {
        if (mine === seq.current) setError(errorText(err))
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    if (enabled) reload()
    else {
      seq.current++
      setLoading(false)
    }
  }, [key, enabled, reload])

  return { data, loading, error, reload }
}
