import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../queue-ui/app.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../queue-ui/index.html', import.meta.url), 'utf8');
const renderQuestionsSource = appSource.slice(
  appSource.indexOf('function renderQuestions()'),
  appSource.indexOf('function renderHandoffs()'),
);
const submitQuestionSource = appSource.slice(
  appSource.indexOf('async function submitQuestion('),
  appSource.indexOf('async function refreshQueue()'),
);
const renderOutreachSource = appSource.slice(
  appSource.indexOf('function renderOutreach()'),
  appSource.indexOf('function renderQueue()'),
);
const renderXOutboxSource = appSource.slice(
  appSource.indexOf('function renderXOutbox()'),
  appSource.indexOf('function renderOutreach()'),
);

test('question ledger UI renders a compact canonical question and answer surface', () => {
  assert.match(renderQuestionsSource, /question\.question/);
  assert.match(renderQuestionsSource, /question-answer-row/);
  assert.doesNotMatch(renderQuestionsSource, /question\.company|question\.role|question\.sensitivity|question\.reason/);
  assert.doesNotMatch(renderQuestionsSource, /data-question-scope|Reuse at|Known choices/);
  assert.doesNotMatch(renderQuestionsSource, /question\.answer|question\.suggestedAnswer/);
});

test('question ledger UI saves answers for matching canonical questions', () => {
  assert.match(submitQuestionSource, /scope: 'question'/);
  assert.match(submitQuestionSource, /ui\.state\.questions\.filter/);
  assert.match(submitQuestionSource, /renderQuestions\(\)/);
  assert.doesNotMatch(submitQuestionSource, /await loadQueue/);
  assert.doesNotMatch(submitQuestionSource, /scopeField|data-question-scope/);
});

test('question ledger UI renders and serializes multi-answer checkbox questions', () => {
  assert.match(renderQuestionsSource, /question\.multiple/);
  assert.match(renderQuestionsSource, /data-question-multi-choice/);
  assert.match(submitQuestionSource, /querySelectorAll/);
  assert.match(submitQuestionSource, /join\('; '\)/);
  assert.match(appSource, /changed\.value\.trim\(\)\.toLowerCase\(\) === 'none'/);
});

test('choice-shaped questions never fall back to a free-text textarea when options are missing', () => {
  assert.match(renderQuestionsSource, /choiceQuestion/);
  assert.match(renderQuestionsSource, /question-choice-unavailable/);
  assert.match(renderQuestionsSource, /Choices unavailable/);
  assert.match(renderQuestionsSource, /choiceOptionsMissing/);
});

test('handoff UI explains the filled-tab human boundary and polls while tabs are opening', () => {
  const renderHandoffsSource = appSource.slice(
    appSource.indexOf('function renderHandoffs()'),
    appSource.indexOf('function contactDiscoveryMarkup()'),
  );
  assert.match(renderHandoffsSource, /session\.error/);
  assert.match(renderHandoffsSource, /status === 'failed'/);
  assert.match(renderHandoffsSource, /Known profile, confirmed-answer, résumé, and cover-letter fields are filled automatically/);
  assert.match(renderHandoffsSource, /unresolved questions and submission stay with you/);
  assert.match(appSource, /handoffPollTimer/);
  assert.match(appSource, /\['starting', 'running'\]\.includes\(handoffStatus\)/);
});

test('outreach UI renders only confirmed submission records', () => {
  assert.match(renderOutreachSource, /\.filter\(\(record\) => record\?\.submissionConfirmed === true\)/);
});

test('empty X outbox uses the section heading without a second empty-state heading', () => {
  assert.doesNotMatch(renderXOutboxSource, /No active X messages/);
  assert.doesNotMatch(renderXOutboxSource, /No saved X messages yet/);
  assert.match(renderXOutboxSource, /x-outbox-empty/);
});

test('queue UI exposes civic discovery as a keyboard-navigable tab with active and retained lanes', () => {
  assert.match(indexSource, /data-view-tab="civic"/);
  assert.match(indexSource, /role="tablist"/);
  assert.match(indexSource, /id="civicView"[^>]+hidden/);
  assert.match(indexSource, /id="civicCurrentList"/);
  assert.match(indexSource, /id="civicMissionList"/);
  assert.match(indexSource, /id="civicOutreachList"/);
  assert.match(indexSource, /id="civicStaleList"/);
  assert.match(indexSource, /id="civicDismissedList"/);
  assert.match(indexSource, /<details class="queue-section civic-lane civic-stale-disclosure"[^>]*aria-labelledby="civicStaleHeading">/);
  assert.doesNotMatch(indexSource, /<details class="queue-section civic-lane civic-stale-disclosure"[^>]*\bopen\b/);
  assert.match(indexSource, /<details class="queue-section civic-lane civic-dismissed-disclosure"[^>]*aria-labelledby="civicDismissedHeading">/);
  assert.doesNotMatch(indexSource, /<details class="queue-section civic-lane civic-dismissed-disclosure"[^>]*\bopen\b/);
  assert.match(indexSource, /civic-stale-toggle-closed/);
  assert.match(indexSource, /civic-stale-toggle-open/);
  assert.match(appSource, /ArrowRight/);
  assert.match(appSource, /selectView\(nextTab\.dataset\.viewTab, \{ focus: true \}\)/);
});

test('queue UI separates role review, questions, handoffs, outreach, and civic discovery into tabs', () => {
  for (const view of ['queue', 'regional', 'questions', 'handoffs', 'outreach', 'civic']) {
    assert.match(indexSource, new RegExp(`data-view-tab="${view}"`));
    assert.match(indexSource, new RegExp(`data-view-panel="${view}"`));
  }
  assert.match(indexSource, /id="regionalBuffaloList"/);
  assert.match(indexSource, /id="regionalClevelandList"/);
  assert.match(indexSource, /national US-remote roles stay in the Daily queue/i);
  assert.match(indexSource, /id="questionsView"[^>]+hidden/);
  assert.match(indexSource, /id="handoffsView"[^>]+hidden/);
  assert.match(indexSource, /id="outreachView"[^>]+hidden/);
  assert.match(indexSource, /data-context-view="queue"/);
  assert.match(appSource, /const VIEW_ORDER = \['queue', 'regional', 'questions', 'handoffs', 'outreach', 'civic'\]/);
  assert.match(appSource, /function renderRegional\(\)/);
  assert.match(appSource, /elements\.questionsTabCount/);
  assert.match(appSource, /elements\.handoffsTabCount/);
  assert.match(appSource, /elements\.outreachTabCount/);
  assert.match(appSource, /VIEW_ORDER\.includes\(view\)/);
});

test('civic UI renders source evidence and keeps external actions human-reviewed', () => {
  const civicSource = appSource.slice(
    appSource.indexOf('function civicEvidenceMarkup(record)'),
    appSource.indexOf('function tomorrow()'),
  );
  assert.match(civicSource, /civic\.currentRoles/);
  assert.match(civicSource, /civicEvidenceMarkup/);
  assert.match(civicSource, /record\?\.url/);
  assert.match(civicSource, /record\?\.layer/);
  assert.match(civicSource, /record\?\.orientation/);
  assert.match(civicSource, /record\?\.interestFit/);
  assert.match(civicSource, /Secondary bridge/);
  assert.match(civicSource, /Human-reviewed lead/);
  assert.doesNotMatch(civicSource, /\/api\/(action|applications|outreach)/);
  assert.match(civicSource, /data-civic-action="dismiss"/);
  assert.match(civicSource, /data-civic-action="restore"/);
  assert.match(appSource, /\/api\/civic\/action/);
  assert.match(appSource, /source evidence was retained/i);
  assert.match(indexSource, /Additive by design/);
  assert.match(indexSource, /mission-first Cleveland/i);
});
