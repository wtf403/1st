import { useCallback, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const MINUTES_PER_DAY = 24 * 60
const MAX_MINUTE = MINUTES_PER_DAY - 1
const STEP_MINUTES = 15

type Handle = 'start' | 'end'

interface TimeRangeSliderProps {
  startTime: string
  endTime: string
  onChange: (startTime: string, endTime: string) => void
  disabled?: boolean
  className?: string
}

export function timeToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0
  return Math.min(MAX_MINUTE, Math.max(0, h * 60 + m))
}

export function minutesToTime(value: number): string {
  const safe = Math.min(MAX_MINUTE, Math.max(0, Math.round(value)))
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function snapMinute(value: number): number {
  return Math.min(MAX_MINUTE, Math.max(0, Math.round(value / STEP_MINUTES) * STEP_MINUTES))
}

export function TimeRangeSlider({
  startTime,
  endTime,
  onChange,
  disabled = false,
  className
}: TimeRangeSliderProps): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [activeHandle, setActiveHandle] = useState<Handle | null>(null)

  const start = timeToMinutes(startTime)
  const end = timeToMinutes(endTime)
  const startPercent = (start / MAX_MINUTE) * 100
  const endPercent = (end / MAX_MINUTE) * 100

  const segments = useMemo(() => {
    if (start === end) return [{ left: 0, width: 100 }]
    if (start < end) return [{ left: startPercent, width: endPercent - startPercent }]
    return [
      { left: startPercent, width: 100 - startPercent },
      { left: 0, width: endPercent }
    ]
  }, [end, endPercent, start, startPercent])

  const minuteFromClientX = useCallback((clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return 0
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return snapMinute(ratio * MAX_MINUTE)
  }, [])

  const updateHandle = useCallback(
    (handle: Handle, clientX: number) => {
      const next = minuteFromClientX(clientX)
      if (handle === 'start') onChange(minutesToTime(next), endTime)
      else onChange(startTime, minutesToTime(next))
    },
    [endTime, minuteFromClientX, onChange, startTime]
  )

  const startDrag = (handle: Handle) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled) return
    event.preventDefault()
    setActiveHandle(handle)
    event.currentTarget.setPointerCapture(event.pointerId)
    updateHandle(handle, event.clientX)
  }

  const continueDrag = (handle: Handle) => (event: React.PointerEvent<HTMLButtonElement>) => {
    if (disabled || activeHandle !== handle) return
    updateHandle(handle, event.clientX)
  }

  const stopDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    setActiveHandle(null)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // ignore
    }
  }

  const moveFocusedHandle = (handle: Handle) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    const current = handle === 'start' ? start : end
    let next = current
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - STEP_MINUTES
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + STEP_MINUTES
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = MAX_MINUTE
    else return

    event.preventDefault()
    next = snapMinute(next)
    if (handle === 'start') onChange(minutesToTime(next), endTime)
    else onChange(startTime, minutesToTime(next))
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between text-sm font-mono">
        <span>{startTime}</span>
        <span className="text-muted-foreground">–</span>
        <span>{endTime}</span>
      </div>

      <div ref={trackRef} className="relative h-8 select-none">
        <div className="absolute left-0 right-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-muted" />
        {segments.map((segment, index) => (
          <div
            key={index}
            className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-primary"
            style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
          />
        ))}

        <button
          type="button"
          aria-label="Start time"
          aria-valuemin={0}
          aria-valuemax={MAX_MINUTE}
          aria-valuenow={start}
          aria-valuetext={startTime}
          disabled={disabled}
          onPointerDown={startDrag('start')}
          onPointerMove={continueDrag('start')}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          onKeyDown={moveFocusedHandle('start')}
          className={cn(
            'absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow transition focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
            disabled && 'cursor-not-allowed opacity-50'
          )}
          style={{ left: `${startPercent}%` }}
        />
        <button
          type="button"
          aria-label="End time"
          aria-valuemin={0}
          aria-valuemax={MAX_MINUTE}
          aria-valuenow={end}
          aria-valuetext={endTime}
          disabled={disabled}
          onPointerDown={startDrag('end')}
          onPointerMove={continueDrag('end')}
          onPointerUp={stopDrag}
          onPointerCancel={stopDrag}
          onKeyDown={moveFocusedHandle('end')}
          className={cn(
            'absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow transition focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
            disabled && 'cursor-not-allowed opacity-50'
          )}
          style={{ left: `${endPercent}%` }}
        />
      </div>
    </div>
  )
}
