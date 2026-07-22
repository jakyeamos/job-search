const elements = {
  allCount: document.querySelector('#allCount'),
  connectionStatus: document.querySelector('#connectionStatus'),
  clearQueueButton: document.querySelector('#clearQueueButton'),
  fieldSelect: document.querySelector('#fieldSelect'),
  lastRefresh: document.querySelector('#lastRefresh'),
  laneSelect: document.querySelector('#laneSelect'),
  locationSelect: document.querySelector('#locationSelect'),
  queueList: document.querySelector('#queueList'),
  queueSubheading: document.querySelector('#queueSubheading'),
  outreachList: document.querySelector('#outreachList'),
  outreachSubheading: document.querySelector('#outreachSubheading'),
  applicationRunProgress: document.querySelector('#applicationRunProgress'),
  applicationRunStatus: document.querySelector('#applicationRunStatus'),
  questionList: document.querySelector('#questionList'),
  handoffList: document.querySelector('#handoffList'),
  openHandoffsButton: document.querySelector('#openHandoffsButton'),
  readyCount: document.querySelector('#readyCount'),
  refreshButton: document.querySelector('#refreshButton'),
  liveCount: document.querySelector('#liveCount'),
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
  applicationPollTimer: null,
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
  elements.liveCount.textContent = String(totals.liveUnique ?? '—');
  elements.readyCount.textContent = String(selected.filter((item) => item.status === 'ready').length);
  elements.reviewCount.textContent = String(selected.filter((item) => item.status === 'in_review').length);
  elements.allCount.textContent = String(selected.length);
  elements.lastRefresh.textContent = formatDateTime(ui.state?.lastRun?.at);
}

function renderApplicationRun() {
  const run = ui.state?.applicationRun || {};
  const running = run.status === 'running';
  elements.clearQueueButton.disabled = running;
  elements.clearQueueButton.textContent = running ? 'Preparing…' : 'Prepare today’s packets';
  elements.applicationRunStatus.textContent = humanize(run.phase || run.status || 'idle');
  const current = run.current;
  const report = Array.isArray(run.report) ? run.report : [];
  const summary = current
    ? `${humanize(current.status || 'working')}: ${current.company || ''} · ${current.title || ''}`
    : report.length
      ? `${report.length} role${report.length === 1 ? '' : 's'} processed in the last run.`
      : 'Ready to process up to six high-fit roles.';
  elements.applicationRunProgress.textContent = summary;
}

function renderQuestions() {
  const questions = Array.isArray(ui.state?.questions) ? ui.state.questions : [];
  if (!questions.length) {
    elements.questionList.innerHTML = '<div class="empty-state"><h3>No answers are blocking the queue.</h3><p>Unknown required questions will appear here instead of being guessed.</p></div>';
    return;
  }
  elements.questionList.innerHTML = questions.map((question) => {
    const options = Array.isArray(question.options) ? question.options : [];
    const initialAnswer = question.answer || question.suggestedAnswer || '';
    const optionMarkup = options.length
      ? `<label class="question-field"><span>Known choices</span><select data-question-choice="${escapeHtml(question.id)}"><option value="">Choose a listed answer</option>${options.map((option) => `<option value="${escapeHtml(option)}"${option === initialAnswer ? ' selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select></label>`
      : '';
    return `<article class="question-card" data-question-id="${escapeHtml(question.id)}" data-queue-id="${escapeHtml(question.queueId)}" data-queue-ids="${escapeHtml((question.queueIds || [question.queueId]).join(','))}">
      <div class="question-card-heading"><div><h3>${escapeHtml(question.role || 'Application question')}</h3><p>${escapeHtml(question.company || 'Company not parsed')} · ${escapeHtml(question.sensitivity || 'normal')} sensitivity${question.occurrenceCount > 1 ? ` · ${escapeHtml(String(question.occurrenceCount))} applications` : ''}</p></div><span class="tag">${escapeHtml(humanize(question.scope || 'question'))}</span></div>
      <p class="question-text">${escapeHtml(question.question)}</p>
      <p class="question-reason">${escapeHtml(question.reason || 'This field needs a factual answer before submission.')}</p>
      ${optionMarkup}
      <label class="question-field"><span>Your answer</span><textarea data-question-answer="${escapeHtml(question.id)}" rows="3" placeholder="Answer only what you know to be true">${escapeHtml(initialAnswer)}</textarea></label>
      <div class="question-card-actions"><label class="question-scope"><span>Reuse at</span><select data-question-scope="${escapeHtml(question.id)}"><option value="question"${question.scope === 'question' ? ' selected' : ''}>Matching question</option><option value="role"${question.scope === 'role' ? ' selected' : ''}>This role</option><option value="company"${question.scope === 'company' ? ' selected' : ''}>This company</option></select></label><button class="button button-primary" type="button" data-question-submit="${escapeHtml(question.id)}">Save answer</button></div>
    </article>`;
  }).join('');
}

function renderHandoffs() {
  const session = ui.state?.handoffs || {};
  const pages = Array.isArray(session.pages) ? session.pages : [];
  if (!pages.length) {
    elements.handoffList.innerHTML = '<div class="empty-state"><h3>No browser handoffs are waiting.</h3><p>CAPTCHA and manual-submit applications will be grouped into one Chrome window here.</p></div>';
    return;
  }
  elements.handoffList.innerHTML = pages.map((page) => `<article class="handoff-card"><div><h3>${escapeHtml(page.title || 'Application')}</h3><p>${escapeHtml(page.company || '')}</p></div><span class="tag ${page.status === 'submitted' ? 'tag-status-ready' : ''}">${escapeHtml(humanize(page.status || 'waiting'))}</span></article>`).join('');
}

function contactDiscoveryMarkup(item) {
  const discovery = item.outreach?.discovery;
  if (!discovery) {
    return '<details class="queue-details"><summary>Email discovery</summary><p>Queued for the next queue refresh.</p></details>';
  }
  const contacts = Array.isArray(discovery.contacts) ? discovery.contacts : [];
  const hypotheses = Array.isArray(discovery.emailHypotheses) ? discovery.emailHypotheses : [];
  const contactRows = contacts.length
    ? contacts.map((contact) => `<li><strong>${escapeHtml(contact.name || 'Contact')}</strong> — ${escapeHtml(contact.title || 'Role signal')}${contact.email ? ` · <code>${escapeHtml(contact.email)}</code>${contact.emailVerified ? ' <span class="tag tag-status-ready">verified</span>' : ''}` : ' · no exact email observed'}</li>`).join('')
    : '<li>No public or first-party contact email was observed.</li>';
  const hypothesisRows = hypotheses.length
    ? `<p><strong>Review-only hypotheses</strong> — not eligible for sending:</p><ul>${hypotheses.map((hypothesis) => `<li>${escapeHtml(hypothesis.name || 'Named candidate')} · <code>${escapeHtml(hypothesis.email || 'unknown')}</code> · ${escapeHtml(hypothesis.convention || 'inferred convention')}</li>`).join('')}</ul>`
    : '';
  return `<details class="queue-details"><summary>Contact discovery · ${escapeHtml(humanize(discovery.status || 'pending'))}</summary><p>${escapeHtml(discovery.reason || 'Discovery completed without a summary.')}</p><ul>${contactRows}</ul>${hypothesisRows}</details>`;
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
        ${contactDiscoveryMarkup(item)}
      </div>
        <div class="queue-actions">
          <a class="button button-primary" href="${escapeHtml(safeHref(item.applyUrl || item.canonicalUrl))}" target="_blank" rel="noopener">Open role</a>
          <button class="button" type="button" data-action="confirmed-submitted" data-id="${escapeHtml(item.id)}">Confirm submitted</button>
          <button class="button" type="button" data-action="packet" data-id="${escapeHtml(item.id)}">${item.applicationPacket?.status ? 'Refresh packet' : 'Prepare packet'}</button>
          <button class="button" type="button" data-action="snooze" data-id="${escapeHtml(item.id)}">Later</button>
        <button class="button button-danger" type="button" data-action="skipped" data-id="${escapeHtml(item.id)}">Skip</button>
      </div>
    </article>`;
}

function outreachRunLabel(run) {
  if (!run) return 'No outreach run has been recorded yet.';
  const sent = Number(run.sent || 0);
  const retrying = Number(run.retrying || 0);
  const failed = Number(run.failed || 0);
  const held = Number(run.rateLimited || 0);
  const parts = [`${sent} accepted by Gmail`];
  if (retrying) parts.push(`${retrying} retrying after an uncertain provider result`);
  if (failed) parts.push(`${failed} failed and blocked`);
  if (held) parts.push(`${held} held by the daily limit`);
  return `${run.ok === false ? 'Needs attention: ' : ''}Last run ${parts.join(' · ')}. Gmail acceptance is not delivery confirmation.`;
}

function renderOutreach() {
  const records = Array.isArray(ui.state?.outreach) ? ui.state.outreach : [];
  const run = ui.state?.outreachRun || null;
  elements.outreachSubheading.textContent = records.length
    ? `${records.length} application${records.length === 1 ? '' : 's'} in the outreach workflow. ${outreachRunLabel(run)}`
    : `Your application signals and contact drafts will appear here. ${outreachRunLabel(run)}`;
  if (!records.length) {
    elements.outreachList.innerHTML = '<div class="outreach-empty">No application records are waiting for outreach.</div>';
    return;
  }
  elements.outreachList.innerHTML = records.map((record) => {
    const contacts = Array.isArray(record.contacts) ? record.contacts : [];
    const contactsMarkup = contacts.length
      ? contacts.map((contact) => {
        const delivery = contact.initialDeliveryStatus === 'provider_accepted'
          ? 'Accepted by Gmail'
          : contact.initialOutboxStatus === 'unknown'
            ? 'Send uncertain; retry scheduled'
            : contact.initialOutboxStatus === 'failed'
              ? 'Send failed; blocked'
              : humanize(contact.initialStatus || 'pending');
        return `
          <div class="outreach-contact">
            <div>
              <strong>${escapeHtml(contact.name || 'Unnamed contact')}</strong>
              <span>${escapeHtml(contact.title || humanize(contact.type))}</span>
            </div>
            <div class="outreach-contact-meta">
              <span class="tag">${escapeHtml(delivery)}</span>
              ${contact.emailVerified ? '<span class="tag tag-status-ready">Verified email</span>' : '<span class="tag">LinkedIn/manual</span>'}
              ${contact.followUpDueAt ? `<span class="outreach-due">Follow-up ${escapeHtml(formatDate(contact.followUpDueAt))}</span>` : ''}
            </div>
            ${(contact.initialLastError || contact.followUpLastError) ? `<p class="outreach-due">${escapeHtml(contact.initialLastError || contact.followUpLastError)}</p>` : ''}
            ${contact.linkedinDraft ? `<details class="outreach-draft"><summary>LinkedIn draft</summary><p>${escapeHtml(contact.linkedinDraft)}</p></details>` : ''}
          </div>`;
      }).join('')
      : `<p class="outreach-empty">No eligible contacts yet. Search: ${escapeHtml(record.searchQuery || 'company hiring manager recruiter team')}</p>`;
    const submissionLabel = record.submissionConfirmed
      ? `Submission confirmed${record.submissionConfirmedSource ? ` via ${humanize(record.submissionConfirmedSource)}` : ''}; email may be processed.`
      : 'Waiting for explicit submission confirmation; no email will be sent.';
    return `
      <article class="outreach-card">
        <div class="outreach-card-heading">
          <div>
            <h3>${escapeHtml(record.title || 'Job lead')}</h3>
            <p>${escapeHtml(record.company || 'Company not parsed')}</p>
          </div>
          <span class="tag ${record.submissionConfirmed ? 'tag-status-ready' : ''}">${escapeHtml(humanize(record.status || 'pending'))}</span>
        </div>
        <p class="outreach-due">${escapeHtml(submissionLabel)}</p>
        ${record.lastError ? `<p class="outreach-due">${escapeHtml(record.lastError)}</p>` : ''}
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
  renderApplicationRun();
  renderFieldOptions();
  renderLocationOptions();
  renderLaneOptions();
  renderQueue();
  renderQuestions();
  renderHandoffs();
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
    if (ui.state.applicationRun?.status === 'running' && !ui.applicationPollTimer) {
      ui.applicationPollTimer = setInterval(() => loadQueue({ quiet: true }), 2000);
    } else if (ui.state.applicationRun?.status !== 'running' && ui.applicationPollTimer) {
      clearInterval(ui.applicationPollTimer);
      ui.applicationPollTimer = null;
    }
  } catch (error) {
    setConnection(false);
    elements.queueList.setAttribute('aria-busy', 'false');
    elements.queueList.innerHTML = '<div class="empty-state"><h3>Could not load the queue.</h3><p>Make sure the local queue server is running, then try again.</p></div>';
    if (!quiet) showToast(error instanceof Error ? error.message : String(error), true);
  }
}

async function clearTodayQueue() {
  elements.clearQueueButton.disabled = true;
  try {
    await requestJson('/api/applications/packets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 6 }),
    });
    await loadQueue({ quiet: true });
    showToast('Packet preparation started. I’ll stop on unknown questions and human-only fields.');
  } catch (error) {
    elements.clearQueueButton.disabled = false;
    showToast(error instanceof Error ? error.message : String(error), true);
  }
}

async function openHandoffs() {
  elements.openHandoffsButton.disabled = true;
  try {
    await requestJson('/api/handoffs/open', { method: 'POST' });
    await loadQueue({ quiet: true });
    showToast('Handoff tabs are opening in one dedicated Chrome window.');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true);
  } finally {
    elements.openHandoffsButton.disabled = false;
  }
}

async function preparePacket(id) {
  const row = document.querySelector(`[data-item-id="${CSS.escape(id)}"]`);
  row?.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const payload = await requestJson('/api/applications/packet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queueId: id }),
    });
    const markdown = String(payload.packet?.markdown || '');
    if (markdown && navigator.clipboard?.writeText) await navigator.clipboard.writeText(markdown).catch(() => {});
    ui.state = payload.state;
    setConnection(true);
    render();
    showToast(markdown ? 'Packet prepared and copied. Final submission stays human-only.' : 'Packet prepared.');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true);
    row?.querySelectorAll('button').forEach((button) => { button.disabled = false; });
  }
}

async function submitQuestion(card, questionId) {
  const answerField = card.querySelector(`[data-question-answer="${CSS.escape(questionId)}"]`);
  const scopeField = card.querySelector(`[data-question-scope="${CSS.escape(questionId)}"]`);
  const choiceField = card.querySelector(`[data-question-choice="${CSS.escape(questionId)}"]`);
  const answer = String(choiceField?.value || answerField?.value || '').trim();
  const queueIds = String(card.dataset.queueIds || card.dataset.queueId || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!answer) {
    showToast('Add an answer before saving it to the ledger.', true);
    return;
  }
  const button = card.querySelector(`[data-question-submit="${CSS.escape(questionId)}"]`);
  if (button) button.disabled = true;
  try {
    const payload = await requestJson('/api/questions/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: questionId, queueIds, answer, scope: scopeField?.value || 'question' }),
    });
    await loadQueue({ quiet: true });
    showToast('Answer saved and will be reused in matching packets.');
  } catch (error) {
    if (button) button.disabled = false;
    showToast(error instanceof Error ? error.message : String(error), true);
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
    if (action === 'applied' || action === 'confirmed-submitted') {
      try {
        const outreach = await requestJson('/api/outreach/process', { method: 'POST' });
        ui.state.outreach = outreach.outreach || ui.state.outreach || [];
        ui.state.outreachRun = outreach.summary || ui.state.outreachRun || null;
        render();
        outreachMessage = ` ${outreachRunLabel(outreach.summary)}.`;
      } catch {
        outreachMessage = ' Outreach status will refresh on the next scheduled run.';
      }
    }
    const messages = {
      applied: 'Marked applied; outreach still requires submission confirmation.',
      'confirmed-submitted': 'Submission confirmed and recorded in the tracker.',
      skipped: 'Skipped for now.',
      snoozed: `Snoozed until ${extra.snoozeUntil}.`,
    };
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
elements.clearQueueButton.addEventListener('click', clearTodayQueue);
elements.openHandoffsButton.addEventListener('click', openHandoffs);
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
    else if (action === 'packet') preparePacket(id);
    else mutateItem(id, action);
    return;
  }
  const emptyRefresh = event.target instanceof Element ? event.target.closest('[data-empty-refresh]') : null;
  if (emptyRefresh) refreshQueue();
});
elements.questionList.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-question-submit]') : null;
  if (!target) return;
  const card = target.closest('[data-question-id]');
  const questionId = target.dataset.questionSubmit;
  if (card && questionId) submitQuestion(card, questionId);
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
