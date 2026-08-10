const elements = {
  allCount: document.querySelector('#allCount'),
  connectionStatus: document.querySelector('#connectionStatus'),
  clearQueueButton: document.querySelector('#clearQueueButton'),
  civicView: document.querySelector('#civicView'),
  civicCurrentCount: document.querySelector('#civicCurrentCount'),
  civicCurrentList: document.querySelector('#civicCurrentList'),
  civicCurrentSubheading: document.querySelector('#civicCurrentSubheading'),
  civicDismissedList: document.querySelector('#civicDismissedList'),
  civicDismissedSubheading: document.querySelector('#civicDismissedSubheading'),
  civicMissionCount: document.querySelector('#civicMissionCount'),
  civicMissionList: document.querySelector('#civicMissionList'),
  civicMissionSubheading: document.querySelector('#civicMissionSubheading'),
  civicOutreachCount: document.querySelector('#civicOutreachCount'),
  civicOutreachList: document.querySelector('#civicOutreachList'),
  civicOutreachSubheading: document.querySelector('#civicOutreachSubheading'),
  civicStaleCount: document.querySelector('#civicStaleCount'),
  civicStaleList: document.querySelector('#civicStaleList'),
  civicStaleSubheading: document.querySelector('#civicStaleSubheading'),
  civicTabCount: document.querySelector('#civicTabCount'),
  fieldSelect: document.querySelector('#fieldSelect'),
  filteredArchived: document.querySelector('#filteredArchived'),
  filteredCount: document.querySelector('#filteredCount'),
  filteredExcluded: document.querySelector('#filteredExcluded'),
  filteredSkipped: document.querySelector('#filteredSkipped'),
  filteredStale: document.querySelector('#filteredStale'),
  lastRefresh: document.querySelector('#lastRefresh'),
  laneSelect: document.querySelector('#laneSelect'),
  locationSelect: document.querySelector('#locationSelect'),
  handoffsTabCount: document.querySelector('#handoffsTabCount'),
  queueList: document.querySelector('#queueList'),
  queueSubheading: document.querySelector('#queueSubheading'),
  queueTabCount: document.querySelector('#queueTabCount'),
  outreachList: document.querySelector('#outreachList'),
  outreachSubheading: document.querySelector('#outreachSubheading'),
  outreachTabCount: document.querySelector('#outreachTabCount'),
  questionsTabCount: document.querySelector('#questionsTabCount'),
  regionalBuffaloCount: document.querySelector('#regionalBuffaloCount'),
  regionalBuffaloList: document.querySelector('#regionalBuffaloList'),
  regionalBuffaloSubheading: document.querySelector('#regionalBuffaloSubheading'),
  regionalClevelandCount: document.querySelector('#regionalClevelandCount'),
  regionalClevelandList: document.querySelector('#regionalClevelandList'),
  regionalClevelandSubheading: document.querySelector('#regionalClevelandSubheading'),
  regionalRemoteCount: document.querySelector('#regionalRemoteCount'),
  regionalTabCount: document.querySelector('#regionalTabCount'),
  xOutboxList: document.querySelector('#xOutboxList'),
  xOutboxSummary: document.querySelector('#xOutboxSummary'),
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
  sourceHealth: document.querySelector('#sourceHealth'),
  snoozeDate: document.querySelector('#snoozeDate'),
  snoozeDialog: document.querySelector('#snoozeDialog'),
  snoozeForm: document.querySelector('#snoozeForm'),
  snoozeRoleName: document.querySelector('#snoozeRoleName'),
  sortSelect: document.querySelector('#sortSelect'),
  toast: document.querySelector('#toast'),
  wordmarkCurrent: document.querySelector('#wordmarkCurrent'),
};

const ui = {
  field: 'all',
  filter: 'all',
  lane: 'all',
  location: 'all',
  sort: 'priority',
  view: 'queue',
  state: null,
  snoozeItemId: null,
  toastTimer: null,
  applicationPollTimer: null,
  handoffPollTimer: null,
};

const VIEW_ORDER = ['queue', 'regional', 'questions', 'handoffs', 'outreach', 'civic'];
const VIEW_LABELS = {
  queue: 'daily queue',
  regional: 'regional discovery',
  questions: 'questions',
  handoffs: 'handoffs',
  outreach: 'outreach',
  civic: 'civic discovery',
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

function locationFitAdjustmentLabel(value) {
  const adjustment = Number(value);
  if (!Number.isFinite(adjustment) || adjustment === 0) return 'no score adjustment';
  return `${adjustment > 0 ? '+' : ''}${adjustment.toFixed(2)}`;
}

function locationFitMarkup(item) {
  const fit = item.locationFit;
  if (!fit?.label) return '';
  return `<span class="tag tag-location" title="Location contribution to fit score">${escapeHtml(fit.label)} · ${escapeHtml(locationFitAdjustmentLabel(fit.scoreAdjustment))}</span>`;
}

function regionalIdForItem(item) {
  const explicit = String(item.locationFit?.id || '').trim();
  if (explicit === 'buffalo_western_new_york' || explicit === 'cleveland_northeast_ohio' || explicit === 'national_remote_us') return explicit;
  const location = locationLabel(item).toLowerCase();
  if (/\b(buffalo|erie county|western new york|wny)\b/.test(location)) return 'buffalo_western_new_york';
  if (/\b(cleveland|cuyahoga county|northeast ohio|lakewood,? oh|beachwood,? oh|mayfield,? oh)\b/.test(location)) return 'cleveland_northeast_ohio';
  if (/\b(remote|distributed|work[ -]from[ -](?:home|anywhere))\b/.test(location)) return 'national_remote_us';
  return 'other_us';
}

function currentQueueItems() {
  return Array.isArray(ui.state?.items) ? ui.state.items : selectedItems();
}

function currentRegionalItems() {
  return currentQueueItems().filter((item) => ['ready', 'in_review'].includes(String(item.status || ''))
    && !['stale', 'archivable'].includes(String(item.freshness || '')));
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

function civicEvidenceMarkup(record) {
  const evidence = Array.isArray(record?.sourceEvidence) ? record.sourceEvidence : [];
  if (!evidence.length) return '';
  const sources = evidence.map((entry) => {
    const source = entry && typeof entry === 'object' ? entry : null;
    const label = typeof entry === 'string'
      ? entry
      : source?.title || source?.method || source?.url || 'Recorded source';
    const href = safeHref(source?.url);
    const sourceLabel = href !== '#'
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
      : escapeHtml(label);
    const metadata = source
      ? [source.method && humanize(source.method), source.observedAt && `checked ${formatDate(source.observedAt)}`].filter(Boolean).join(' · ')
      : '';
    return `<li>${sourceLabel}${metadata ? ` <span>${escapeHtml(metadata)}</span>` : ''}</li>`;
  }).join('');
  return `<details class="civic-evidence"><summary>Source evidence (${evidence.length})</summary><ul>${sources}</ul></details>`;
}

function civicRecordMarkup(record, lane) {
  const dismissed = Boolean(record?.dismissedAt);
  const hasTitle = Boolean(record?.title);
  const title = record?.title || record?.organization || 'Civic opportunity';
  const organization = hasTitle
    ? record?.organization || 'Organization not listed'
    : humanize(record?.kind || record?.status || 'outreach target');
  const laneLabel = lane === 'current-role'
    ? 'Current role'
    : lane === 'stale-lead'
      ? 'Stale lead'
      : 'Outreach target';
  const statusLabel = dismissed
    ? 'Dismissed'
    : lane === 'current-role'
      ? 'Live verified'
      : lane === 'stale-lead'
        ? 'Needs refresh'
        : humanize(record?.kind || record?.status || 'Human-reviewed lead');
  const statusClass = dismissed
    ? 'tag-status-review'
    : lane === 'current-role' ? 'tag-status-ready' : lane === 'stale-lead' ? 'tag-status-review' : '';
  const missionTag = record?.orientation === 'mission-first'
    ? '<span class="tag tag-civic-mission">Mission-first fit</span>'
    : '';
  const layerTag = record?.layer
    ? `<span class="tag tag-civic-layer">${escapeHtml(humanize(record.layer))}</span>`
    : '';
  const fitBasis = Array.isArray(record?.fitBasis) ? record.fitBasis.filter(Boolean).slice(0, 4) : [];
  const modes = Array.isArray(record?.contributionModes) ? record.contributionModes.filter(Boolean).slice(0, 3) : [];
  const meta = [
    record?.location,
    record?.employmentType && humanize(record.employmentType),
    record?.compensation,
    record?.closingDate && `Closes ${formatDate(record.closingDate)}`,
    record?.expectedThrough && `Through ${formatDate(record.expectedThrough)}`,
    record?.observedAt && `Checked ${formatDate(record.observedAt)}`,
    record?.dismissedAt && `Dismissed ${formatDateTime(record.dismissedAt)}`,
  ].filter(Boolean);
  const href = safeHref(record?.url);
  const actionLink = href !== '#'
    ? `<a class="button button-quiet" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${lane === 'current-role' ? 'Open official role' : 'Review source'}</a>`
    : '';
  const civicAction = record?.civicKey
    ? dismissed
      ? `<button class="button button-quiet" type="button" data-civic-action="restore" data-civic-key="${escapeHtml(record.civicKey)}">Restore</button>`
      : `<button class="button button-quiet" type="button" data-civic-action="dismiss" data-civic-key="${escapeHtml(record.civicKey)}" title="Hide this Civic lead from the active view; source evidence is retained">Dismiss</button>`
    : '';
  const nextAction = record?.nextAction || record?.reason || 'Review the source and decide on the next human action.';
  const evidence = civicEvidenceMarkup(record);
  return `<article class="civic-row">
    <div class="civic-row-main">
      <div class="civic-row-heading">
        <div>
          <p class="civic-row-label">${escapeHtml(laneLabel)}</p>
          <h3>${escapeHtml(title)}</h3>
          <p class="civic-organization">${escapeHtml(organization)}</p>
        </div>
        <div class="civic-row-tags">
          <span class="tag ${statusClass}">${escapeHtml(statusLabel)}</span>
          ${missionTag}
          ${layerTag}
          ${fitBasis.map((basis) => `<span class="tag">${escapeHtml(humanize(basis))}</span>`).join('')}
          ${modes.map((mode) => `<span class="tag">${escapeHtml(humanize(mode))}</span>`).join('')}
        </div>
      </div>
      ${meta.length ? `<div class="civic-meta">${meta.map((value) => `<span>${escapeHtml(value)}</span>`).join('')}</div>` : ''}
      ${record?.interestFit ? `<p class="civic-fit"><strong>Interest fit:</strong> ${escapeHtml(record.interestFit)}</p>` : ''}
      ${record?.technicalBridge ? `<p class="civic-bridge"><strong>Secondary bridge:</strong> ${escapeHtml(record.technicalBridge)}</p>` : ''}
      <p class="civic-next"><strong>Next:</strong> ${escapeHtml(nextAction)}</p>
      <div class="civic-row-actions">${actionLink}${civicAction}${evidence}</div>
    </div>
  </article>`;
}

function renderCivicList(element, records, emptyHeading, emptyDetail) {
  if (!element) return;
  element.setAttribute('aria-busy', 'false');
  element.innerHTML = records.length
    ? records.map((record) => civicRecordMarkup(record, record.lane)).join('')
    : `<div class="empty-state civic-empty"><h3>${escapeHtml(emptyHeading)}</h3><p>${escapeHtml(emptyDetail)}</p></div>`;
}

function renderCivic() {
  const civic = ui.state?.civic || {};
  const ready = civic.status === 'ready';
  const counts = civic.counts || {};
  const currentRoles = ready && Array.isArray(civic.currentRoles) ? civic.currentRoles : [];
  const outreachTargets = ready && Array.isArray(civic.outreachTargets) ? civic.outreachTargets : [];
  const missionFirstTargets = ready && Array.isArray(civic.missionFirstTargets)
    ? civic.missionFirstTargets
    : outreachTargets.filter((record) => record?.orientation === 'mission-first');
  const otherOutreachTargets = ready && Array.isArray(civic.otherOutreachTargets)
    ? civic.otherOutreachTargets
    : outreachTargets.filter((record) => record?.orientation !== 'mission-first');
  const staleLeads = ready && Array.isArray(civic.staleLeads) ? civic.staleLeads : [];
  const dismissed = ready && Array.isArray(civic.dismissed) ? civic.dismissed : [];
  const loaded = civic.generatedAt ? ` Loaded ${formatDateTime(civic.generatedAt)}.` : '';

  elements.civicTabCount.textContent = ready ? String(counts.total ?? currentRoles.length + outreachTargets.length + staleLeads.length) : '—';
  elements.civicCurrentCount.textContent = ready ? String(counts.currentRoles ?? currentRoles.length) : '—';
  elements.civicOutreachCount.textContent = ready ? String(counts.outreachTargets ?? outreachTargets.length) : '—';
  elements.civicStaleCount.textContent = ready ? String(counts.staleLeads ?? staleLeads.length) : '—';

  if (!ready) {
    const error = civic.error ? ` ${civic.error}` : '';
    const unavailable = `Civic discovery is unavailable.${error}`;
    elements.civicCurrentSubheading.textContent = unavailable;
    elements.civicMissionSubheading.textContent = unavailable;
    elements.civicOutreachSubheading.textContent = unavailable;
    elements.civicStaleSubheading.textContent = unavailable;
    elements.civicDismissedSubheading.textContent = unavailable;
    renderCivicList(elements.civicCurrentList, [], 'Civic discovery is unavailable.', 'Repair the local discovery data, then refresh this page.');
    renderCivicList(elements.civicMissionList, [], 'Civic discovery is unavailable.', 'Repair the local discovery data, then refresh this page.');
    renderCivicList(elements.civicOutreachList, [], 'Civic discovery is unavailable.', 'Repair the local discovery data, then refresh this page.');
    renderCivicList(elements.civicStaleList, [], 'Civic discovery is unavailable.', 'Repair the local discovery data, then refresh this page.');
    renderCivicList(elements.civicDismissedList, [], 'Civic discovery is unavailable.', 'Repair the local discovery data, then refresh this page.');
    return;
  }

  elements.civicCurrentSubheading.textContent = `${currentRoles.length} live role${currentRoles.length === 1 ? '' : 's'} with recorded source evidence.${loaded}`;
  elements.civicMissionCount.textContent = String(counts.missionFirstTargets ?? missionFirstTargets.length);
  elements.civicMissionSubheading.textContent = `${missionFirstTargets.length} Cleveland organization${missionFirstTargets.length === 1 ? '' : 's'} selected for issue and mission fit; no job opening is required.${loaded}`;
  elements.civicOutreachSubheading.textContent = `${otherOutreachTargets.length} other organization${otherOutreachTargets.length === 1 ? '' : 's'} or initiative${otherOutreachTargets.length === 1 ? '' : 's'} to research and approach.${loaded}`;
  elements.civicStaleSubheading.textContent = `${staleLeads.length} lead${staleLeads.length === 1 ? '' : 's'} need a source refresh before you act.${loaded}`;
  elements.civicDismissedSubheading.textContent = `${dismissed.length} dismissed Civic lead${dismissed.length === 1 ? '' : 's'} retained for history. Restore one to return it to the active board.${loaded}`;
  renderCivicList(elements.civicCurrentList, currentRoles, 'No live civic roles recorded.', 'Refresh the discovery report when you want another source-backed pass.');
  renderCivicList(elements.civicMissionList, missionFirstTargets, 'No mission-first Cleveland targets recorded.', 'Add an organization when its public mission fits your interests, even without an open role.');
  renderCivicList(elements.civicOutreachList, otherOutreachTargets, 'No other civic outreach targets recorded.', 'Add a target to the additive discovery source when you find a promising place to contribute.');
  renderCivicList(elements.civicStaleList, staleLeads, 'No stale civic leads recorded.', 'Current discovery leads do not need a source refresh right now.');
  renderCivicList(elements.civicDismissedList, dismissed, 'No dismissed civic leads.', 'Dismissed items will stay here only after you clear one from the active Civic board.');
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
  elements.filteredCount.textContent = String(totals.filtered ?? 0);
  elements.filteredExcluded.textContent = String(totals.excluded ?? 0);
  elements.filteredSkipped.textContent = String(totals.skipped ?? 0);
  elements.filteredStale.textContent = String(totals.stale ?? 0);
  elements.filteredArchived.textContent = String(totals.archived ?? 0);
  const handshake = ui.state?.lastRun?.sources?.handshake;
  if (!handshake) {
    elements.sourceHealth.textContent = 'Handshake: not checked yet. Refresh from an authenticated Chrome session to add browser-backed leads.';
    return;
  }
  const status = String(handshake.status || 'unknown').replaceAll('-', ' ');
  const candidates = Number(handshake.candidates || 0);
  const errors = Number(handshake.errors || 0);
  const suffix = errors ? ` · ${errors} warning${errors === 1 ? '' : 's'}` : '';
  const inbox = handshake.inbox;
  const inboxSuffix = inbox
    ? ` · inbox ${Number(inbox.unread || 0)} unread / ${Number(inbox.threads || 0)} cached thread${Number(inbox.threads || 0) === 1 ? '' : 's'}`
    : '';
  elements.sourceHealth.textContent = `Handshake: ${status} · ${candidates} cached lead${candidates === 1 ? '' : 's'}${inboxSuffix}${suffix}`;
}

function renderApplicationRun() {
  const run = ui.state?.applicationRun || {};
  const running = run.status === 'running';
  elements.clearQueueButton.disabled = running;
  elements.clearQueueButton.textContent = running ? 'Preparing…' : 'Fill today’s applications';
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
    const kind = String(question.kind || '').toLowerCase();
    const choiceQuestion = /^(?:radio|checkbox|select|combobox)$/.test(kind);
    const choiceOptionsMissing = choiceQuestion && !options.length;
    const answerControl = question.multiple && options.length
      ? `<fieldset class="question-checkbox-group" data-question-multi="${escapeHtml(question.id)}"><legend class="sr-only">Select all answers that apply</legend><div class="question-checkbox-options">${options.map((option) => `<label class="question-checkbox-option"><input type="checkbox" data-question-multi-choice="${escapeHtml(question.id)}" value="${escapeHtml(option)}"><span>${escapeHtml(option)}</span></label>`).join('')}</div></fieldset>`
      : options.length
        ? `<select data-question-choice="${escapeHtml(question.id)}" aria-label="Answer: ${escapeHtml(question.question)}"><option value="">Choose an answer</option>${options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join('')}</select>`
        : choiceQuestion
          ? `<select class="question-choice-unavailable" data-question-choice="${escapeHtml(question.id)}" aria-label="Answer: ${escapeHtml(question.question)}" disabled><option value="">Choices unavailable — refresh form</option></select>`
          : `<textarea data-question-answer="${escapeHtml(question.id)}" rows="2" aria-label="Answer: ${escapeHtml(question.question)}" placeholder="Type your answer"></textarea>`;
    const answerField = question.multiple && options.length
      ? answerControl
      : `<label class="question-field"><span class="sr-only">Your answer</span>${answerControl}</label>`;
    const context = question.context ? `<p class="question-context">${escapeHtml(question.context)}</p>` : '';
    const followUp = question.followUp
      ? `<div class="question-follow-up" data-question-follow-up="${escapeHtml(question.followUp.id)}" data-trigger="${escapeHtml(question.followUp.trigger || 'Yes')}" data-queue-ids="${escapeHtml((question.followUp.queueIds || [question.followUp.queueId]).join(','))}" ${question.followUp.trigger ? 'hidden' : ''}>
          <label class="question-field"><span>${escapeHtml(question.followUp.question)}</span><textarea data-question-follow-up-answer="${escapeHtml(question.followUp.id)}" rows="2" placeholder="Type your answer"></textarea></label>
        </div>`
      : '';
    return `<article class="question-card" data-question-id="${escapeHtml(question.id)}" data-queue-id="${escapeHtml(question.queueId)}" data-queue-ids="${escapeHtml((question.queueIds || [question.queueId]).join(','))}">
      <p class="question-text">${escapeHtml(question.question)}</p>
      ${context}
      <div class="question-answer-row">
      ${answerField}
        <button class="button button-primary" type="button" data-question-submit="${escapeHtml(question.id)}"${choiceOptionsMissing ? ' disabled title="Choice options were not captured from the application form"' : ''}>Save</button>
      </div>
      ${followUp}
    </article>`;
  }).join('');
}

function renderHandoffs() {
  const session = ui.state?.handoffs || {};
  const pages = Array.isArray(session.pages) ? session.pages : [];
  if (!pages.length) {
    const status = String(session.status || 'idle');
    const heading = status === 'starting'
      ? 'Opening the Chrome handoff window…'
      : status === 'running'
        ? 'Opening and filling application tabs…'
        : status === 'failed'
          ? 'Browser handoff could not start.'
          : 'No browser handoffs are waiting.';
    const detail = status === 'failed'
      ? (session.error || 'The handoff producer stopped before it opened a tab. Try Open handoffs again after reviewing the error.')
      : status === 'starting' || status === 'running'
        ? 'A separate Chrome window is being opened. Known profile, confirmed-answer, résumé, and cover-letter fields are filled automatically; unresolved questions and submission stay with you. This section updates as tabs become ready.'
        : status === 'completed'
          ? 'The last handoff completed without leaving a tab waiting for review.'
          : 'CAPTCHA and manual-submit applications will be grouped into one Chrome window here.';
    elements.handoffList.innerHTML = `<div class="empty-state"><h3>${escapeHtml(heading)}</h3><p>${escapeHtml(detail)}</p></div>`;
    return;
  }
  const error = session.error
    ? `<p class="outreach-due">Some handoff items need attention: ${escapeHtml(session.error)}</p>`
    : '';
  const guidance = '<p class="outreach-due">Open in the separate Chrome window. Known answers and artifacts are filled; unresolved questions and final submission remain for your review.</p>';
  elements.handoffList.innerHTML = `${error}${guidance}${pages.map((page) => `<article class="handoff-card"><div><h3>${escapeHtml(page.title || 'Application')}</h3><p>${escapeHtml(page.company || '')}</p></div><span class="tag ${page.status === 'submitted' ? 'tag-status-ready' : ''}">${escapeHtml(humanize(page.status || 'waiting'))}</span></article>`).join('')}`;
}

function contactDiscoveryMarkup(item) {
  const discovery = item.outreach?.discovery;
  if (!discovery) {
    return '<details class="queue-details"><summary>Email discovery</summary><p>Queued for the next queue refresh.</p></details>';
  }
  const contacts = Array.isArray(discovery.contacts) ? discovery.contacts : [];
  const hypotheses = Array.isArray(discovery.emailHypotheses) ? discovery.emailHypotheses : [];
  const errors = Array.isArray(discovery.errors) ? discovery.errors.filter(Boolean) : [];
  const warnings = Array.isArray(discovery.warnings) ? discovery.warnings.filter(Boolean) : [];
  const technicalSignals = [...new Set([...errors, ...warnings])];
  const signalText = technicalSignals.join(' ');
  const providerUnavailable = discovery.status === 'unavailable'
    || (discovery.status === 'error' && /Firecrawl .*failed:\s*(?:401|402|403|429|5\d\d)|credentials are unavailable/i.test(signalText));
  const gmailUnavailable = /Gmail relationship search (?:is )?unavailable/i.test(signalText);
  const statusLabel = providerUnavailable
    ? 'Sources unavailable'
    : discovery.status === 'no_contacts'
      ? 'No verified contact yet'
      : discovery.status === 'found'
        ? 'Contact found'
        : discovery.status === 'error'
          ? 'Needs attention'
          : humanize(discovery.status || 'pending');
  const explanation = providerUnavailable
    ? `${/402/.test(signalText) ? 'Public search is paused because Firecrawl credits are exhausted.' : /429/.test(signalText) ? 'Public search is temporarily rate limited.' : 'Automated public search is currently unavailable.'}${gmailUnavailable ? ' Gmail relationship search is also unavailable.' : ''} This does not block applying to the role.`
    : discovery.status === 'no_contacts'
      ? 'The available sources were checked, but no verified public or first-party email was found. This does not block applying.'
      : discovery.reason || 'Discovery completed without a summary.';
  const contactRows = contacts.length
    ? contacts.map((contact) => `<li><strong>${escapeHtml(contact.name || 'Contact')}</strong> — ${escapeHtml(contact.title || 'Role signal')}${contact.email ? ` · <code>${escapeHtml(contact.email)}</code>${contact.emailVerified ? ' <span class="tag tag-status-ready">verified</span>' : ''}` : ' · no exact email observed'}</li>`).join('')
    : providerUnavailable
      ? '<li>No contact result is available because the automated sources could not complete.</li>'
      : '<li>No verified public or first-party contact email was observed.</li>';
  const hypothesisRows = hypotheses.length
    ? `<p><strong>Review-only hypotheses</strong> — not eligible for sending:</p><ul>${hypotheses.map((hypothesis) => `<li>${escapeHtml(hypothesis.name || 'Named candidate')} · <code>${escapeHtml(hypothesis.email || 'unknown')}</code> · ${escapeHtml(hypothesis.convention || 'inferred convention')}</li>`).join('')}</ul>`
    : '';
  const queries = Array.isArray(discovery.queries) ? discovery.queries.filter(Boolean).slice(0, 3) : [];
  const manualSearchRows = !contacts.length && queries.length
    ? `<p><strong>Manual fallback</strong></p><ul>${queries.map((query, index) => `<li><a href="https://www.google.com/search?q=${encodeURIComponent(query)}" target="_blank" rel="noopener noreferrer">Open contact search ${index + 1}</a></li>`).join('')}</ul>`
    : '';
  const technicalRows = technicalSignals.length
    ? `<details class="discovery-technical"><summary>Technical details</summary><ul>${technicalSignals.map((signal) => `<li>${escapeHtml(signal)}</li>`).join('')}</ul></details>`
    : '';
  return `<details class="queue-details"><summary>Contact discovery · ${escapeHtml(statusLabel)}</summary><p>${escapeHtml(explanation)}</p><ul>${contactRows}</ul>${hypothesisRows}${manualSearchRows}${technicalRows}</details>`;
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
          ${locationFitMarkup(item)}
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
  const drafted = Number(run.drafted || 0);
  const sent = Number(run.sent || 0);
  const retrying = Number(run.retrying || 0);
  const failed = Number(run.failed || 0);
  const held = Number(run.rateLimited || 0);
  const parts = [`${drafted} Gmail draft${drafted === 1 ? '' : 's'} created`];
  if (sent) parts.push(`${sent} legacy message${sent === 1 ? '' : 's'} accepted by Gmail`);
  if (retrying) parts.push(`${retrying} retrying after an uncertain provider result`);
  if (failed) parts.push(`${failed} failed and blocked`);
  if (held) parts.push(`${held} held by the daily limit`);
  return `${run.ok === false ? 'Needs attention: ' : ''}Last run ${parts.join(' · ')}. Review and send drafts in Gmail.`;
}

function xOutboxDrafts() {
  return Array.isArray(ui.state?.xOutreachOutbox?.drafts) ? ui.state.xOutreachOutbox.drafts : [];
}

function xDraftStatusLabel(draft) {
  if (draft.status === 'blocked') return 'Blocked';
  if (draft.status === 'archived') return 'Archived';
  return 'Ready for review';
}

function xNativeStatusLabel(status) {
  if (status === 'verified_saved') return 'Verified X draft';
  if (status === 'unverified') return 'X draft unverified';
  return 'Not saved on X';
}

function renderXOutbox() {
  const outbox = ui.state?.xOutreachOutbox || {};
  const drafts = xOutboxDrafts();
  elements.xOutboxList.setAttribute('aria-busy', 'false');

  if (outbox.status !== 'ready') {
    elements.xOutboxSummary.textContent = 'Durable X messages are not available for review.';
    elements.xOutboxList.innerHTML = `<div class="x-outbox-empty"><strong>Local outbox needs attention.</strong><p>${escapeHtml(outbox.error || 'Run node x-outreach-outbox.mjs verify, then refresh this page.')}</p></div>`;
    return;
  }

  elements.xOutboxSummary.textContent = drafts.length
    ? `${drafts.length} durable local cop${drafts.length === 1 ? 'y' : 'ies'}${Number(outbox.archivedCount || 0) ? ` · ${outbox.archivedCount} sent and archived` : ''}. Opening X does not change saved or sent status.`
    : Number(outbox.archivedCount || 0)
      ? `${outbox.archivedCount} sent message${outbox.archivedCount === 1 ? '' : 's'} archived. New messages will appear here for review.`
      : 'Messages prepared after confirmed applications will be saved here before X is opened.';
  if (!drafts.length) {
    elements.xOutboxList.innerHTML = Number(outbox.archivedCount || 0)
      ? '<p class="x-outbox-empty">Sent messages are archived locally. New prepared outreach will appear here for review.</p>'
      : '<p class="x-outbox-empty">Prepared outreach will appear here for review and manual delivery.</p>';
    return;
  }

  elements.xOutboxList.innerHTML = drafts.map((draft) => {
    const pendingRevision = draft.pendingRevision
      ? `<details class="outreach-draft x-draft-revision"><summary>Generated revision waiting for review</summary><p>${escapeHtml(draft.pendingRevision.body)}</p></details>`
      : '';
    const deliveryLabel = draft.deliveryStatus === 'sent_by_user' ? 'User confirmed sent' : 'Not sent';
    return `<article class="x-draft-row" data-x-draft-id="${escapeHtml(draft.id)}">
      <div class="x-draft-heading">
        <div>
          <h4>${escapeHtml(draft.contact?.name || 'Unnamed contact')}</h4>
          <p>${escapeHtml(draft.company || 'Company')} · ${escapeHtml(draft.role || 'Role')}</p>
        </div>
        <a class="x-draft-handle" href="${escapeHtml(safeHref(draft.contact?.profileUrl))}" target="_blank" rel="noopener noreferrer">${escapeHtml(draft.contact?.handle || 'X profile')}</a>
      </div>
      <div class="x-draft-statuses" aria-label="Message status">
        <span class="tag tag-status-ready">Saved locally</span>
        ${draft.qualityPassed ? '<span class="tag tag-status-ready">Humanizer + quality passed</span>' : ''}
        <span class="tag ${draft.status === 'ready_for_review' ? 'tag-status-review' : ''}">${escapeHtml(xDraftStatusLabel(draft))}</span>
        <span class="tag">${escapeHtml(xNativeStatusLabel(draft.nativeDraftStatus))}</span>
        <span class="tag">${escapeHtml(deliveryLabel)}</span>
      </div>
      <p class="x-draft-body">${escapeHtml(draft.body)}</p>
      ${pendingRevision}
      <div class="x-draft-actions">
        <button class="button button-primary" type="button" data-x-copy="${escapeHtml(draft.id)}">Copy message</button>
        <button class="button button-quiet" type="button" data-x-mark-sent="${escapeHtml(draft.id)}">Mark sent &amp; dismiss</button>
        <a class="button button-quiet" href="${escapeHtml(safeHref(draft.contact?.profileUrl))}" target="_blank" rel="noopener noreferrer">Open X profile</a>
      </div>
    </article>`;
  }).join('');
}

function renderOutreach() {
  const records = (Array.isArray(ui.state?.outreach) ? ui.state.outreach : [])
    .filter((record) => record?.submissionConfirmed === true);
  const durableDrafts = xOutboxDrafts();
  const run = ui.state?.outreachRun || null;
  elements.outreachSubheading.textContent = records.length
    ? `${records.length} application${records.length === 1 ? '' : 's'} in the outreach workflow. Email drafts are stored in Gmail; LinkedIn drafts stay here. ${outreachRunLabel(run)}`
    : `Email drafts are stored in Gmail; LinkedIn drafts stay here. ${outreachRunLabel(run)}`;
  if (!records.length) {
    elements.outreachList.innerHTML = '<div class="outreach-empty">No application records are waiting for outreach.</div>';
    return;
  }
  elements.outreachList.innerHTML = records.map((record) => {
    const contacts = Array.isArray(record.contacts) ? record.contacts : [];
        const contactsMarkup = contacts.length
      ? contacts.map((contact) => {
        const hasDurableXCopy = durableDrafts.some((draft) =>
          String(draft.company || '').toLowerCase() === String(record.company || '').toLowerCase()
          && String(draft.contact?.handle || '').toLowerCase() === String(contact.xHandle || '').toLowerCase());
        const delivery = contact.emailVerificationState === 'blocked-provider-address'
          ? 'LinkedIn provider address blocked'
          : contact.initialStatus === 'blocked_content_review'
            ? 'Draft blocked for content review'
          : contact.initialDeliveryStatus === 'gmail_draft_created' || contact.initialEmailNotification?.status === 'gmail_draft_created'
            ? 'Draft in Gmail'
            : contact.initialDeliveryStatus === 'provider_accepted'
              ? 'Legacy message accepted by Gmail'
              : contact.initialOutboxStatus === 'unknown'
                ? 'Draft creation uncertain; retry scheduled'
                : contact.initialOutboxStatus === 'failed'
                  ? 'Draft creation failed; blocked'
                  : humanize(contact.initialStatus || 'pending');
        const emailNotification = contact.initialEmailNotification
          ? contact.initialEmailNotification.status === 'gmail_draft_created'
            ? `<p class="outreach-due">Gmail draft created for ${escapeHtml(contact.initialEmailNotification.recipient)}${contact.initialEmailNotification.subject ? ` — ${escapeHtml(contact.initialEmailNotification.subject)}` : ''}. Review and send it in Gmail.</p>`
            : `<p class="outreach-due">Email is routed to Gmail for ${escapeHtml(contact.initialEmailNotification.recipient)}; the draft body is not shown here.</p>`
          : '';
        const channelLabel = contact.primaryOutreachChannel === 'email'
          ? contact.emailVerified ? 'Priority 1 · Verified email' : 'Review-only email hypothesis'
          : contact.primaryOutreachChannel === 'x'
            ? 'Priority 2 · X/Twitter manual'
            : contact.primaryOutreachChannel === 'linkedin'
              ? 'Lowest priority · LinkedIn fallback'
              : 'Manual outreach';
        return `
          <div class="outreach-contact">
            <div>
              <strong>${escapeHtml(contact.name || 'Unnamed contact')}</strong>
              <span>${escapeHtml(contact.title || humanize(contact.type))}</span>
            </div>
            <div class="outreach-contact-meta">
              <span class="tag">${escapeHtml(delivery)}</span>
              <span class="tag ${contact.emailVerified ? 'tag-status-ready' : ''}">${escapeHtml(channelLabel)}</span>
              ${contact.followUpDueAt ? `<span class="outreach-due">Follow-up ${escapeHtml(formatDate(contact.followUpDueAt))}</span>` : ''}
            </div>
            ${(contact.initialLastError || contact.followUpLastError) ? `<p class="outreach-due">${escapeHtml(contact.initialLastError || contact.followUpLastError)}</p>` : ''}
            ${emailNotification}
            ${contact.linkedinDraft ? `<details class="outreach-draft"><summary>LinkedIn draft · Humanizer + quality passed</summary><p>${escapeHtml(contact.linkedinDraft)}</p></details>` : ''}
            ${contact.linkedinDraftError ? `<p class="outreach-due">LinkedIn draft blocked: ${escapeHtml(contact.linkedinDraftError)}</p>` : ''}
            ${contact.xProfileUrl ? `<p><a href="${escapeHtml(contact.xProfileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(contact.xHandle || 'X/Twitter profile')}</a></p>` : ''}
            ${hasDurableXCopy ? '<p class="outreach-due">X message passed Humanizer + quality and is preserved in the local outbox above.</p>' : contact.xDraft ? `<details class="outreach-draft"><summary>X message · Humanizer + quality passed · not yet in local outbox</summary><p>${escapeHtml(contact.xDraft)}</p></details>` : ''}
            ${contact.xDraftError ? `<p class="outreach-due">X draft blocked: ${escapeHtml(contact.xDraftError)}</p>` : ''}
          </div>`;
      }).join('')
      : `<p class="outreach-empty">No eligible contacts yet. Search: ${escapeHtml(record.searchQuery || 'company hiring manager recruiter team')}</p>`;
    const submissionGatePending = !record.submissionConfirmed
      && String(record.status || '').toLowerCase() === 'awaiting_submission_confirmation';
    const submissionLabel = record.submissionConfirmed
      ? `Submission confirmed${record.submissionConfirmedSource ? ` via ${humanize(record.submissionConfirmedSource)}` : ''}; Gmail draft workflow is active.`
      : '';
    const statusMarkup = submissionGatePending
      ? ''
      : `<span class="tag ${record.submissionConfirmed ? 'tag-status-ready' : ''}">${escapeHtml(humanize(record.status || 'pending'))}</span>`;
    return `
      <article class="outreach-card">
        <div class="outreach-card-heading">
          <div>
            <h3>${escapeHtml(record.title || 'Job lead')}</h3>
            <p>${escapeHtml(record.company || 'Company not parsed')}</p>
          </div>
          ${statusMarkup}
        </div>
        ${submissionLabel ? `<p class="outreach-due">${escapeHtml(submissionLabel)}</p>` : ''}
        ${record.lastError ? `<p class="outreach-due">${escapeHtml(record.lastError)}</p>` : ''}
        <div class="outreach-contacts">${contactsMarkup}</div>
      </article>`;
  }).join('');
}

function regionalRoleMarkup(item, index) {
  const reasons = Array.isArray(item.fitReasons) ? [...item.fitReasons] : [];
  if (item.locationFit?.reason && !reasons.includes(item.locationFit.reason)) reasons.unshift(item.locationFit.reason);
  const company = item.company || 'Company not parsed';
  const location = locationLabel(item);
  const statusClass = item.status === 'ready' ? 'tag-status-ready' : 'tag-status-review';
  const reasonMarkup = reasons.length
    ? `<ul>${reasons.slice(0, 6).map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
    : '<p>No fit notes were recorded for this role.</p>';
  const href = safeHref(item.applyUrl || item.canonicalUrl);
  const action = href === '#'
    ? ''
    : `<a class="button button-primary" href="${escapeHtml(href)}" target="_blank" rel="noopener">Open role</a>`;
  return `<article class="queue-row regional-row">
    <div class="queue-index">${escapeHtml(String(index + 1).padStart(2, '0'))}</div>
    <div class="queue-content">
      <div class="queue-title-line">
        <div>
          <h3>${escapeHtml(item.title || 'Job lead')}</h3>
          <p class="queue-company">${escapeHtml(company)} <span>·</span> ${escapeHtml(location)} <span>·</span> Posted ${escapeHtml(formatDate(item.postedAt))}</p>
        </div>
        <span class="score-badge" title="Fit score">${escapeHtml(Number(item.fitScore || 0).toFixed(1))}/5</span>
      </div>
      <div class="queue-meta">
        <span class="tag ${statusClass}">${escapeHtml(statusLabel(item.status))}</span>
        <span class="tag">${escapeHtml(humanize(item.lane))}</span>
        ${locationFitMarkup(item)}
      </div>
      <details class="queue-details">
        <summary>Why this role</summary>
        ${reasonMarkup}
        <p>Evidence: ${escapeHtml(item.fitConfidence || 'limited')} confidence · ${escapeHtml(item.liveness || 'unknown')} link</p>
      </details>
    </div>
    <div class="queue-actions">${action}</div>
  </article>`;
}

function renderRegionalList(element, items, emptyHeading, emptyDetail) {
  if (!element) return;
  element.innerHTML = items.length
    ? items
      .sort((left, right) => Number(right.fitScore || 0) - Number(left.fitScore || 0)
        || String(left.company || '').localeCompare(String(right.company || '')))
      .map(regionalRoleMarkup)
      .join('')
    : `<div class="empty-state regional-empty"><h3>${escapeHtml(emptyHeading)}</h3><p>${escapeHtml(emptyDetail)}</p></div>`;
}

function renderRegional() {
  const items = currentRegionalItems();
  const buffalo = items.filter((item) => regionalIdForItem(item) === 'buffalo_western_new_york');
  const cleveland = items.filter((item) => regionalIdForItem(item) === 'cleveland_northeast_ohio');
  const remote = items.filter((item) => regionalIdForItem(item) === 'national_remote_us');
  const localCount = buffalo.length + cleveland.length;
  elements.regionalTabCount.textContent = displayCount(localCount);
  elements.regionalBuffaloCount.textContent = displayCount(buffalo.length);
  elements.regionalClevelandCount.textContent = displayCount(cleveland.length);
  elements.regionalRemoteCount.textContent = displayCount(remote.length);
  elements.regionalBuffaloSubheading.textContent = `${buffalo.length} current role${buffalo.length === 1 ? '' : 's'} in the Buffalo region. These receive the strongest location preference.`;
  elements.regionalClevelandSubheading.textContent = `${cleveland.length} current role${cleveland.length === 1 ? '' : 's'} in the Cleveland region. These receive a regional preference and remain additive.`;
  renderRegionalList(
    elements.regionalBuffaloList,
    buffalo,
    'No Buffalo-region roles are in the current queue.',
    'Refresh sources after the Buffalo / Western New York search lanes run. Civic contacts remain in the Civic tab.',
  );
  renderRegionalList(
    elements.regionalClevelandList,
    cleveland,
    'No Cleveland-region roles are in the current queue.',
    'Refresh sources after the Cleveland / Northeast Ohio search lanes run. CWRU and health-system research roles are included in that lane.',
  );
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

function displayCount(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : '—';
}

function renderViewCounts() {
  const state = ui.state;
  if (!state) {
    elements.queueTabCount.textContent = '—';
    elements.regionalTabCount.textContent = '—';
    elements.questionsTabCount.textContent = '—';
    elements.handoffsTabCount.textContent = '—';
    elements.outreachTabCount.textContent = '—';
    return;
  }
  const handoffRecords = Array.isArray(state.handoffs?.preparation)
    ? state.handoffs.preparation
    : Array.isArray(state.handoffs?.pages) ? state.handoffs.pages : [];
  const outreachRecords = Array.isArray(state.outreach) ? state.outreach : [];
  const regionalCount = currentRegionalItems()
    .filter((item) => ['buffalo_western_new_york', 'cleveland_northeast_ohio'].includes(regionalIdForItem(item))).length;
  elements.queueTabCount.textContent = displayCount(state.totals?.selected ?? state.selected?.length ?? 0);
  elements.regionalTabCount.textContent = displayCount(regionalCount);
  elements.questionsTabCount.textContent = displayCount(state.questions?.length ?? 0);
  elements.handoffsTabCount.textContent = displayCount(handoffRecords.length);
  elements.outreachTabCount.textContent = displayCount(outreachRecords.length + xOutboxDrafts().length);
}

function selectView(view, { focus = false } = {}) {
  const nextView = VIEW_ORDER.includes(view) ? view : 'queue';
  ui.view = nextView;
  const tabs = [...document.querySelectorAll('[data-view-tab]')];
  tabs.forEach((tab) => {
    const active = tab.dataset.viewTab === nextView;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (focus && active) tab.focus();
  });
  document.querySelectorAll('[data-view-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== nextView;
  });
  document.querySelectorAll('[data-context-view]').forEach((control) => {
    control.hidden = control.dataset.contextView !== nextView;
  });
  if (elements.wordmarkCurrent) elements.wordmarkCurrent.textContent = VIEW_LABELS[nextView];
}

function render() {
  if (!ui.state) return;
  renderSummary();
  renderApplicationRun();
  renderFieldOptions();
  renderLocationOptions();
  renderLaneOptions();
  renderQueue();
  renderRegional();
  renderQuestions();
  renderHandoffs();
  renderXOutbox();
  renderOutreach();
  renderViewCounts();
  renderCivic();
  selectView(ui.view);
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

function legacyCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    if (!navigator.clipboard.readText) return;
    try {
      const copiedText = await navigator.clipboard.readText();
      if (copiedText === text) return;
    } catch {
      // Some browsers permit clipboard writes but deny reads. The resolved write
      // remains the strongest available confirmation in that environment.
      return;
    }
  }
  if (!legacyCopyText(text)) throw new Error('The browser could not copy this message. Select the text and copy it manually.');
}

async function copyXDraft(id, button) {
  const draft = xOutboxDrafts().find((candidate) => candidate.id === id);
  if (!draft?.body) {
    showToast('The saved X message could not be found. Refresh and try again.', true);
    return;
  }
  const originalLabel = button.textContent;
  button.disabled = true;
  try {
    await copyText(draft.body);
    button.textContent = 'Copied';
    showToast('X message copied. Opening X will not mark it saved or sent.');
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true);
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalLabel;
    }, 1200);
  }
}

async function markXDraftSent(id, button) {
  const draft = xOutboxDrafts().find((candidate) => candidate.id === id);
  if (!draft) {
    showToast('The saved X message could not be found. Refresh and try again.', true);
    return;
  }
  const confirmed = window.confirm(`Mark the message to ${draft.contact?.name || draft.contact?.handle || 'this contact'} as sent and dismiss it from the outbox?`);
  if (!confirmed) return;
  button.disabled = true;
  try {
    const payload = await requestJson('/api/x-outreach/mark-sent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    ui.state = payload.state || ui.state;
    setConnection(true);
    render();
    showToast('Marked sent and dismissed. The local record was retained for history.');
  } catch (error) {
    button.disabled = false;
    showToast(error instanceof Error ? error.message : String(error), true);
  }
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
    const handoffStatus = String(ui.state.handoffs?.status || '');
    if (['starting', 'running'].includes(handoffStatus) && !ui.handoffPollTimer) {
      ui.handoffPollTimer = setInterval(() => loadQueue({ quiet: true }), 2000);
    } else if (!['starting', 'running'].includes(handoffStatus) && ui.handoffPollTimer) {
      clearInterval(ui.handoffPollTimer);
      ui.handoffPollTimer = null;
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
    await requestJson('/api/applications/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 6 }),
    });
    await loadQueue({ quiet: true });
    showToast('The top six supported applications are being filled. Review and submit them in the Chrome handoff window.');
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
    showToast('Opening one Chrome window and filling known answers. Review unresolved fields and submit manually.');
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
  const choiceField = card.querySelector(`[data-question-choice="${CSS.escape(questionId)}"]`);
  const multiChoiceFields = [...card.querySelectorAll(`[data-question-multi-choice="${CSS.escape(questionId)}"]:checked`)];
  const answer = multiChoiceFields.length
    ? multiChoiceFields.map((field) => String(field.value).trim()).filter(Boolean).join('; ')
    : String(choiceField?.value || answerField?.value || '').trim();
  const queueIds = String(card.dataset.queueIds || card.dataset.queueId || '').split(',').map((value) => value.trim()).filter(Boolean);
  const followUp = card.querySelector('[data-question-follow-up]');
  const followUpRequired = followUp && !followUp.hidden && /^yes\b/i.test(answer);
  const followUpId = followUp?.dataset.questionFollowUp || '';
  const followUpAnswer = followUpId
    ? String(followUp.querySelector(`[data-question-follow-up-answer="${CSS.escape(followUpId)}"]`)?.value || '').trim()
    : '';
  if (!answer) {
    showToast('Add an answer before saving it to the ledger.', true);
    return;
  }
  if (followUpRequired && !followUpAnswer) {
    showToast('Add the requested example before saving.', true);
    return;
  }
  const button = card.querySelector(`[data-question-submit="${CSS.escape(questionId)}"]`);
  if (button) button.disabled = true;
  try {
    let payload = await requestJson('/api/questions/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: questionId, queueIds, answer, scope: 'question' }),
    });
    if (followUpRequired) {
      const followUpQueueIds = String(followUp.dataset.queueIds || '').split(',').map((value) => value.trim()).filter(Boolean);
      payload = await requestJson('/api/questions/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: followUpId, queueIds: followUpQueueIds, answer: followUpAnswer, scope: 'question' }),
      });
    }
    if (payload.state) ui.state = payload.state;
    if (Array.isArray(ui.state?.questions)) {
      ui.state.questions = ui.state.questions.filter((question) => question.id !== questionId);
    }
    renderQuestions();
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
        ui.state = outreach.state || ui.state;
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

async function mutateCivic(key, action, button) {
  if (!key || !['dismiss', 'restore'].includes(action)) return;
  button.disabled = true;
  try {
    const payload = await requestJson('/api/civic/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, action }),
    });
    if (payload.civic) ui.state.civic = payload.civic;
    setConnection(true);
    render();
    showToast(action === 'dismiss'
      ? 'Civic lead dismissed from the active view. Source evidence was retained.'
      : 'Civic lead restored to the active view.');
  } catch (error) {
    button.disabled = false;
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

const viewTabs = [...document.querySelectorAll('[data-view-tab]')];
viewTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectView(tab.dataset.viewTab));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? viewTabs.length - 1
        : (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + viewTabs.length) % viewTabs.length;
    const nextTab = viewTabs[nextIndex];
    selectView(nextTab.dataset.viewTab, { focus: true });
  });
});

elements.refreshButton.addEventListener('click', refreshQueue);
elements.clearQueueButton.addEventListener('click', clearTodayQueue);
elements.openHandoffsButton.addEventListener('click', openHandoffs);
elements.xOutboxList.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const copyButton = target?.closest('[data-x-copy]');
  if (copyButton?.dataset.xCopy) {
    copyXDraft(copyButton.dataset.xCopy, copyButton);
    return;
  }
  const markSentButton = target?.closest('[data-x-mark-sent]');
  if (markSentButton?.dataset.xMarkSent) markXDraftSent(markSentButton.dataset.xMarkSent, markSentButton);
});
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
elements.civicView.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-civic-action]') : null;
  if (!target) return;
  const key = target.dataset.civicKey;
  const action = target.dataset.civicAction;
  if (key && action) mutateCivic(key, action, target);
});
elements.questionList.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-question-submit]') : null;
  if (!target) return;
  const card = target.closest('[data-question-id]');
  const questionId = target.dataset.questionSubmit;
  if (card && questionId) submitQuestion(card, questionId);
});
elements.questionList.addEventListener('change', (event) => {
  const selected = event.target instanceof HTMLSelectElement
    ? event.target.closest('[data-question-choice]')
    : null;
  if (selected) {
    const card = selected.closest('[data-question-id]');
    const followUp = card?.querySelector('[data-question-follow-up]');
    if (followUp) {
      const trigger = String(followUp.dataset.trigger || 'Yes');
      followUp.hidden = String(selected.value).trim().toLowerCase() !== trigger.trim().toLowerCase();
    }
    return;
  }
  const changed = event.target instanceof HTMLInputElement
    ? event.target.closest('[data-question-multi-choice]')
    : null;
  if (!changed || !changed.checked) return;
  const card = changed.closest('[data-question-id]');
  if (!card) return;
  const choices = [...card.querySelectorAll('[data-question-multi-choice]')];
  if (changed.value.trim().toLowerCase() === 'none') {
    choices.forEach((choice) => { if (choice !== changed) choice.checked = false; });
  } else {
    choices.forEach((choice) => {
      if (choice.value.trim().toLowerCase() === 'none') choice.checked = false;
    });
  }
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
