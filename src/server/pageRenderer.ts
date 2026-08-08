/**
 * SYNTHETIC PAGE RENDERER.
 *
 * Stands in for the ingest pipeline's per-page renditions. In production these
 * are pre-rendered raster tiles served from the CDN by immutable version key,
 * or a byte range of the source PDF handed to pdf.js.
 *
 * The prototype generates them as SVG so the repo needs no gigabyte fixture.
 *
 * Why this renders *readable claims documents* rather than grey placeholder
 * bars: a reviewer looking at the workspace should be able to tell at a glance
 * that they are looking at an attending physician statement rather than a
 * loading skeleton. Placeholder bars make a working viewer look broken, and the
 * viewer is the thing being demonstrated.
 *
 * Content is deterministic per (documentId, pageIndex), so a page looks the same
 * on every load and across machines.
 */

interface PageContext {
  fileName: string
  claimNumber: string
  pageIndex: number
  pageCount: number
  version: string
  widthPt: number
  heightPt: number
  /** False for scanned pages: we render them visibly degraded. */
  hasTextLayer: boolean
}

function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ------------------------------------------------------------------ corpus */

const CLINICAL_SENTENCES = [
  'The claimant presented with progressive dyspnoea on exertion, first documented at the consultation of 14 March.',
  'Past medical history is significant for hypertension, managed with a calcium channel blocker since 2019.',
  'Echocardiography demonstrated a left ventricular ejection fraction of 38 per cent, consistent with systolic dysfunction.',
  'No family history of premature coronary artery disease was reported at the time of underwriting.',
  'Serial troponin measurements were within reference range on admission and at six hours.',
  'The treating physician records a working diagnosis of dilated cardiomyopathy of uncertain aetiology.',
  'Functional capacity is assessed as NYHA class III, limiting ordinary domestic activity.',
  'Medication at discharge comprised an ACE inhibitor, a beta blocker and a loop diuretic.',
  'A follow-up review was scheduled at six weeks with repeat imaging requested.',
  'The claimant reports full compliance with the prescribed regimen and no interval hospital admission.',
  'Occupational duties involve prolonged standing and manual handling, both currently contraindicated.',
  'No evidence of alcohol-related or infiltrative cardiac disease was identified on further investigation.',
  'Independent medical examination was completed on 22 April and the report is appended at page 61.',
  'The attending specialist considers the prognosis guarded but does not anticipate transplant assessment.',
  'Return to unrestricted occupational duty is not expected within the next twelve months.',
]

const ADMIN_SENTENCES = [
  'This statement is furnished in support of the benefit claim referenced above and forms part of the claim record.',
  'The cedent confirms that premiums were paid to date and the policy was in force at the date of event.',
  'Cession of this risk falls under the governing treaty and is subject to the retention stated in the schedule.',
  'The reinsurer reserves the right to request further medical evidence prior to settlement.',
  'All information disclosed is held in accordance with applicable data protection legislation.',
  'Any discrepancy between this statement and the original application should be referred to underwriting.',
  'The benefit calculation is subject to the waiting period and exclusions recorded in the policy wording.',
  'This document has been redacted where it contains information relating to third parties.',
]

const FIELD_LABELS = [
  'Claimant name',
  'Date of birth',
  'Policy number',
  'Date of event',
  'Date first consulted',
  'Primary diagnosis',
  'ICD-10 code',
  'Treating physician',
  'Institution',
  'Benefit claimed',
]

const DIAGNOSES = [
  ['Dilated cardiomyopathy', 'I42.0'],
  ['Acute myocardial infarction', 'I21.9'],
  ['Cerebral infarction', 'I63.9'],
  ['Malignant neoplasm of breast', 'C50.9'],
  ['Type 2 diabetes mellitus', 'E11.9'],
  ['Chronic kidney disease, stage 4', 'N18.4'],
  ['Multiple sclerosis', 'G35'],
  ['Rheumatoid arthritis', 'M06.9'],
]

const PHYSICIANS = [
  'Dr H. Lindqvist, MD FRCP',
  'Dr A. Mensah, MBBS MRCP',
  'Prof. C. Villanueva, MD PhD',
  'Dr S. Nakamura, MD',
  'Dr M. Okonkwo, MBChB',
]

const INSTITUTIONS = [
  'St Aldate General Hospital',
  'Northfield University Hospital',
  'Riverside Cardiology Centre',
  'Meridian Regional Medical Centre',
  'Kingsway Teaching Hospital',
]

/* ---------------------------------------------------------------- layout */

/** Greedy wrap against an approximate glyph width. */
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > maxChars) {
      if (line) lines.push(line.trim())
      line = w
    } else {
      line = (line + ' ' + w).trim()
    }
  }
  if (line) lines.push(line.trim())
  return lines
}

type PageKind = 'cover' | 'form' | 'prose' | 'table' | 'signature'

/**
 * Page 1 is a cover, page 2 a structured form, the last page a signature block,
 * every seventh page a data table, the rest prose. Enough variety that scrolling
 * a long document looks like scrolling a real bundle.
 */
function kindFor(pageIndex: number, pageCount: number, rng: () => number): PageKind {
  if (pageIndex === 1) return 'cover'
  if (pageIndex === 2) return 'form'
  if (pageIndex === pageCount && pageCount > 2) return 'signature'
  if (pageIndex % 7 === 0) return 'table'
  if (rng() > 0.88) return 'form'
  return 'prose'
}

export function renderPageSvg(ctx: PageContext): string {
  const {
    fileName,
    claimNumber,
    pageIndex,
    pageCount,
    version,
    widthPt,
    heightPt,
    hasTextLayer,
  } = ctx

  const rng = makeRng(hash(`${fileName}:${pageIndex}`))
  const kind = kindFor(pageIndex, pageCount, rng)

  const M = 64 // margin
  const contentW = widthPt - M * 2
  const charW = 4.72 // approx advance width of 9pt serif
  const maxChars = Math.floor(contentW / charW)

  const parts: string[] = []
  let y = M + 34

  const line = (
    text: string,
    opts: { size?: number; weight?: number; fill?: string; family?: string; dy?: number; x?: number } = {},
  ): void => {
    const size = opts.size ?? 9
    parts.push(
      `<text x="${opts.x ?? M}" y="${y}" font-family="${opts.family ?? 'Georgia, serif'}" font-size="${size}" font-weight="${opts.weight ?? 400}" fill="${opts.fill ?? '#1b1c20'}">${esc(text)}</text>`,
    )
    y += opts.dy ?? size * 1.62
  }

  const paragraph = (text: string): void => {
    for (const l of wrap(text, maxChars)) line(l)
    y += 6
  }

  const rule = (): void => {
    parts.push(
      `<line x1="${M}" y1="${y}" x2="${widthPt - M}" y2="${y}" stroke="#c9ccd6" stroke-width="0.6"/>`,
    )
    y += 16
  }

  /* ------------------------------------------------------- running header */

  parts.push(
    `<text x="${M}" y="${M - 24}" font-family="Helvetica, Arial, sans-serif" font-size="7" fill="#8b90a0" letter-spacing="0.6">${esc(claimNumber)} · CONFIDENTIAL</text>`,
    `<text x="${widthPt - M}" y="${M - 24}" font-family="Helvetica, Arial, sans-serif" font-size="7" fill="#8b90a0" text-anchor="end">${esc(version)}</text>`,
    `<line x1="${M}" y1="${M - 18}" x2="${widthPt - M}" y2="${M - 18}" stroke="#dfe1e8" stroke-width="0.6"/>`,
  )

  /* ---------------------------------------------------------------- body */

  const dx = DIAGNOSES[Math.floor(rng() * DIAGNOSES.length)]!
  const physician = PHYSICIANS[Math.floor(rng() * PHYSICIANS.length)]!
  const institution = INSTITUTIONS[Math.floor(rng() * INSTITUTIONS.length)]!

  if (kind === 'cover') {
    y += 40
    line(institution.toUpperCase(), {
      size: 8,
      family: 'Helvetica, Arial, sans-serif',
      fill: '#5932ea',
      dy: 26,
    })
    line('ATTENDING PHYSICIAN', { size: 21, weight: 700, family: 'Helvetica, Arial, sans-serif', dy: 26 })
    line('STATEMENT', { size: 21, weight: 700, family: 'Helvetica, Arial, sans-serif', dy: 34 })
    rule()
    line(`Claim reference   ${claimNumber}`, { size: 9.5 })
    line(`Document          ${fileName.replace(/\.pdf$/, '')}`, { size: 9.5 })
    line(`Pages             ${pageCount}`, { size: 9.5 })
    line(`Version           ${version}`, { size: 9.5, dy: 30 })
    rule()
    paragraph(
      'This bundle contains medical evidence submitted in support of the claim referenced above. It is disclosed for the sole purpose of claim adjudication and may contain special category personal data.',
    )
    y += 10
    paragraph(
      'Pages may have been added, removed or reordered by the adjudicating team. Refer to the version history for a record of structural changes.',
    )

    // A stamp block, because real claim covers have them.
    const sy = heightPt - 210
    parts.push(
      `<rect x="${M}" y="${sy}" width="196" height="76" rx="3" fill="none" stroke="#b9271f" stroke-width="1.4" opacity="0.72"/>`,
      `<text x="${M + 14}" y="${sy + 28}" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="700" fill="#b9271f" opacity="0.78" letter-spacing="1.4">RECEIVED</text>`,
      `<text x="${M + 14}" y="${sy + 46}" font-family="Helvetica, Arial, sans-serif" font-size="8" fill="#b9271f" opacity="0.78">Claims Intake · EMEA</text>`,
      `<text x="${M + 14}" y="${sy + 62}" font-family="Helvetica, Arial, sans-serif" font-size="8" fill="#b9271f" opacity="0.78">Ref ${claimNumber.slice(-6)}</text>`,
    )
  } else if (kind === 'form') {
    line('SECTION A — CLAIMANT AND POLICY PARTICULARS', {
      size: 9,
      weight: 700,
      family: 'Helvetica, Arial, sans-serif',
      dy: 20,
    })
    rule()

    const values = [
      claimNumber.replace('CLM', 'Claimant').slice(0, 22),
      '14 / 07 / 1968',
      `POL-${1_000_000 + Math.floor(rng() * 8_999_999)}`,
      '02 / 11 / 2025',
      '14 / 03 / 2025',
      dx[0]!,
      dx[1]!,
      physician,
      institution,
      'Critical illness benefit',
    ]

    FIELD_LABELS.forEach((label, i) => {
      const boxY = y - 9
      parts.push(
        `<text x="${M}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="7.5" fill="#6b7183">${esc(label.toUpperCase())}</text>`,
        `<line x1="${M + 128}" y1="${boxY + 4}" x2="${widthPt - M}" y2="${boxY + 4}" stroke="#dfe1e8" stroke-width="0.6"/>`,
        `<text x="${M + 134}" y="${y}" font-family="Georgia, serif" font-size="9" fill="#1b1c20">${esc(values[i] ?? '—')}</text>`,
      )
      y += 26
    })

    y += 8
    rule()
    line('SECTION B — CLINICAL SUMMARY', {
      size: 9,
      weight: 700,
      family: 'Helvetica, Arial, sans-serif',
      dy: 18,
    })
    paragraph(CLINICAL_SENTENCES[Math.floor(rng() * CLINICAL_SENTENCES.length)]!)
    paragraph(CLINICAL_SENTENCES[Math.floor(rng() * CLINICAL_SENTENCES.length)]!)
  } else if (kind === 'table') {
    line('APPENDIX — INVESTIGATION RESULTS', {
      size: 9,
      weight: 700,
      family: 'Helvetica, Arial, sans-serif',
      dy: 20,
    })
    rule()

    const cols = [M, M + 150, M + 260, M + 352, M + 430]
    const headers = ['Investigation', 'Date', 'Result', 'Reference', 'Flag']
    headers.forEach((h, i) => {
      parts.push(
        `<text x="${cols[i]}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="7.5" font-weight="700" fill="#4a4f60">${esc(h.toUpperCase())}</text>`,
      )
    })
    y += 8
    rule()

    const tests: [string, string, string, string, string][] = [
      ['Haemoglobin', '02/11/25', '13.4 g/dL', '13.0–17.0', ''],
      ['White cell count', '02/11/25', '11.8 ×10⁹/L', '4.0–11.0', 'H'],
      ['Creatinine', '02/11/25', '128 µmol/L', '60–110', 'H'],
      ['eGFR', '02/11/25', '52 mL/min', '> 90', 'L'],
      ['NT-proBNP', '02/11/25', '1,840 pg/mL', '< 125', 'H'],
      ['Troponin T', '02/11/25', '11 ng/L', '< 14', ''],
      ['HbA1c', '28/10/25', '61 mmol/mol', '20–42', 'H'],
      ['Total cholesterol', '28/10/25', '5.8 mmol/L', '< 5.0', 'H'],
      ['LDL cholesterol', '28/10/25', '3.6 mmol/L', '< 3.0', 'H'],
      ['TSH', '28/10/25', '2.1 mIU/L', '0.4–4.0', ''],
      ['Ejection fraction', '05/11/25', '38 %', '> 55', 'L'],
      ['Chest radiograph', '02/11/25', 'Cardiomegaly', 'Normal', 'A'],
    ]

    for (const [name, date, result, ref, flag] of tests) {
      const cells = [name, date, result, ref, flag]
      cells.forEach((c, i) => {
        const abnormal = i === 4 && c !== ''
        parts.push(
          `<text x="${cols[i]}" y="${y}" font-family="${i === 0 ? 'Georgia, serif' : 'Helvetica, Arial, sans-serif'}" font-size="8.4" font-weight="${abnormal ? 700 : 400}" fill="${abnormal ? '#b9271f' : '#1b1c20'}">${esc(c)}</text>`,
        )
      })
      parts.push(
        `<line x1="${M}" y1="${y + 6}" x2="${widthPt - M}" y2="${y + 6}" stroke="#eceef3" stroke-width="0.5"/>`,
      )
      y += 21
    }

    y += 12
    paragraph(
      'Flags: H above reference range, L below reference range, A abnormal qualitative finding. Results transcribed from the laboratory report at pages 44 to 47.',
    )
  } else if (kind === 'signature') {
    line('DECLARATION', { size: 9, weight: 700, family: 'Helvetica, Arial, sans-serif', dy: 20 })
    rule()
    paragraph(
      'I certify that the information given above is true and complete to the best of my knowledge and that I have personally examined the claimant on the dates stated.',
    )
    y += 20
    paragraph(ADMIN_SENTENCES[Math.floor(rng() * ADMIN_SENTENCES.length)]!)

    y = heightPt - 250
    const sigs: [string, string][] = [
      ['Attending physician', physician],
      ['Position', 'Consultant Cardiologist'],
      ['Institution', institution],
      ['Date', '18 / 11 / 2025'],
    ]
    for (const [label, value] of sigs) {
      parts.push(
        `<text x="${M}" y="${y}" font-family="Helvetica, Arial, sans-serif" font-size="7.5" fill="#6b7183">${esc(label.toUpperCase())}</text>`,
        `<line x1="${M}" y1="${y + 26}" x2="${M + 300}" y2="${y + 26}" stroke="#8b90a0" stroke-width="0.7"/>`,
        `<text x="${M + 4}" y="${y + 22}" font-family="Georgia, serif" font-size="9.5" fill="#1b1c20">${esc(value)}</text>`,
      )
      y += 52
    }

    // A handwritten-looking mark over the first rule.
    parts.push(
      `<path d="M ${M + 12} ${heightPt - 232} q 22 -20 38 2 t 30 -6 q 14 12 34 -8 t 26 6" fill="none" stroke="#1f3a93" stroke-width="1.5" stroke-linecap="round" opacity="0.82"/>`,
    )
  } else {
    // Prose page: a heading, then clinical and administrative paragraphs.
    const headings = [
      'CLINICAL NARRATIVE (CONTINUED)',
      'HISTORY OF PRESENTING COMPLAINT',
      'PAST MEDICAL HISTORY',
      'CORRESPONDENCE',
      'ADJUSTER NOTES',
      'TREATMENT AND MEDICATION',
    ]
    line(headings[pageIndex % headings.length]!, {
      size: 9,
      weight: 700,
      family: 'Helvetica, Arial, sans-serif',
      dy: 20,
    })
    rule()

    const budget = heightPt - M - 90
    let guard = 0
    while (y < budget && guard++ < 24) {
      const useAdmin = rng() > 0.72
      const pool = useAdmin ? ADMIN_SENTENCES : CLINICAL_SENTENCES
      // Two or three sentences per paragraph, as a real report reads.
      const n = 2 + Math.floor(rng() * 2)
      const sentences: string[] = []
      for (let i = 0; i < n; i++) {
        sentences.push(pool[Math.floor(rng() * pool.length)]!)
      }
      paragraph(sentences.join(' '))

      if (rng() > 0.84 && y < budget - 60) {
        // An indented quotation, as correspondence pages often carry.
        const q = ADMIN_SENTENCES[Math.floor(rng() * ADMIN_SENTENCES.length)]!
        for (const l of wrap(q, maxChars - 12)) {
          parts.push(
            `<text x="${M + 28}" y="${y}" font-family="Georgia, serif" font-size="8.6" font-style="italic" fill="#4a4f60">${esc(l)}</text>`,
          )
          y += 14
        }
        parts.push(
          `<line x1="${M + 12}" y1="${y - (wrap(q, maxChars - 12).length * 14) - 8}" x2="${M + 12}" y2="${y - 6}" stroke="#c9ccd6" stroke-width="1.6"/>`,
        )
        y += 8
      }
    }
  }

  /* ------------------------------------------------------- running footer */

  parts.push(
    `<line x1="${M}" y1="${heightPt - 52}" x2="${widthPt - M}" y2="${heightPt - 52}" stroke="#dfe1e8" stroke-width="0.6"/>`,
    `<text x="${M}" y="${heightPt - 36}" font-family="Helvetica, Arial, sans-serif" font-size="7" fill="#8b90a0">${esc(fileName)}</text>`,
    `<text x="${widthPt / 2}" y="${heightPt - 36}" font-family="Helvetica, Arial, sans-serif" font-size="7.5" fill="#6b7183" text-anchor="middle">Page ${pageIndex} of ${pageCount}</text>`,
  )

  /**
   * Scanned pages (no text layer) are rendered visibly degraded — a faint skew,
   * speckle and a warm cast. This is the honest visual counterpart to the
   * "OCR pending" badge and the empty text panel: the reviewer can see *why*
   * the page has no machine-readable content.
   */
  const scanArtefacts = hasTextLayer
    ? ''
    : `
  <g opacity="0.5">
    ${Array.from({ length: 26 }, () => {
      const sx = rng() * widthPt
      const sy = rng() * heightPt
      const r = rng() * 1.5 + 0.3
      return `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="${r.toFixed(2)}" fill="#8b7f6b"/>`
    }).join('')}
  </g>
  <rect width="${widthPt}" height="${heightPt}" fill="#c8a86b" opacity="0.055"/>`

  const skew = hasTextLayer ? '' : ` transform="rotate(-0.32 ${widthPt / 2} ${heightPt / 2})"`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPt}" height="${heightPt}" viewBox="0 0 ${widthPt} ${heightPt}">
  <rect width="${widthPt}" height="${heightPt}" fill="#ffffff"/>
  <g${skew}>
  ${parts.join('\n  ')}
  </g>${scanArtefacts}
</svg>`
}

/**
 * Thumbnail: the same document, drawn as a miniature.
 *
 * Deliberately NOT a scaled-down copy of the full render — real 108px-wide
 * thumbnails from a derivative pipeline lose glyph detail and become texture.
 * Drawing them as blocks is both faster and more honest about what a thumbnail
 * actually conveys at that size.
 */
export function renderThumbnailSvg(ctx: {
  fileName: string
  pageIndex: number
  pageCount: number
  hasTextLayer: boolean
}): string {
  const { fileName, pageIndex, pageCount, hasTextLayer } = ctx
  const rng = makeRng(hash(`${fileName}:thumb:${pageIndex}`))
  const kind = kindFor(pageIndex, pageCount, makeRng(hash(`${fileName}:${pageIndex}`)))

  const W = 108
  const H = 150
  const rows: string[] = []

  if (kind === 'cover') {
    rows.push(
      `<rect x="14" y="22" width="42" height="3" rx="1.5" fill="#5932ea" opacity="0.85"/>`,
      `<rect x="14" y="34" width="70" height="6" rx="2" fill="#1b1c20" opacity="0.82"/>`,
      `<rect x="14" y="44" width="52" height="6" rx="2" fill="#1b1c20" opacity="0.82"/>`,
      `<line x1="14" y1="58" x2="94" y2="58" stroke="#c9ccd6" stroke-width="0.8"/>`,
    )
    for (let i = 0; i < 4; i++) {
      rows.push(
        `<rect x="14" y="${66 + i * 8}" width="${46 + ((i * 13) % 30)}" height="2.4" rx="1.2" fill="#6b7183" opacity="0.55"/>`,
      )
    }
    rows.push(
      `<rect x="14" y="112" width="40" height="18" rx="2" fill="none" stroke="#b9271f" stroke-width="1" opacity="0.6"/>`,
    )
  } else if (kind === 'form') {
    rows.push(`<rect x="14" y="22" width="58" height="3.4" rx="1.5" fill="#1b1c20" opacity="0.78"/>`)
    for (let i = 0; i < 9; i++) {
      const ly = 34 + i * 11
      rows.push(
        `<rect x="14" y="${ly}" width="26" height="2.2" rx="1" fill="#8b90a0" opacity="0.6"/>`,
        `<line x1="46" y1="${ly + 2}" x2="94" y2="${ly + 2}" stroke="#dfe1e8" stroke-width="0.7"/>`,
        `<rect x="48" y="${ly - 0.5}" width="${20 + ((i * 17) % 26)}" height="2.4" rx="1.2" fill="#3c4055" opacity="0.6"/>`,
      )
    }
  } else if (kind === 'table') {
    rows.push(
      `<rect x="14" y="22" width="54" height="3.4" rx="1.5" fill="#1b1c20" opacity="0.78"/>`,
      `<line x1="14" y1="32" x2="94" y2="32" stroke="#8b90a0" stroke-width="0.9"/>`,
    )
    for (let i = 0; i < 11; i++) {
      const ly = 40 + i * 9
      rows.push(
        `<rect x="14" y="${ly}" width="24" height="2.2" rx="1" fill="#3c4055" opacity="0.6"/>`,
        `<rect x="44" y="${ly}" width="14" height="2.2" rx="1" fill="#6b7183" opacity="0.5"/>`,
        `<rect x="63" y="${ly}" width="16" height="2.2" rx="1" fill="#6b7183" opacity="0.5"/>`,
        `<rect x="84" y="${ly}" width="6" height="2.2" rx="1" fill="${i % 3 === 0 ? '#b9271f' : '#6b7183'}" opacity="0.6"/>`,
        `<line x1="14" y1="${ly + 5}" x2="94" y2="${ly + 5}" stroke="#eceef3" stroke-width="0.5"/>`,
      )
    }
  } else if (kind === 'signature') {
    rows.push(`<rect x="14" y="22" width="38" height="3.4" rx="1.5" fill="#1b1c20" opacity="0.78"/>`)
    for (let i = 0; i < 5; i++) {
      rows.push(
        `<rect x="14" y="${34 + i * 7}" width="${74 - ((i * 11) % 22)}" height="2.2" rx="1" fill="#6b7183" opacity="0.5"/>`,
      )
    }
    for (let i = 0; i < 3; i++) {
      const ly = 92 + i * 18
      rows.push(
        `<rect x="14" y="${ly}" width="20" height="2" rx="1" fill="#8b90a0" opacity="0.55"/>`,
        `<line x1="14" y1="${ly + 10}" x2="72" y2="${ly + 10}" stroke="#8b90a0" stroke-width="0.7"/>`,
      )
    }
    rows.push(
      `<path d="M 18 100 q 8 -7 14 1 t 11 -2 q 5 4 12 -3" fill="none" stroke="#1f3a93" stroke-width="1" stroke-linecap="round" opacity="0.8"/>`,
    )
  } else {
    rows.push(`<rect x="14" y="22" width="52" height="3.4" rx="1.5" fill="#1b1c20" opacity="0.78"/>`)
    for (let i = 0; i < 15; i++) {
      const w = 80 - ((pageIndex * 13 + i * 29) % 34)
      const indent = rng() > 0.86 ? 22 : 14
      rows.push(
        `<rect x="${indent}" y="${34 + i * 7}" width="${Math.max(24, w - (indent - 14))}" height="2.2" rx="1.1" fill="#3c4055" opacity="${i % 8 === 7 ? 0.28 : 0.5}"/>`,
      )
    }
  }

  const cast = hasTextLayer ? '' : `<rect width="${W}" height="${H}" fill="#c8a86b" opacity="0.07"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="#e2e4ec"/>
  ${rows.join('\n  ')}
  <text x="${W / 2}" y="${H - 8}" font-family="Helvetica, Arial, sans-serif" font-size="6.5" fill="#8b90a0" text-anchor="middle">${pageIndex}</text>
  ${cast}
</svg>`
}
