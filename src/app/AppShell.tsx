/**
 * App shell — sidebar, header, job tray.
 *
 * Structurally follows the reference Figma (fixed left rail, active pill, user
 * block pinned to the bottom) with the consumer-SaaS artefacts removed: no
 * "Upgrade to PRO" card in an internal claims tool.
 */

import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { ROLE_OPTIONS } from './roleOptions'
import { useRoleSwitch, useSession } from './session'
import { useJobs } from './jobs'
import { Button, ChevronIcon, ProgressBar } from '../ui/primitives'
import type { RoleId } from '../domain/types'
import './AppShell.scss'

const NAV = [{ to: '/claims', label: 'Claims Workqueue', icon: <QueueIcon /> }]

export function AppShell(): React.JSX.Element {
  const session = useSession()
  const switchRole = useRoleSwitch()
  const jobs = useJobs()
  const location = useLocation()
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [trayOpen, setTrayOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const trayRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // Close the mobile drawer whenever the route changes, so tapping a nav item
  // or opening a claim doesn't leave the drawer covering the screen.
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

  // Escape closes the drawer.
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setNavOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navOpen])

  /**
   * Publish the tray's height so toasts can stack above it instead of covering
   * it. A toast obscuring the tray's Cancel button makes a long-running
   * operation uncancellable — the height is measured rather than hard-coded
   * because the tray grows with each concurrent job.
   */
  useEffect(() => {
    const el = trayRef.current
    if (!el) {
      document.documentElement.style.removeProperty('--tray-height')
      return
    }
    const ro = new ResizeObserver(([entry]) => {
      const h = entry?.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight
      document.documentElement.style.setProperty('--tray-height', `${Math.round(h)}px`)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty('--tray-height')
    }
  }, [jobs.jobs.length, trayOpen])

  // Auto-open the tray when work starts, so progress is never hidden.
  useEffect(() => {
    if (jobs.activeCount > 0) setTrayOpen(true)
  }, [jobs.activeCount])

  return (
    <div className={`shell ${navOpen ? 'shell--nav-open' : ''}`}>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>

      {/* Mobile-only top bar with the drawer toggle. Hidden on desktop. */}
      <header className="topbar">
        <button
          type="button"
          className="topbar__menu"
          aria-label={navOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={navOpen}
          onClick={() => setNavOpen((o) => !o)}
        >
          <MenuIcon />
        </button>
        <span className="topbar__brand">
          Claims<strong>Bench</strong>
        </span>
      </header>

      {/* Scrim behind the drawer on mobile; tap to close. */}
      <div
        className="rail__scrim"
        role="presentation"
        onClick={() => setNavOpen(false)}
      />

      <aside className="rail" aria-label="Primary">
        <div className="rail__brand">
          <span className="rail__mark" aria-hidden="true">
            <LogoIcon />
          </span>
          <span className="rail__name">
            Claims<strong>Bench</strong>
            <small>v0.1</small>
          </span>
        </div>

        <nav className="rail__nav" aria-label="Sections">
          <ul>
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  className={({ isActive }) => `rail__item ${isActive ? 'is-active' : ''}`}
                >
                  <span className="rail__icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="rail__foot">
          {/* Prototype-only control. Labelled as such so nobody mistakes it for
              a production feature. */}
          <div className="roleswitch">
            <label className="roleswitch__label" htmlFor="role-select">
              Simulate role
              <span className="roleswitch__badge">demo</span>
            </label>
            <div className="roleswitch__control">
              <select
                id="role-select"
                value={session.role}
                onChange={(e) => switchRole(e.target.value as RoleId)}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <span className="roleswitch__chev" aria-hidden="true">
                <ChevronIcon />
              </span>
            </div>
            <p className="roleswitch__hint">
              Authorization is computed server-side. Switching re-fetches every
              query because permissions shape the response.
            </p>
          </div>

          <div className="rail__user">
            <span className="rail__avatar" aria-hidden="true">
              {session.displayName
                .split(' ')
                .map((n) => n[0])
                .join('')}
            </span>
            <span className="rail__userinfo">
              <strong>{session.displayName}</strong>
              <small>{session.roleLabel}</small>
            </span>
          </div>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            aria-pressed={theme === 'dark'}
          >
            {theme === 'light' ? <MoonIcon /> : <SunIcon />}
            {theme === 'light' ? 'Dark theme' : 'Light theme'}
          </Button>
        </div>
      </aside>

      <main className="main" id="main">
        <Outlet key={location.pathname.startsWith('/claims/') ? 'workspace' : 'grid'} />
      </main>

      {/* Job tray. Concurrent long-running operations, each with progress and
          cancel, visible from anywhere in the app. */}
      {jobs.jobs.length > 0 ? (
        <section
          ref={trayRef}
          className={`tray ${trayOpen ? 'is-open' : ''}`}
          aria-label="Background operations"
        >
          <button
            className="tray__head"
            onClick={() => setTrayOpen(!trayOpen)}
            aria-expanded={trayOpen}
          >
            <span className="tray__title">
              Operations
              {jobs.activeCount > 0 ? (
                <span className="tray__count">{jobs.activeCount} running</span>
              ) : null}
            </span>
            <span className="tray__chev" aria-hidden="true">
              <ChevronIcon dir={trayOpen ? 'down' : 'up'} />
            </span>
          </button>

          {trayOpen ? (
            <div className="tray__body">
              {jobs.jobs.map((job) => (
                <div key={job.id} className="jobrow">
                  <div className="jobrow__top">
                    <span className="jobrow__kind">{JOB_LABELS[job.kind]}</span>
                    <span className="jobrow__doc" title={job.documentName}>
                      {job.documentName}
                    </span>
                    <span className={`jobrow__state jobrow__state--${job.state}`}>
                      {job.state}
                    </span>
                  </div>

                  {job.state === 'running' || job.state === 'queued' ? (
                    <>
                      <ProgressBar value={job.progress} label={`${JOB_LABELS[job.kind]} progress`} />
                      <div className="jobrow__bottom">
                        <span className="jobrow__msg">{job.message}</span>
                        <span className="jobrow__where">
                          {job.executor === 'worker' ? 'in worker' : 'on server'}
                        </span>
                        <Button size="sm" variant="ghost" onClick={() => void jobs.cancel(job.id)}>
                          Cancel
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="jobrow__bottom">
                      <span className="jobrow__msg">
                        {job.error ?? job.message}
                        {job.resultVersion ? ` → ${job.resultVersion}` : ''}
                      </span>
                      {job.failedInputs?.length ? (
                        <span className="jobrow__failed">
                          {job.failedInputs.length} input(s) failed
                        </span>
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => jobs.dismiss(job.id)}>
                        Dismiss
                      </Button>
                    </div>
                  )}
                </div>
              ))}

              {jobs.jobs.some((j) => j.state !== 'running' && j.state !== 'queued') ? (
                <div className="tray__foot">
                  <Button size="sm" variant="ghost" onClick={jobs.dismissFinished}>
                    Clear finished
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

const JOB_LABELS: Record<string, string> = {
  split: 'Split',
  merge: 'Merge',
  delete_pages: 'Delete pages',
  export: 'Export',
  ocr: 'OCR',
}

/* ------------------------------------------------------------------- icons */

function LogoIcon(): React.JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="10" cy="10" r="3.2" fill="currentColor" />
    </svg>
  )
}

function QueueIcon(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="2.5" y="3" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.5 7h13M7 7v8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

function MenuIcon(): React.JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true">
      <path d="M4 6h14M4 11h14M4 16h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function MoonIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M11.5 8.6A5 5 0 1 1 5.4 2.5a4.2 4.2 0 0 0 6.1 6.1Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function SunIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="2.8" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M7 1v1.6M7 11.4V13M1 7h1.6M11.4 7H13M3 3l1.1 1.1M9.9 9.9 11 11M11 3 9.9 4.1M4.1 9.9 3 11"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}
