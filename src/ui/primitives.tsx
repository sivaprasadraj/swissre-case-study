/**
 * DESIGN-SYSTEM PRIMITIVES.
 *
 * Hand-built from the tokens rather than pulled from a UI kit, because the
 * component library IS a deliverable here (see JD: "define design systems and
 * maintain component libraries").
 *
 * Every value below resolves to a tier-2 or tier-3 token. No raw hex, no magic
 * px. In a real repo an ESLint rule enforces that.
 */

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react'
import './primitives.scss'

/* ------------------------------------------------------------------ Button */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  iconOnly?: boolean
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', iconOnly, loading, children, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={[
        'btn',
        `btn--${variant}`,
        `btn--${size}`,
        iconOnly ? 'btn--icon' : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      // aria-busy rather than swapping the label, so the accessible name is stable
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  )
})

/* -------------------------------------------------------------------- Pill */

export type PillTone = 'success' | 'danger' | 'warning' | 'neutral' | 'brand'

/**
 * Status pill. Matches the reference design's Active/Inactive treatment, with
 * one deliberate change: an optional icon, because the reference encodes status
 * by colour alone and that fails WCAG 1.4.1.
 */
export function Pill({
  tone,
  children,
  icon,
  title,
}: {
  tone: PillTone
  children: ReactNode
  icon?: ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <span className={`pill pill--${tone}`} title={title}>
      {icon ? (
        <span className="pill__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  )
}

/* -------------------------------------------------------------------- Card */

export function Card({
  children,
  className,
  padded = true,
  ...rest
}: {
  children: ReactNode
  className?: string
  padded?: boolean
} & React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={['card', padded ? 'card--padded' : '', className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    >
      {children}
    </div>
  )
}

/* ---------------------------------------------------------------- StatTile */

/**
 * KPI tile from the reference design, re-pointed at adjudication metrics.
 *
 * The reference showed "Total Customers / Members / Active Now" — vanity counts.
 * For a claims workqueue the useful signals are SLA breaches, aging and
 * unassigned volume, so the component is the same and the content is not.
 */
export function StatTile({
  label,
  value,
  delta,
  tone = 'brand',
  icon,
  onClick,
  active,
  hint,
}: {
  label: string
  value: string
  delta?: { direction: 'up' | 'down'; text: string; good?: boolean }
  tone?: PillTone
  icon: ReactNode
  onClick?: () => void
  active?: boolean
  hint?: string
}): React.JSX.Element {
  const interactive = Boolean(onClick)
  const Tag = interactive ? 'button' : 'div'
  return (
    <Tag
      className={['stat', interactive ? 'stat--interactive' : '', active ? 'stat--active' : '']
        .filter(Boolean)
        .join(' ')}
      {...(interactive
        ? { type: 'button' as const, onClick, 'aria-pressed': Boolean(active) }
        : {})}
      title={hint}
    >
      <span className={`stat__badge stat__badge--${tone}`} aria-hidden="true">
        {icon}
      </span>
      <span className="stat__body">
        <span className="stat__label">{label}</span>
        <span className="stat__value">{value}</span>
        {delta ? (
          <span
            className={`stat__delta stat__delta--${delta.good === false ? 'bad' : delta.good === true ? 'good' : 'neutral'}`}
          >
            <span aria-hidden="true">{delta.direction === 'up' ? '▲' : '▼'}</span> {delta.text}
          </span>
        ) : null}
      </span>
    </Tag>
  )
}

/* ------------------------------------------------------------------ Tooltip */

/**
 * Tooltip used for disabled-action reasons.
 *
 * Wraps the trigger in a focusable span when the trigger itself is disabled,
 * because disabled buttons are not focusable and would otherwise make the
 * reason unreachable by keyboard — the exact failure mode that makes "disabled
 * with a reason" useless in most implementations.
 */
export function Tooltip({
  content,
  children,
  wrapDisabled,
}: {
  content: string
  children: ReactNode
  wrapDisabled?: boolean
}): React.JSX.Element {
  const id = useId()
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const show = (): void => {
    timer.current = window.setTimeout(() => setOpen(true), 120)
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    setOpen(false)
  }

  return (
    <span
      className="tip"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      // Escape must dismiss — WCAG 1.4.13.
      onKeyDown={(e) => {
        if (e.key === 'Escape') hide()
      }}
    >
      <span
        aria-describedby={open ? id : undefined}
        {...(wrapDisabled ? { tabIndex: 0, role: 'button', 'aria-disabled': true } : {})}
      >
        {children}
      </span>
      {open ? (
        <span role="tooltip" id={id} className="tip__bubble">
          {content}
        </span>
      ) : null}
    </span>
  )
}

/* ------------------------------------------------------------------- Input */

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  busy,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  label: string
  busy?: boolean
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="search">
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <span className="search__icon" aria-hidden="true">
        <SearchIcon />
      </span>
      <input
        id={id}
        className="search__input"
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      {busy ? <span className="search__spinner" aria-hidden="true" /> : null}
    </div>
  )
}

/* ---------------------------------------------------------------- Skeleton */

export function Skeleton({
  width,
  height = 12,
  radius = 'var(--radius-sm)',
}: {
  width?: string | number
  height?: string | number
  radius?: string
}): React.JSX.Element {
  return (
    <span
      className="skeleton"
      style={{ width: width ?? '100%', height, borderRadius: radius }}
      aria-hidden="true"
    />
  )
}

/* ------------------------------------------------------------------- Modal */

/**
 * Modal with a focus trap, initial focus, restore-on-close and Escape handling.
 * Native <dialog> would give some of this free, but its polyfill story and
 * styling constraints make an explicit implementation clearer to review.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  width?: number
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const restoreTo = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreTo.current = document.activeElement as HTMLElement | null

    const node = ref.current
    const focusables = (): HTMLElement[] =>
      Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )

    focusables()[0]?.focus()

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      restoreTo.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal__scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ maxWidth: width }}
      >
        <div className="modal__head">
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
          <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Close dialog">
            <CloseIcon />
          </Button>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ Toasts */

export interface Toast {
  id: number
  tone: 'success' | 'error' | 'info'
  message: string
  action?: { label: string; onClick: () => void }
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[]
  onDismiss: (id: number) => void
}): React.JSX.Element {
  return (
    // Errors must interrupt; successes must not. Two regions with different
    // politeness is the only correct way to do this.
    <div className="toasts">
      <div aria-live="assertive" aria-atomic="false" className="toasts__region">
        {toasts
          .filter((t) => t.tone === 'error')
          .map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
          ))}
      </div>
      <div aria-live="polite" aria-atomic="false" className="toasts__region">
        {toasts
          .filter((t) => t.tone !== 'error')
          .map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
          ))}
      </div>
    </div>
  )
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast
  onDismiss: (id: number) => void
}): React.JSX.Element {
  return (
    <div className={`toast toast--${toast.tone}`}>
      <span className="toast__msg">{toast.message}</span>
      {toast.action ? (
        <Button size="sm" variant="ghost" onClick={toast.action.onClick}>
          {toast.action.label}
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        iconOnly
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
      >
        <CloseIcon />
      </Button>
    </div>
  )
}

/* ----------------------------------------------------------------- Spinner */

export function ProgressBar({
  value,
  label,
  tone = 'brand',
}: {
  value: number
  label?: string
  tone?: 'brand' | 'danger' | 'success'
}): React.JSX.Element {
  return (
    <div
      className={`progress progress--${tone}`}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className="progress__fill" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

/* ------------------------------------------------------------------- Icons */
/* Inline so the prototype has zero icon-library weight. */

export function SearchIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function CloseIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function ChevronIcon({ dir = 'down' }: { dir?: 'up' | 'down' | 'left' | 'right' }): React.JSX.Element {
  const rotate = { down: 0, up: 180, left: 90, right: -90 }[dir]
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <path d="M3.5 5.5L7 9l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function DotsIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="8" cy="3.5" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="8" cy="12.5" r="1.4" />
    </svg>
  )
}

export function WarningIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M6 1.5L11 10.5H1L6 1.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6 5v2.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6" cy="8.9" r="0.6" fill="currentColor" />
    </svg>
  )
}

export function CheckIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M2.5 6.2l2.3 2.3L9.5 3.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ClockIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 3.6V6l1.8 1.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
