const elements = {
  board: document.getElementById('board'),
  boardSummary: document.getElementById('boardSummary'),
  connectionStatus: document.getElementById('connectionStatus'),
  toast: document.getElementById('toast'),
};

const ui = { board: { columns: [], cards: [] }, toastTimer: 0 };

/** @param {unknown} value */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @param {boolean} ok */
function setConnection(ok) {
  elements.connectionStatus.querySelector('.status-dot').classList.toggle('is-error', !ok);
  elements.connectionStatus.lastChild.textContent = ok ? 'Local board' : 'Board unavailable';
}

/** @param {string} message @param {boolean} isError */
function showToast(message, isError = false) {
  clearTimeout(ui.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', isError);
  elements.toast.classList.add('is-visible');
  ui.toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 3400);
}

/** @param {string} url @param {RequestInit} options */
async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

/** The report cell is markdown like `[055](../reports/055-acme-2026-07-24.md)`. */
function reportLink(report) {
  const match = /\[([^\]]+)\]\(([^)]+)\)/.exec(String(report || ''));
  if (!match) return '';
  return `<span class="board-card-report">Report ${escapeHtml(match[1])}</span>`;
}

function renderCard(card) {
  return `
    <article class="board-card" draggable="true" data-num="${escapeHtml(card.num)}">
      <div class="board-card-head">
        <h3>${escapeHtml(card.role)}</h3>
        <span class="score-badge">${escapeHtml(card.score)}</span>
      </div>
      <p class="board-card-company">${escapeHtml(card.company)}</p>
      <div class="queue-meta">
        <span class="tag">#${escapeHtml(card.num)}</span>
        <span class="tag">${escapeHtml(card.date)}</span>
        ${reportLink(card.report)}
      </div>
      <textarea class="board-card-notes" rows="2" data-num="${escapeHtml(card.num)}" aria-label="Notes for ${escapeHtml(card.company)}">${escapeHtml(card.notes)}</textarea>
    </article>`;
}

function render() {
  const { columns, cards } = ui.board;
  elements.board.setAttribute('aria-busy', 'false');
  elements.board.innerHTML = columns.map((column) => {
    const columnCards = cards.filter((card) => card.status === column);
    const body = columnCards.length
      ? columnCards.map(renderCard).join('')
      : '<p class="board-column-empty">Nothing here yet.</p>';
    return `
      <section class="board-column" data-status="${escapeHtml(column)}" aria-label="${escapeHtml(column)}">
        <header class="board-column-head">
          <h3>${escapeHtml(column)}</h3>
          <span class="tag">${columnCards.length}</span>
        </header>
        <div class="board-column-body">${body}</div>
      </section>`;
  }).join('');
  elements.boardSummary.textContent = `${cards.length} application${cards.length === 1 ? '' : 's'} across ${columns.length} stages.`;
}

async function loadBoard() {
  try {
    ui.board = await requestJson('/api/board');
    setConnection(true);
    render();
  } catch (error) {
    setConnection(false);
    elements.board.setAttribute('aria-busy', 'false');
    elements.board.innerHTML = '<div class="empty-state"><h3>Could not load the board.</h3><p>Make sure the local queue server is running, then reload.</p></div>';
    showToast(error instanceof Error ? error.message : String(error), true);
  }
}

/** @param {string} url @param {Record<string, unknown>} body @param {string} message */
async function postBoard(url, body, message) {
  try {
    ui.board = await requestJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    setConnection(true);
    render();
    showToast(message);
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), true);
    await loadBoard();
  }
}

elements.board.addEventListener('dragstart', (event) => {
  const card = event.target.closest('.board-card');
  if (!card) return;
  event.dataTransfer.setData('text/plain', card.dataset.num);
  event.dataTransfer.effectAllowed = 'move';
  card.classList.add('is-dragging');
});

elements.board.addEventListener('dragend', (event) => {
  event.target.closest('.board-card')?.classList.remove('is-dragging');
});

elements.board.addEventListener('dragover', (event) => {
  const column = event.target.closest('.board-column');
  if (!column) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  column.classList.add('is-drop-target');
});

elements.board.addEventListener('dragleave', (event) => {
  event.target.closest('.board-column')?.classList.remove('is-drop-target');
});

elements.board.addEventListener('drop', (event) => {
  const column = event.target.closest('.board-column');
  if (!column) return;
  event.preventDefault();
  column.classList.remove('is-drop-target');
  const num = Number(event.dataTransfer.getData('text/plain'));
  const status = column.dataset.status;
  const card = ui.board.cards.find((entry) => entry.num === num);
  if (!card || card.status === status) return;
  postBoard('/api/board/status', { num, status }, `Moved #${num} to ${status}.`);
});

elements.board.addEventListener('focusout', (event) => {
  const field = event.target.closest('.board-card-notes');
  if (!field) return;
  const num = Number(field.dataset.num);
  const card = ui.board.cards.find((entry) => entry.num === num);
  if (!card || card.notes === field.value.trim()) return;
  postBoard('/api/board/notes', { num, notes: field.value }, `Saved notes on #${num}.`);
});

loadBoard();
