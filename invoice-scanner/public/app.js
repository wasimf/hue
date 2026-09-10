/* Minimal dependency-free front-end for the invoice scanner API. */
(() => {
  const form = document.getElementById('upload-form');
  const input = document.getElementById('file-input');
  const dropzone = document.getElementById('dropzone');
  const fileList = document.getElementById('file-list');
  const submit = document.getElementById('submit');
  const status = document.getElementById('status');
  const results = document.getElementById('results');
  const summary = document.getElementById('summary');
  const tableBody = document.querySelector('#results-table tbody');
  const details = document.getElementById('details');
  const debugToggle = document.getElementById('debug-toggle');
  const health = document.getElementById('health');

  /** @type {File[]} */
  let selected = [];

  function renderSelection() {
    fileList.innerHTML = '';
    for (const file of selected) {
      const item = document.createElement('li');
      item.textContent = `${file.name} (${Math.max(1, Math.round(file.size / 1024))} KB)`;
      fileList.append(item);
    }
    submit.disabled = selected.length === 0;
  }

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('status--error', isError);
  }

  function formatAmount(value) {
    return value === null || value === undefined
      ? null
      : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function cell(row, value, className = '') {
    const td = document.createElement('td');
    if (value === null || value === undefined || value === '') {
      td.textContent = '—';
      td.className = `missing ${className}`.trim();
    } else {
      td.textContent = value;
      td.className = className;
    }
    row.append(td);
    return td;
  }

  function renderBatch(batch) {
    summary.textContent = `${batch.summary.total} file(s) · ${batch.summary.ok} ok · ${batch.summary.needsReview} to review · ${batch.summary.failed} failed`;
    tableBody.innerHTML = '';
    details.innerHTML = '';

    for (const entry of batch.invoices) {
      const invoice = entry.invoice;
      const row = document.createElement('tr');
      cell(row, invoice.sourceFileName);

      const statusCell = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = `pill pill--${entry.status}`;
      pill.textContent = entry.status.replace('_', ' ');
      statusCell.append(pill);
      row.append(statusCell);

      cell(row, invoice.issuer);
      cell(row, invoice.invoiceDate);
      cell(row, invoice.invoiceNumber);
      cell(row, invoice.assignee);
      cell(row, formatAmount(invoice.invoiceSum), 'numeric');
      cell(row, formatAmount(invoice.invoiceVat), 'numeric');
      cell(row, formatAmount(invoice.invoiceSumAndVat), 'numeric');
      tableBody.append(row);

      if (invoice.warnings.length > 0 || entry.debug) {
        const block = document.createElement('details');
        const title = document.createElement('summary');
        title.textContent = `${invoice.sourceFileName} — ${invoice.warnings.length} warning(s), ${entry.meta.pageCount} page(s), ${entry.meta.ocrEngine}`;
        block.append(title);

        const list = document.createElement('ul');
        for (const warning of invoice.warnings) {
          const item = document.createElement('li');
          item.textContent = warning;
          list.append(item);
        }
        block.append(list);

        if (entry.debug) {
          const pre = document.createElement('pre');
          pre.textContent = JSON.stringify(entry.debug, null, 2);
          block.append(pre);
        }
        details.append(block);
      }
    }

    for (const rejection of batch.rejected) {
      const row = document.createElement('tr');
      cell(row, rejection.sourceFileName);
      const statusCell = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = 'pill pill--failed';
      pill.textContent = rejection.code;
      statusCell.append(pill);
      row.append(statusCell);
      const message = document.createElement('td');
      message.colSpan = 7;
      message.textContent = rejection.message;
      row.append(message);
      tableBody.append(row);
    }

    document.getElementById('export-json').href = batch.exports.json;
    document.getElementById('export-csv').href = batch.exports.csv;
    results.classList.remove('hidden');
  }

  input.addEventListener('change', () => {
    selected = Array.from(input.files ?? []);
    renderSelection();
  });

  ['dragenter', 'dragover'].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('dropzone--active');
    });
  });

  ['dragleave', 'drop'].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('dropzone--active');
    });
  });

  dropzone.addEventListener('drop', (event) => {
    selected = Array.from(event.dataTransfer?.files ?? []);
    renderSelection();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (selected.length === 0) return;

    const body = new FormData();
    for (const file of selected) body.append('files', file, file.name);

    submit.disabled = true;
    setStatus(`Scanning ${selected.length} file(s)…`);

    try {
      const response = await fetch(`/api/invoices${debugToggle.checked ? '?debug=true' : ''}`, {
        method: 'POST',
        body,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? `Request failed with ${response.status}`);
      }
      renderBatch(payload);
      setStatus(`Done in batch ${payload.batchId}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      submit.disabled = false;
    }
  });

  fetch('/health/ready')
    .then((response) => response.json().then((body) => ({ ok: response.ok, body })))
    .then(({ ok, body }) => {
      health.textContent = ok ? `OCR: ${body.ocr.provider} ready` : `OCR: ${body.ocr.provider} unavailable`;
      health.className = `pill pill--${ok ? 'ok' : 'failed'}`;
    })
    .catch(() => {
      health.textContent = 'API unreachable';
      health.className = 'pill pill--failed';
    });
})();
