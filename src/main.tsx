import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AppShell } from './app/AppShell'
import { SessionProvider } from './app/session'
import { JobsProvider } from './app/jobs'
import { ClaimsGrid } from './features/claims/ClaimsGrid'
import { startMockApi } from './server/browser'
import './styles/global.scss'

/**
 * The document workspace is lazy-loaded. It pulls in the viewer, the worker
 * bridge and (in a production build) pdf.js — none of which a user who only
 * works the grid should ever download. The grid prefetches this chunk on row
 * hover, so the split costs nothing perceptually.
 */
const DocumentWorkspace = lazy(() =>
  import('./features/document/DocumentWorkspace').then((m) => ({
    default: m.DocumentWorkspace,
  })),
)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Refetching a 20k-row query because the user tabbed away and back is
      // pure waste; claims data does not change second-to-second.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
    },
  },
})

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <ClaimsGrid /> },
      { path: 'claims', element: <ClaimsGrid /> },
      {
        path: 'claims/:claimId',
        element: (
          <Suspense fallback={<WorkspaceFallback />}>
            <DocumentWorkspace />
          </Suspense>
        ),
      },
    ],
  },
])

function WorkspaceFallback(): React.JSX.Element {
  return (
    <div className="boot" role="status" aria-live="polite">
      <span className="boot__spinner" aria-hidden="true" />
      <span>Loading workspace…</span>
    </div>
  )
}

async function bootstrap(): Promise<void> {
  // The mock API must be intercepting before React mounts, or the first
  // queries escape to the network and 404.
  await startMockApi()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <JobsProvider>
            <RouterProvider router={router} />
          </JobsProvider>
        </SessionProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}

void bootstrap()
