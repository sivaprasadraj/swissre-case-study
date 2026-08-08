# Claims Adjudication Workbench — Prototype

Working prototype accompanying the case study for **Senior Application Engineer (UI Developer)**, ref. 137263.

It demonstrates the two surfaces the brief asks for — a 20,000-record claims workqueue and a document workspace for 150 MB – 1 GB claim files — with role-based access enforced server-side.

---

## Running it

```bash
cd prototype
npm install
npm run dev          # http://localhost:5173
```

No backend, no API keys, no config. The mock API runs in a Service Worker (MSW), so the app is fully functional offline after the first load.

```bash
npm test             # 59 tests
npm run typecheck    # strict, zero errors
npm run build        # production build
```

**Requires** Node 20+ and a Chromium-based browser or Firefox (Service Worker + `EventSource`). No network access is needed — fonts are system-stacked and nothing is fetched from a CDN.

<details>
<summary><strong>If the app shows "Could not start the application"</strong></summary>

The mock API is a Service Worker, and service workers outlive the code that registered them. If an older build left one at a different scope, it can intercept requests on that path and break the page.

The app detects and clears this automatically on load, then reloads once. If it somehow persists: **DevTools → Application → Service Workers → Unregister**, then hard-reload. Or open the app in a private window, which starts with no worker.

</details>

---

## A five-minute tour

Follow this order — it walks the architecture rather than the UI.

### 1. RBAC is server-computed (sidebar → *Simulate role*)

Start as **Claims Adjuster**, hover any row, and watch the action buttons.

- Switch to **Auditor (read-only)** → every mutating action *disappears*. Not greyed out — gone. An auditor should never be taught about actions they will never hold.
- Switch to **Supervisor** → `Delete` appears, but is disabled on most rows. Hover it: *"Only claims still in intake can be deleted"*. The role holds the capability; this record denies it.
- Note the row counts change too — an Adjuster sees only their region, an Intake Clerk only inbound channels. **Row-level visibility is applied server-side before pagination**, so the client never receives a record it isn't entitled to.

Everything above comes from a per-record permission descriptor the server attaches to each row. The client renders decisions; it never evaluates policy.

### 2. The grid is server-driven

- Sort a column, add a facet filter, page forward — watch the `ms server` badge and the URL.
- **All view state lives in the URL.** Copy it into a new tab: same filters, same sort, same page. That's what makes a filtered queue shareable in Teams and survivable across a refresh.
- The footer says `~6.7k approx.` — deliberately. An exact `COUNT(*)` over a filtered 20k+ set is too expensive per keystroke, so exact totals stop above 2,000 matches. Hover the badge for the explanation.
- Open DevTools → Elements: about **20 rows exist in the DOM** while `aria-rowcount` reports the full logical count.

### 3. Keyboard model (click a row first, then leave the mouse alone)

Arrows move, `Home`/`End` jump, `PageUp`/`PageDown` page through, `Enter` opens, `Alt`+`←`/`→` changes page. Arrow past the rendered window — focus follows correctly instead of being dropped, which is the classic virtualized-grid failure.

### 4. A gigabyte document opens instantly

Sort by **Docs** descending and open the top claim.

- The document picker shows sizes up to ~1 GB and page counts in the thousands. **It opens immediately**, because the client fetches a manifest (a few KB) — never the bytes.
- The badge reads **`5/15 pages in memory`**. At most 15 decoded pages are retained; the rest render as correctly-sized placeholders so scroll geometry stays stable at zero cost. Scroll and watch the number move.
- Some large documents show **`Indexing…`** and have Split/Merge disabled — the derivative pipeline hasn't finished. That's a real state, surfaced honestly rather than hidden.
- The right panel is the page **text layer**: the accessible representation, because a rasterised page is opaque to a screen reader. Where OCR hasn't completed, it says so.

### 5. Client vs server execution, made visible

Open a **small** document (under 25 MB) → **Split** → the dialog says *"Will run in a Web Worker"*. Confirm, and the job tray reports compute time and then *published*.

Open a **large** document (hundreds of MB) → **Split** → *"Will run on the server"*, with the reasoning. The Web Worker **refuses** above 25 MB rather than attempting it and crashing the tab.

Either way the **server publishes the new version** and issues the ETag and audit entry. Compute can happen anywhere; authority does not move. Check the **Versions** tab — `v1001 → v1007` — and note the page count changed.

### 6. Cancel and partial failure

- Start a split on a large document and hit **Cancel** mid-flight → the job reaches `cancelled`, and nothing was published.
- **Merge** → select a document → tick **"Simulate a partial failure"** → the merge is atomic: nothing is published, the failing input is named, and retry-excluding-it is offered. A half-merged version never exists.

### 7. Annotations anchor to page identity

Pick the **Comment** tool, click a page, save. Then **Split** the document before that page and look at the **Comments** tab: comments on surviving pages are untouched, and comments whose pages were removed appear under **"Orphaned by a page operation"** — retained for audit, not silently deleted.

Annotations reference a stable `pageId`, never an ordinal index. Get this wrong and annotations drift onto the wrong pages after a structural edit — a compliance problem in claims work, not a cosmetic one.

### 8. Theming

Toggle **Dark theme** from the sidebar. The UI is built on three-tier design tokens (raw palette → semantic role → component) extracted from the provided Figma. Only the semantic tier is re-pointed for dark mode; no component knows the theme changed.

---

## What's real and what's mocked

Worth being precise about, since it's the difference between a demo and an architecture.

**Real — swapping MSW for a live BFF changes no component code:**

| | |
|---|---|
| Query engine | Genuine server-side filter → facet → sort → keyset-paginate over 20,000 records. Not `array.sort()` on a client-held array. |
| Keyset cursors | Encode the boundary row's sort value **plus its id as a tie-breaker**. Without the tie-breaker, paging a low-cardinality sort silently skips and repeats rows — there's a property test for it. |
| RBAC | Policy lives in `src/server/policy.ts`, which no component imports. Five roles, three-way hide/disable/allow, per-record reasons. |
| Authorization order | Row visibility applied **before** pagination; per-record decisions computed for the returned page only. |
| Enforcement | Mutating endpoints re-derive permissions and return **403** even for actions the UI disabled. |
| Document strategy | Manifest + per-page resources + a hard 15-page retention window with least-recently-visible eviction. |
| Concurrency | Immutable versions, ETag `If-Match`, **412** on conflict, atomic merge with named partial failures. |
| Jobs | `202 Accepted` → job id → SSE progress → cancel, with worker and server executors in one tray. |
| Accessibility | `aria-rowcount`/`aria-rowindex` over the full set, roving tabindex, scroll-then-focus ordering, dual-politeness live regions, focusable disabled-reason tooltips. |

**Mocked — and why it doesn't weaken the argument:**

| | |
|---|---|
| The backend | MSW, but implementing the contract the design specifies. The seam is HTTP. |
| The derivative pipeline | Manifests are generated on demand. Its *output shape* is what the frontend design depends on. |
| Page renders | Generated SVG, not a real 1 GB PDF fixture — the repo would otherwise need a gigabyte of binary. Pages render as readable claims documents (cover with intake stamp, structured APS form, investigation-results table with abnormal values flagged, prose, signed declaration), deterministic per page, with scanned pages visibly degraded to match their "OCR pending" badge. The loading ladder, memory ceiling and eviction behave identically regardless of what the pixels depict. |
| The role switcher | A prototype affordance. In production, role comes from the IdP token and the client cannot influence it — there is no such endpoint. |
| Latency | Artificial delay so loading states are actually visible. Tunable via `POST /api/dev/network`. |

---

## Layout

```
src/
  domain/types.ts          Shared API contract types
  server/                  The mock backend — NOT shipped to the browser in production
    policy.ts              Authorization. No component imports this.
    queryEngine.ts         Filter → facet → sort → keyset-paginate
    dataset.ts             20,000 deterministic claims (seeded PRNG)
    documentStore.ts       Manifests, versions, ETags, jobs
    handlers.ts            HTTP boundary (MSW), incl. SSE progress
  app/
    session.tsx            Session + the <Can> gate
    useGridState.ts        URL as the source of truth
    jobs.tsx               Operation state machine (reducer)
    AppShell.tsx           Rail, role switcher, theme, job tray
  features/
    claims/                Grid: virtualization, facets, row actions
    document/              Workspace, page window, worker bridge
    designsystem/          Token showcase + gap analysis
  ui/                      Primitives built from tokens
  styles/tokens.css        Three-tier token model
```

`src/server/` is deliberately isolated. The client imports nothing from it — which is why role labels are duplicated in `app/roleOptions.ts` rather than imported. The import graph tells the truth about what ships.

---

## Known limitations

Honest list, since a prototype that claims to be finished isn't credible.

- **Page renders are generated SVG, not real PDF rasterisation.** Production uses `pdf.js` canvas rendering with `disableAutoFetch` and `rangeChunkSize`, or pre-rendered CDN tiles; `pdfjs-dist` is installed and chunked separately. The generated pages are deliberately realistic claims documents rather than placeholder bars, because a viewer full of grey rectangles is indistinguishable from a broken one.
- **Client-side split is simulated.** The worker runs a real chunked, cancellable work loop with a genuine size-based refusal, but doesn't manipulate actual PDF bytes.
- **No Storybook.** Production would use Storybook plus visual regression as the design-system contract.
- **No E2E suite committed.** The flows above were verified with Playwright during development; the committed tests cover policy and the query engine, where the subtle logic lives.
- **Mutations are in-memory.** A page refresh resets the dataset.
- **Desktop-first.** Columns drop responsively, but the workspace assumes a wide viewport, matching the stated scope.
