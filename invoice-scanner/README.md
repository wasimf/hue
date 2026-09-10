# Invoice Scanner

Batch invoice scanning for PDF/PNG/JPG files: OCR → field extraction → validation → JSON/CSV export.

The application is Node.js + TypeScript (Fastify). OCR is performed by **PaddleOCR**, which runs in a
small Python sidecar because there is no maintained Node binding for it; the Node application owns
everything else and talks to the sidecar over a narrow HTTP contract.

Extracted fields, per invoice:

| Field | Schema key |
| --- | --- |
| Invoice issuer | `issuer` |
| Invoice date | `invoiceDate` (normalised to `YYYY-MM-DD`) |
| Invoice number | `invoiceNumber` |
| Invoice assignee (bill-to) | `assignee` |
| Invoice sum (net) | `invoiceSum` |
| Invoice VAT | `invoiceVat` |
| Invoice sum and VAT (gross) | `invoiceSumAndVat` |

```json
{
  "issuer": "ACME Software Ltd",
  "invoiceDate": "2025-03-14",
  "invoiceNumber": "INV-2025-0042",
  "assignee": "Globex Industries Ltd",
  "invoiceSum": 1250,
  "invoiceVat": 225,
  "invoiceSumAndVat": 1475,
  "sourceFileName": "acme.pdf",
  "warnings": []
}
```

A field that cannot be extracted reliably is `null` and always carries a warning explaining why.

---

## Architecture

```
                     ┌─────────────────────────────────────────────────────────────┐
 HTTP / UI  ───────▶ │  routes/         upload · invoices · export · health        │
                     └───────────────┬─────────────────────────────────────────────┘
                                     │
                     ┌───────────────▼─────────────────────────────────────────────┐
                     │  modules/upload        multipart intake, temp storage        │
                     ├─────────────────────────────────────────────────────────────┤
                     │  modules/documents     type sniffing, PDF page splitting,    │
                     │                        PDF text-layer extraction             │
                     ├─────────────────────────────────────────────────────────────┤
                     │  modules/ocr           OcrProvider: paddle | mock            │──▶ Python
                     ├─────────────────────────────────────────────────────────────┤    PaddleOCR
                     │  modules/parsing       layout model → candidate extractors → │    sidecar
                     │                        field mapper (normalised schema)      │
                     ├─────────────────────────────────────────────────────────────┤
                     │  modules/validation    arithmetic, plausibility, confidence  │
                     ├─────────────────────────────────────────────────────────────┤
                     │  modules/export        JSON · CSV                            │
                     ├─────────────────────────────────────────────────────────────┤
                     │  modules/store         BatchRepository (in-memory → DB)      │
                     └─────────────────────────────────────────────────────────────┘
```

Each module has one job and depends only on the interfaces of the modules below it. The composition
root is `src/container.ts`; nothing constructs its own dependencies.

Per-file journey (`modules/pipeline`):

1. **Load** – sniff the real type from magic bytes, count pages, split a PDF into single pages.
2. **Read text** – per page, take the cheapest usable source:
   * a digital-born PDF's embedded text layer (fast, exact), otherwise
   * PaddleOCR on the rasterised page.
3. **Model layout** – normalise text, normalise boxes to 0..1, rebuild reading order, detect RTL.
4. **Extract candidates** – each field has rules that emit *ranked candidates*, never single values.
5. **Map** – the field mapper turns candidates into the schema and decides what `null` means.
6. **Validate** – arithmetic, plausibility, confidence; produces coded issues and a status.
7. **Store & export** – JSON / CSV.

One file failing never fails the batch: it is reported in `rejected[]`. One page failing never fails
the file: it is reported as a warning.

---

## Quick start

Requirements: Node.js >= 20.11. Python 3.9+ only if you want real OCR.

```bash
cd invoice-scanner
npm install
cp .env.example .env
```

### 1. Run it now, without Python

Digital PDFs (invoices exported from accounting software) need no OCR at all — the text layer is
read directly:

```bash
OCR_PROVIDER=mock npm run dev      # http://localhost:3000
```

Open http://localhost:3000 and upload a PDF that contains real text. `OCR_PROVIDER=mock` means
scanned pages are replayed from fixtures rather than OCR'd (see [Mock OCR](#mock-ocr)), so the whole
application — upload, parsing, validation, export, UI — is runnable and testable offline.

### 2. Run it with PaddleOCR (scans and images)

Terminal 1 — the OCR sidecar:

```bash
cd ocr-service
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8868
```

The first request downloads the PaddleOCR models (~10–200 MB depending on language) into
`~/.paddleocr`; it is slow once and fast afterwards.

Terminal 2 — the application:

```bash
OCR_PROVIDER=paddle OCR_SERVICE_URL=http://127.0.0.1:8868 npm run dev
```

### 3. Run both with Docker

```bash
docker compose up --build        # app on :3000, OCR on :8868
```

Then open http://localhost:3000.

**What to expect on the first run.** Building the OCR image installs PaddlePaddle
(~500 MB of wheels) and the first container start downloads the recognition models. Compose waits
for the OCR service to report healthy before starting the app, so the first `up` can sit quiet for
several minutes — that is the models arriving, not a hang. Follow it with
`docker compose logs -f ocr`. Models are cached in the `paddle-models` volume, so later starts are
fast.

**Requirements.** Give Docker at least 4 GB of RAM (Docker Desktop → Settings → Resources);
PaddlePaddle needs ~1.5–2 GB while running. Roughly 3 GB of disk for the images and models.

**Apple Silicon (M1/M2/M3/M4).** PaddlePaddle publishes no `linux/arm64` wheels, so the OCR image
fails to build on ARM with `No matching distribution found for paddlepaddle`. Two ways round it:

* uncomment `platform: linux/amd64` under the `ocr` service in `docker-compose.yml` and rebuild —
  it then runs under emulation, which works but is several times slower; or
* run the app in Docker and the sidecar natively on macOS (`pip install -r ocr-service/requirements.txt`
  picks the right wheel there), pointing the app at `http://host.docker.internal:8868`.

Everything except OCR — the UI, digital-PDF parsing, validation, export — runs natively on ARM
either way.

**Checking it works.**

```bash
curl http://localhost:3000/health/ready     # {"status":"ok","ocr":{"available":true,...}}
docker compose ps                           # ocr should be "healthy"
curl -F "files=@invoice.pdf" http://localhost:3000/api/invoices
```

**Stopping and cleaning up.**

```bash
docker compose down            # stop, keep the downloaded models
docker compose down -v         # also delete the model cache
```

**If something goes wrong.**

| Symptom | Cause and fix |
| --- | --- |
| `No matching distribution found for paddlepaddle` | ARM host — see Apple Silicon above |
| OCR container killed / exit 137 | Out of memory — raise Docker's RAM limit to 4 GB+ |
| `ocr` never becomes healthy | Watch `docker compose logs -f ocr`; usually a slow model download. `curl http://localhost:8868/health` shows `missing_dependencies` if an import failed |
| App starts but readiness says `available: false` | The app cannot reach the sidecar; confirm `OCR_SERVICE_URL=http://ocr:8868` (the service name, not localhost) |
| Uploads return `413` | Raise `MAX_FILE_SIZE_BYTES` in the `app` service environment |
| A scanned page returns no text | Raise `OCR_PDF_DPI` to 300, and check `?debug=true` output for what was recognised |

### 4. Deploy to Vercel

```bash
vercel deploy            # from invoice-scanner/, or set Root Directory = invoice-scanner
```

`api/index.js` hands the request to the very same Fastify application; `vercel.json` routes the API
paths to it and lets the platform serve `public/` directly.

**What works there and what does not.** PaddleOCR cannot run on a serverless host, so the deployment
defaults to `OCR_PROVIDER=none`:

* PDFs that contain a text layer — the majority of invoices issued by software — parse exactly, with
  full validation and export. `/health/ready` reports `"mode": "pdf-text-layer-only"` and the UI says
  so in the header.
* Scans and images are rejected with `OCR_UNAVAILABLE` and a message saying what to configure.
* To get OCR there too, run `ocr-service/` anywhere reachable (a small VM, Fly.io, Cloud Run) and set
  `OCR_PROVIDER=paddle` + `OCR_SERVICE_URL=https://…` in the Vercel project's environment variables.
  Nothing in the code changes.

**Platform limits worth knowing.** Request bodies are capped at 4.5 MB, so `MAX_FILE_SIZE_BYTES`
defaults to 4 MB there. Function timeout is 60 s. `/tmp` is the only writable directory. Instances do
not share memory, so a stored batch may not be found by a later request — which is why the UI exports
by posting the data it already holds to `POST /api/export` rather than relying on
`GET /api/export/:batchId`. Persist batches through a `BatchRepository` if you need those links to
work across instances.

### Production build

```bash
npm run build
npm start
```

---

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness. Never touches dependencies. |
| `GET` | `/health/ready` | Readiness, including the OCR back-end. `503` when OCR is down. |
| `POST` | `/api/invoices` (alias `/upload`) | Upload 1..N files, returns extracted invoices. |
| `GET` | `/api/invoices/:batchId` | Re-read a processed batch. |
| `GET` | `/api/batches` | List recent batches. |
| `GET` | `/api/export/:batchId?format=json\|csv` (alias `/export/:batchId`) | Download a batch. |
| `POST` | `/api/export` | Export an arbitrary (e.g. user-corrected) invoice array. |
| `GET` | `/` | Upload UI. |

### Upload

```bash
curl -F "files=@invoice1.pdf" \
     -F "files=@invoice2.jpg" \
     -F "files=@scan-3-pages.pdf" \
     http://localhost:3000/api/invoices
```

Add `?debug=true` to include per-field candidate lists (with scores and the reason each rule fired)
and the recognised page text.

Response:

```jsonc
{
  "batchId": "batch_9f1c…",
  "summary": { "total": 3, "ok": 2, "needsReview": 1, "failed": 0 },
  "invoices": [
    {
      "id": "inv_2b6e…",
      "status": "ok",                       // ok | needs_review | failed
      "invoice": { /* the normalised schema */ },
      "quality": {
        "classification": "invoice",        // invoice | probably-invoice | not-an-invoice | unreadable
        "invoiceScore": 0.92,
        "meanOcrConfidence": 0.97,
        "detectedLanguages": ["en"]
      },
      "issues": [ { "code": "LOW_FIELD_CONFIDENCE", "severity": "warning", "field": "assignee", "message": "…" } ],
      "fieldConfidence": { "issuer": 0.78, "invoiceSumAndVat": 0.91 },
      "meta": { "pageCount": 3, "ocrEngine": "paddleocr", "processingMs": 4210 }
    }
  ],
  "rejected": [ { "sourceFileName": "notes.txt", "code": "UNSUPPORTED_FILE_TYPE", "message": "…" } ],
  "exports": { "json": "/api/export/batch_9f1c…?format=json", "csv": "/api/export/batch_9f1c…?format=csv" }
}
```

### Export

```bash
curl -o invoices.json "http://localhost:3000/api/export/$BATCH_ID?format=json"
curl -o invoices.csv  "http://localhost:3000/api/export/$BATCH_ID?format=csv"
```

The JSON export is exactly an array of the normalised schema. The CSV has one row per invoice (plus
one row per rejected file) and starts with a UTF-8 BOM so Excel renders Hebrew correctly.

### Errors

Every failure returns `{ "error": { "code", "message", "details? } }` with a meaningful status:
`400` bad request, `413` file too large / too many files, `415` unsupported type, `422` unreadable
document, `502` OCR failed, `503` OCR unavailable.

---

## Parsing strategy

Raw OCR text alone is not enough, so extraction combines several signals:

* **Layout** (`modules/parsing/layout.ts`) – lines carry normalised boxes, so rules can ask for "the
  cell to the right of this label", "the line below", "the top 25 % of page 1" or "how large is this
  text compared with the rest of the page". This is what lets `Bill To:` in one cell find its value
  in the neighbouring cell, and RTL layouts put the value to the *left* of the label.
* **Bilingual keyword dictionaries** (`keywords.ts`) – Hebrew and English terms in one place.
  Matching is done on folded text, so `מע"מ`, `מע״מ` and `מעמ` all hit the same entry. The longest
  matching term wins, which is why `Total including VAT` is a gross total and not a VAT amount.
* **Regex + normalisation** – amounts (`1,234.56`, `1.234,56`, `1 234,56`, `(1,234.56)`), dates
  (`14/03/2025`, `2025-03-14`, `14 March 2025`, `5 בפברואר 2025`, `20250314`), reference numbers.
* **Arithmetic reconciliation** – `net + VAT = gross` is the strongest signal on an invoice, so it is
  used *while choosing* between candidates, not only afterwards. The extractor scores combinations of
  candidate amounts (including unlabelled amounts near the totals block) and prefers the one that
  balances and whose implied VAT rate is a known rate. A missing third value is derived from the
  other two, and says so in the warnings.
* **Confidence** – OCR line confidence feeds every score; lines below `OCR_MIN_LINE_CONFIDENCE` are
  dropped before parsing.
* **Negative rules** – due dates, delivery dates, phone numbers, bank details, company registration
  numbers and percentage tokens are actively down-ranked so they cannot be mistaken for the invoice
  date, number or amounts.

Each rule emits `{ value, score, source, reasons[] }`. The **field mapper** (`fieldMapper.ts`) is the
only place that turns candidates into the final schema:

* below `FIELD_MIN_SCORE` → `null` + a warning naming the discarded candidate,
* a runner-up within 0.05 of the winner → the winner is kept but the field is flagged `AMBIGUOUS_FIELD`,
* alternatives are always preserved in the `?debug=true` output.

### Document classification

Before extraction, the document is scored for "invoice-ness" from keyword evidence and OCR quality:

* `invoice` / `probably-invoice` – parsed normally (`probably-invoice` adds a warning),
* `not-an-invoice` – quotes, purchase orders, delivery notes… → status `failed`, `NOT_AN_INVOICE`,
* `unreadable` – too little text or hopeless confidence → status `failed`, `DOCUMENT_UNREADABLE`.

### Validation rules

| Code | Severity | Meaning |
| --- | --- | --- |
| `AMOUNT_MISMATCH` | error | `invoiceSum + invoiceVat ≠ invoiceSumAndVat` beyond tolerance |
| `AMOUNT_INCOMPLETE` | warning | the breakdown is missing, so the total could not be cross-checked |
| `UNEXPECTED_VAT_RATE` | warning | implied rate is not in `EXPECTED_VAT_RATES` |
| `NEGATIVE_AMOUNT` | warning | possibly a credit note |
| `MISSING_FIELD` | warning | required field is `null` |
| `AMBIGUOUS_FIELD` | warning | two candidates were nearly tied |
| `LOW_FIELD_CONFIDENCE` | warning | selected candidate scored < 0.5 |
| `LOW_OCR_CONFIDENCE` | warning | mean OCR confidence below `LOW_QUALITY_CONFIDENCE` |
| `FUTURE_DATE` / `INVALID_DATE` | warning / error | date sanity |
| `NOT_AN_INVOICE` / `DOCUMENT_UNREADABLE` | error | see classification |

`status` is `failed` if any error, `needs_review` if any warning, otherwise `ok`.

---

## Hebrew and English

* Text normalisation handles Hebrew gershayim/geresh, niqqud, bidi control characters, Arabic-Indic
  digits and Hebrew month names, and every keyword dictionary is bilingual.
* Layout rules are direction-agnostic: a label's value is looked for on both sides of the row and on
  the line below, ranked by distance.
* **PaddleOCR caveat, stated honestly:** PaddleOCR's Latin and CJK recognition is excellent; its
  Hebrew coverage depends on the model set installed with your PaddleOCR version and is generally
  weaker. Set `OCR_LANGS` to the codes your installation actually provides. `OCR_LANGS` accepts
  several codes (e.g. `OCR_LANGS=he,en`): the sidecar runs one pass per language and merges the
  results, keeping the higher-confidence detection where boxes overlap — which is what makes a mixed
  Hebrew/English invoice readable. If Hebrew recognition quality is not sufficient for your
  documents, implement `OcrProvider` against an engine that suits them; nothing outside
  `modules/ocr/` changes.
* Digital-born Hebrew PDFs bypass OCR entirely via the text layer and parse exactly.

---

## Configuration

All variables live in `.env.example` with comments; the most relevant ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP binding |
| `OCR_PROVIDER` | `paddle` | `paddle`, `mock`, or `none` (text-layer PDFs only) |
| `OCR_SERVICE_URL` | `http://127.0.0.1:8868` | PaddleOCR sidecar |
| `OCR_LANGS` | `en` | comma-separated PaddleOCR language codes |
| `OCR_PDF_DPI` | `200` | rasterisation DPI for scanned PDFs |
| `OCR_MIN_LINE_CONFIDENCE` | `0.45` | drop noisier lines before parsing |
| `OCR_CONCURRENCY` | `2` | pages/files OCR'd in parallel |
| `PDF_TEXT_LAYER_ENABLED` | `true` | use embedded PDF text when present |
| `DATE_ORDER` | `DMY` | how `03/04/2025` is read |
| `AMOUNT_TOLERANCE_ABS` / `_REL` | `0.05` / `0.001` | rounding tolerance for `sum + vat = total` |
| `EXPECTED_VAT_RATES` | `18,17,20,19,21,23,25` | plausible VAT rates (Israel first) |
| `FIELD_MIN_SCORE` | `0.35` | below this a field becomes `null` |
| `MAX_FILE_SIZE_BYTES` / `MAX_FILES_PER_BATCH` / `MAX_PAGES_PER_DOCUMENT` | `20 MB` / `25` / `25` | limits |

Configuration is validated with zod at startup; an invalid value stops the process with a readable
message instead of failing later.

### PaddleOCR tuning

`ocr-service/.env.example` documents the detector settings, pre-tuned for dense invoice tables
(lower `det_db_box_thresh`, larger `det_db_unclip_ratio`, `use_angle_cls` on for rotated scans).

---

## The OCR service contract

`POST /ocr`, `multipart/form-data`: `file` (image or one-page PDF), `languages` (csv), `dpi`.

```jsonc
{
  "engine": "paddleocr:en",
  "languages": ["en"],
  "pages": [
    {
      "page_number": 1,
      "width": 1654,
      "height": 2339,
      "lines": [
        { "text": "Total including VAT", "confidence": 0.987,
          "box": { "x0": 1032.0, "y0": 1904.5, "x1": 1338.0, "y1": 1937.0 } }
      ],
      "warnings": []
    }
  ]
}
```

Boxes are axis-aligned, in page pixels, origin top-left. The Node client validates every response
with zod, retries transient failures with exponential backoff (`OCR_MAX_RETRIES`) and distinguishes
"service down" (`503 OCR_UNAVAILABLE`) from "page failed" (`502 OCR_FAILED`).

Swapping engines means implementing `OcrProvider` (`src/modules/ocr/provider.ts`) and registering it
in `createOcrProvider` — three methods, no other file changes.

---

## Tests

```bash
npm test          # 75 tests
npm run typecheck
```

* `tests/parsing.test.ts` – amount/date/keyword primitives and full extraction over six fixtures
  (English, Hebrew, multi-page, quotation, unreadable scan, arithmetic mismatch).
* `tests/validation.test.ts` – every validation rule, including that the reconciler does **not**
  silently repair a document whose totals really disagree.
* `tests/export.test.ts` – JSON schema, CSV rows/quoting/BOM, rejected files.
* `tests/api.test.ts` – the HTTP surface end to end: multi-file batches, multi-page documents,
  export, debug output, error codes, magic-byte type detection, and one bad file not breaking a batch.
* `tests/pdfTextLayer.test.ts` – real PDFs through the text-layer fast path, including a provider
  that throws if OCR is touched unnecessarily.
* `tests/paddleProvider.test.ts` – the sidecar contract, against an HTTP stub that speaks it:
  multipart upload, response validation, retry-on-5xx, no-retry-on-4xx, health and unreachability.

### Mock OCR

`OCR_PROVIDER=mock` replays `tests/fixtures/mock-ocr/<file base name>.json`:

```jsonc
{
  "width": 1000, "height": 1400,
  "lines": [
    { "text": "TAX INVOICE", "confidence": 0.99, "box": { "x0": 700, "y0": 58, "x1": 930, "y1": 92 } }
  ]
}
```

Multi-page fixtures use `{ "pages": [ … ] }`; `box` may be omitted and lines are then laid out
top-to-bottom. Recording a real PaddleOCR response into this format is the fastest way to add a
regression test for a new invoice template.

---

## Extending the application

The seams that matter are already in place:

* **Database storage** – implement `BatchRepository` (`modules/store/batchRepository.ts`: `save`,
  `get`, `list`, `delete`) and pass it to `createServer({ batches: new PostgresBatchRepository(…) })`.
  Nothing else knows how batches are stored.
* **Email ingestion** – `InvoicePipeline.processBatch()` takes `{ fileName, buffer }[]` and is not
  coupled to HTTP. An IMAP/webhook poller only has to fetch attachments and call it, then persist the
  batch through the same repository.
* **Async processing** – for large batches, return `202` from `POST /api/invoices` after enqueueing,
  and run the same pipeline in a worker. The pipeline is already bounded by `OCR_CONCURRENCY`.
* **New fields** – add an extractor under `modules/parsing/extractors/`, register it in
  `fieldMapper.ts`, extend `Invoice` and the CSV columns.
* **New languages** – add terms to `keywords.ts` and the relevant month names to `dates.ts`.
* **Human corrections** – `POST /api/export` already accepts a corrected invoice array, which is the
  natural hook for a review UI.

---

## Limitations

* One uploaded file is one invoice; several invoices concatenated in a single PDF are not split
  (the page model makes this a contained change in `DocumentProcessor`).
* Line items are not extracted, only invoice-level totals.
* Currency is not part of the schema; amounts are numbers as printed.
* Batches are kept in memory (`BATCH_TTL_MS`) until a `BatchRepository` backed by a database is wired
  in — export what you need, or add persistence.
