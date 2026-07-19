const elements = {
  allCount: document.querySelector('#allCount'),
  connectionStatus: document.querySelector('#connectionStatus'),
  fieldSelect: document.querySelector('#fieldSelect'),
  lastRefresh: document.querySelector('#lastRefresh'),
  laneSelect: document.querySelector('#laneSelect'),
  locationSelect: document.querySelector('#locationSelect'),
  queueList: document.querySelector('#queueList'),
  queueSubheading: document.querySelector('#queueSubheading'),
  outreachList: document.querySelector('#outreachList'),
  outreachSubheading: document.querySelector('#outreachSubheading'),
  readyCount: document.querySelector('#readyCount'),
  refreshButton: document.querySelector('#refreshButton'),
  retainedCount: document.querySelector('#retainedCount'),
  reviewCount: document.querySelector('#reviewCount'),
  selectedCount: document.querySelector('#selectedCount'),
  snoozeDate: document.querySelector('#snoozeDate'),
  snoozeDialog: document.querySelector('#snoozeDialog'),
  snoozeForm: document.querySelector('#snoozeForm'),
  snoozeRoleName: document.querySelector('#snoozeRoleName'),
  sortSelect: document.querySelector('#sortSelect'),
  toast: document.querySelector('#toast'),
};

const ui = {
  field: 'all',
  filter: 'all',
  lane: 'all',
  location: 'all',
  sort: 'priority',
  state: null,
  snoozeItemId: null,
  toastTimer: null,
};

const COMPANY_FIELD_RULES = [
  { label: 'AI & machine learning', terms: ['anthropic', 'cohere', 'deepgram', 'elevenlabs', 'hugging face', 'langchain', 'lovable', 'physicsx'] },
  { label: 'AI infrastructure & ML tools', terms: ['coreweave', 'weights & biases'] },
  { label: 'Robotics & autonomous systems', terms: ['nuro', 'wayve'] },
  { label: 'Developer tools & cloud', terms: ['n8n', 'sentry', 'temporal', 'vercel', 'zapier'] },
  { label: 'Data platforms & analytics', terms: ['glean', 'palantir', 'sigma computing', 'tinybird'] },
  { label: 'Productivity & collaboration', terms: ['airtable', 'attio', 'intercom'] },
  { label: 'Content & digital experience', terms: ['contentful'] },
  { label: 'Fintech & payments', terms: ['n26', 'ramp', 'sumup'] },
  { label: 'Travel & marketplaces', terms: ['airbnb'] },
  { label: 'Audio & media', terms: ['spotify', 'twitch'] },
  { label: 'Sports & ticketing', terms: ['seatgeek'] },
  { label: 'Legal technology', terms: ['legora'] },
  { label: 'Process intelligence', terms: ['celonis'] },
  { label: 'Cloud & consumer technology', terms: ['amazon', 'aws', 'adci', 'evi technologies', 'annapurna labs'] },
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHref(value) {
  const href = String(value || '');
  return /^https?:\/\//i.test(href) ? href : '#';
}

function humanize(value) {
  return String(value || '')
    .replace(/^Job Leads\//i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function companyField(item) {
  const explicit = item.companyField || item.industry || item.field;
  if (explicit) return String(explicit);
  const company = String(item.company || '').toLowerCase();
  const match = COMPANY_FIELD_RULES.find((rule) => rule.terms.some((term) => company.includes(term)));
  return match?.label || 'Unclassified';
}

function locationLabel(item) {
  return String(item.location || '').trim() || 'Location not listed';
}

function statusLabel(status) {
  return status === 'ready' ? 'Ready' : 'Needs review';
}

function formatDate(value) {
  if (!value) return '—';
  const raw = String(value);
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function dateValue(value) {
  if (!value) return null;
  const raw = String(value);
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00` : value);
  const timestamp = date.getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function formatDateTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function tomorrow() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function selectedItems() {
  return Array.isArray(ui.state?.selected) ? ui.state.selected : [];
}

function filteredItems() {
  const items = selectedItems().filter((item) => {
    const matchesFilter = ui.filter === 'all'
      || (ui.filter === 'ready' && item.status === 'ready')
      || (ui.filter === 'review' && item.status === 'in_review');
    const matchesLane = ui.lane === 'all' || item.lane === ui.lane;
    const matchesField = ui.field === 'all' || companyField(item) === ui.field;
    const matchesLocation = ui.location === 'all' || locationLabel(item) === ui.location;
    return matchesFilter && matchesLane && matchesField && matchesLocation;
  });
  return items.sort((left, right) => {
    if (ui.sort === 'field') {
      return companyField(left).localeCompare(companyField(right))
        || String(left.company || '').localeCompare(String(right.company || ''))
        || Number(left.queueRank || 999) - Number(right.queueRank || 999);
    }
    if (ui.sort === 'company') {
      return String(left.company || 'Unclassified').localeCompare(String(right.company || 'Unclassified'))
        || Number(left.queueRank || 999) - Number(right.queueRank || 999);
    }
    if (ui.sort === 'location') {
      const leftLocation = locationLabel(left);
      const rightLocation = locationLabel(right);
      if (leftLocation === 'Location not listed' && rightLocation !== 'Location not listed') return 1;
      if (leftLocation !== 'Location not listed' && rightLocation === 'Location not listed') return -1;
      return leftLocation.localeCompare(rightLocation)
        || Number(left.queueRank || 999) - Number(right.queueRank || 999);
    }
    if (ui.sort === 'posted-newest' || ui.sort === 'posted-oldest') {
      const leftDate = dateValue(left.postedAt);
      const rightDate = dateValue(right.postedAt);
      if (leftDate === null && rightDate !== null) return 1;
      if (leftDate !== null && rightDate === null) return -1;
      if (leftDate !== null && rightDate !== null && leftDate !== rightDate) {
        return ui.sort === 'posted-newest' ? rightDate - leftDate : leftDate - rightDate;
      }
    }
    return Number(left.queueRank || 999) - Number(right.queueRank || 999);
  });
}

function renderFieldOptions() {
  const fields = [...new Set(selectedItems().map(companyField))].sort((left, right) => left.localeCompare(right));
  const current = ui.field;
  elements.fieldSelect.innerHTML = '<option value="all">All fields</option>'
    + fields.map((field) => `<option value="${escapeHtml(field)}">${escapeHtml(field)}</option>`).join('');
  elements.fieldSelect.value = fields.includes(current) ? current : 'all';
  ui.field = elements.fieldSelect.value;
}

function renderLocationOptions() {
  const locations = [...new Set(selectedItems().map(locationLabel))]
    .sort((left, right) => left.localeCompare(right));
  const current = ui.location;
  elements.locationSelect.innerHTML = '<option value="all">All locations</option>'
    + locations.map((location) => `<option value="${escapeHtml(location)}">${escapeHtml(location)}</option>`).join('');
  elements.locationSelect.value = locations.includes(current) ? current : 'all';
  ui.location = elements.locationSelect.value;
}

function renderLaneOptions() {
  const lanes = [...new Set(selectedItems().map((item) => item.lane).filter(Boolean))].sort();
  const current = ui.lane;
  elements.laneSelect.innerHTML = '<option value="all">All lanes</option>'
    + lanes.map((lane) => `<option value="${escapeHtml(lane)}">${escapeHtml(humanize(lane))}</option>`).join('');
  elements.laneSelect.value = lanes.includes(current) ? current : 'all';
  ui.lane = elements.laneSelect.value;
}

function renderSummary() {
  const totals = ui.state?.totals || {};
  const selected = selectedItems();
  elements.selectedCount.textContent = String(totals.selected ?? selected.length);
  elements.retainedCount.textContent = String(totals.retained ?? '—');
  elements.readyCount.textContent = String(selected.filter((item) => item.status === 'ready').length);
  elements.reviewCount.textContent = String(selected.filter((item) => item.status === 'in_review').length);
  elements.allCount.textContent = String(selected.length);
  elements.lastRefresh.textContent = formatDateTime(ui.state?.lastRun?.at);
}

function renderItem(item) {
  const reasons = Array.isArray(item.fitReasons) ? item.fitReasons : [];
  const company = item.company || 'Company not parsed';
  const location = item.location || 'Location not listed';
  const field = companyField(item);
  const score = Number(item.fitScore || 0).toFixed(1);
  const statusClass = item.status === 'ready' ? 'tag-status-ready' : 'tag-status-review';
  const reasonsMarkup = reasons.length
    ? `<ul>${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
    : '<p>No fit notes were recorded for this role.</p>';
  return `
    <article class="queue-row" data-item-id="${escapeHtml(item.id)}">
      <div class="queue-index">${escapeHtml(String(item.queueRank || '—').padStart(2, '0'))}</div>
      <div class="queue-content">
        <div class="queue-title-line">
          <div>
            <h3>${escapeHtml(item.title || 'Job lead')}</h3>
            <p class="queue-company">${escapeHtml(company)} <span>·</span> ${escapeHtml(location)} <span>·</span> Posted ${escapeHtml(formatDate(item.postedAt))}</p>
          </div>
          <span class="score-badge" title="Fit score">${escapeHtml(score)}/5</span>
        </div>
        <div class="queue-meta">
          <span class="tag ${statusClass}">${escapeHtml(statusLabel(item.status))}</span>
          <span class="tag">${escapeHtml(field)}</span>
          <span class="tag">${escapeHtml(humanize(item.lane))}</span>
          <span class="tag">${escapeHtml(humanize(item.sourceLabel || item.source))}</span>
        </div>
        <details class="queue-details">
          <summary>Why this role</summary>
          ${reasonsMarkup}
          <p>Evidence: ${escapeHtml(item.fitConfidence || 'limited')} confidence · ${escapeHtml(item.liveness || 'unknown')} link</p>
        </details>
      </div>
      <div class="queue-actions">
        <a class="button button-primary" href="${escapeHtml(safeHref(item.applyUrl || item.canonicalUrl))}" target="_blank" rel="noopener">Open role</a>
        <button class="button" type="button" data-action="applied" data-id="${escapeHtml(item.id)}">Applied</button>
        <button class="button" type="button" data-action="snooze" data-id="${escapeHtml(item.id)}">Later</button>
        <button class="button button-danger" type="button" data-action="skipped" data-id="${escapeHtml(item.id)}">Skip</button>
      </div>
    </article>`;
}

function renderOutreach() {
  const records = Array.isArray(ui.state?.outreach) ? ui.state.outreach : [];
  elements.outreachSubheading.textContent = records.length
    ? `${records.length} application${records.length === 1 ? '' : 's'} in the outreach workflow.`
    : 'Your application signals and contact drafts will appear here.';
  if (!records.length) {
    elements.outreachList.innerHTML = '<div class="outreach-empty">No submitted applications are waiting for outreach.</div>';
    return;
  }
  elements.outreachList.innerHTML = records.map((record) => {
    const contacts = Array.isArray(record.contacts) ? record.contacts : [];
    const contactsMarkup = contacts.length
      ? contacts.map((contact) => `
          <div class="outreach-contact">
            <div>
              <strong>${escapeHtml(contact.name || 'Unnamed contact')}</strong>
              <span>${escapeHtml(contact.title || humanize(contact.type))}</span>
            </div>
            <div class="outreach-contact-meta">
              <span class="tag">${escapeHtml(humanize(contact.initialStatus || 'pending'))}</span>
              ${contact.emailVerified ? '<span class="tag tag-status-ready">Verified email</span>' : '<span class="tag">LinkedIn/manual</span>'}
              ${contact.followUpDueAt ? `<span class="outreach-due">Follow-up ${escapeHtml(formatDate(contact.followUpDueAt))}</span>` : ''}
            </div>
            ${contact.linkedinDraft ? `<details class="outreach-draft"><summary>LinkedIn draft</summary><p>${escapeHtml(contact.linkedinDraft)}</p></details>` : ''}
          </div>`).join('')
      : `<p class="outreach-empty">No eligible contacts yet. Search: ${escapeHtml(record.searchQuery || 'company hiring manager recruiter team')}</p>`;
    return `
      <article class="outreach-card">
        <div class="outreach-card-heading">
          <div>
            <h3>${escapeHtml(record.title || 'Job lead')}</h3>
            <p>${escapeHtml(record.company || 'Company not parsed')}</p>
          </div>
          <span class="tag tag-status-ready">${escapeHtml(humanize(record.status || 'pending'))}</span>
        </div>
        <div class="outreach-contacts">${contactsMarkup}</div>
      </article>`;
  }).join('');
}

function renderQueue() {
  const items = filteredItems();
  elements.queueList.setAttribute('aria-busy', 'false');
  elements.queueSubheading.textContent = items.length === selectedItems().length
    ? `${items.length} role${items.length === 1 ? '' : 's'} selected for this session.`
    : `${items.length} of ${selectedItems().length} selected roles match this view.`;
  if (!items.length) {
    elements.queueList.innerHTML = `
      <div class="empty-state">
        <h3>${selectedItems().length ? 'Nothing in this view.' : 'The queue is clear for now.'}</h3>
        <p>${selectedItems().length ? 'Try another status or lane filter.' : 'Refresh sources when you are ready for the next set of roles.'}</p>
        <button class="button button-primary" type="button" data-empty-refresh>Refresh sources</button>
      </div>`;
    return;
  }
  elements.queueList.innerHTML = items.map(renderItem).join('');
}

function render() {
  if (!ui.state) return;
  renderSummary();
  renderFieldOptions();
  renderLocationOptions();
  renderLaneOptions();
  renderQueue();
  renderOutreach();
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.filter === ui.filter);
  });
}

function setConnection(ok) {
  const dot = elements.connectionStatus.querySelector('.status-dot');
  dot.classList.toggle('is-error', !ok);
  elements.connectionStatus.lastChild.textContent = ok ? 'Local queue' : 'Queue unavailable';
}

function showToast(message, isError = false) {
  clearTimeout(ui.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', isError);
  elements.toast.classList.add('is-visible');
  ui.toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 3400);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function loadQueue({ quiet = false } = {}) {
  try {
    ui.state = await requestJson('/api/queue');
    setConnection(true);
    render();
  } catch (error) {
    setConnection(false);
    elements.queueList.setAttribute('aria-busy', 'false');
    elements.queueList.innerHTML = '<div class="empty-state"><h3>Could not load the queue.</h3><p>Make sure the local queue server is running, then try again.</p></div>';
    if (!quiet) showToast(error instanceof Error ? error.message : String(error), true);
  }
}

async function refreshQueue() {
  elements.refreshButton.disabled = true;
  elements.refreshButton.textContent = 'Refreshing…';
  elements.queueList.setAttribute('aria-busy', 'true');
  try {
    const payload = await requestJson('/api/refresh', { method: 'POST' });
    ui.state = payload.state;
    setConnection(true);
    render();
    showToast('Sources refreshed. Your queue is ready.');
  } catch (error) {
    setConnection(false);
    showToast(error instanceof Error ? error.message : String(error), true);
  } finally {
    elements.refreshButton.disabled = false;
    elements.refreshButton.textContent = 'Refresh sources';
    elements.queueList.setAttribute('aria-busy', 'false');
  }
}

async function mutateItem(id, action, extra = {}) {
  const row = document.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
  row?.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const payload = await requestJson('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, action, ...extra }),
    });
    ui.state = payload.state;
    setConnection(true);
    render();
    let outreachMessage = '';
    if (action === 'applied') {
      try {
        const outreach = await requestJson('/api/outreach/process', { method: 'POST' });
        ui.state.outreach = outreach.outreach || ui.state.outreach || [];
        render();
        outreachMessage = ' Outreach was queued and processed.';
      } catch {
        outreachMessage = ' Outreach was queued for the next scheduled run.';
      }
    }
    const messages = { applied: 'Marked applied and recorded in the tracker.', skipped: 'Skipped for now.', snoozed: `Snoozed until ${extra.snoozeUntil}.` };
    showToast(`${messages[action] || 'Queue updated.'}${outreachMessage}`);
  } catch (error) {
    row?.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    showToast(error instanceof Error ? error.message : String(error), true);
  }
}

function openSnoozeDialog(id) {
  const item = selectedItems().find((candidate) => candidate.id === id);
  if (!item) return;
  ui.snoozeItemId = id;
  elements.snoozeRoleName.textContent = `${item.title || 'This role'} · ${item.company || 'Company not parsed'}`;
  elements.snoozeDate.min = tomorrow();
  elements.snoozeDate.value = tomorrow();
  elements.snoozeDialog.showModal();
  elements.snoozeDate.focus();
}

elements.refreshButton.addEventListener('click', refreshQueue);
elements.laneSelect.addEventListener('change', () => {
  ui.lane = elements.laneSelect.value;
  renderQueue();
});

elements.fieldSelect.addEventListener('change', () => {
  ui.field = elements.fieldSelect.value;
  renderQueue();
});

elements.locationSelect.addEventListener('change', () => {
  ui.location = elements.locationSelect.value;
  renderQueue();
});

elements.sortSelect.addEventListener('change', () => {
  ui.sort = elements.sortSelect.value;
  renderQueue();
});
document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    ui.filter = button.dataset.filter || 'all';
    render();
  });
});
elements.queueList.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
  if (target) {
    const id = target.dataset.id;
    const action = target.dataset.action;
    if (!id || !action) return;
    if (action === 'snooze') openSnoozeDialog(id);
    else mutateItem(id, action);
    return;
  }
  const emptyRefresh = event.target instanceof Element ? event.target.closest('[data-empty-refresh]') : null;
  if (emptyRefresh) refreshQueue();
});
elements.snoozeForm.addEventListener('submit', (event) => {
  if (event.submitter?.value !== 'confirm') {
    ui.snoozeItemId = null;
    return;
  }
  event.preventDefault();
  const id = ui.snoozeItemId;
  const date = elements.snoozeDate.value;
  elements.snoozeDialog.close();
  ui.snoozeItemId = null;
  if (id && date) mutateItem(id, 'snoozed', { snoozeUntil: date });
});

loadQueue();
setInterval(() => loadQueue({ quiet: true }), 60_000);
