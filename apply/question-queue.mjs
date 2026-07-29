import {
  findQuestionMatch,
  isNonQuestionPrompt,
  isSensitiveQuestion,
  loadLedger,
  questionId,
} from './question-ledger.mjs';
import { selectProjectAccomplishment } from '../project-accomplishment-ledger.mjs';

export function questionPayload(items, ledger = loadLedger()) {
  const grouped = new Map();
  items
    .filter((item) => item.applicationState === 'blocked_by_question')
    .flatMap((item) => {
      const reviews = Array.isArray(item.applicationResult?.needsReview)
        ? item.applicationResult.needsReview
        : [];
      return reviews.map((review) => {
        const question = String(review.label || '').replace(/^EEO:\s*/i, '').trim();
        if (!question || isNonQuestionPrompt(question)) return null;
        const sensitivity = isSensitiveQuestion(question) ? 'high' : 'normal';
        const entry = ledger.entries.find((candidate) => candidate.id === questionId(question))
          || findQuestionMatch(question, ledger, {
            fieldKind: review.kind || review.fieldKind || '',
            options: Array.isArray(review.options) ? review.options : [],
            sensitivity,
          })?.entry;
        const canonicalId = entry?.id || questionId(question);
        const accomplishment = selectProjectAccomplishment({
          question,
          company: item.company,
          title: item.title,
          description: item.description,
          lane: item.lane,
        });
        const options = Array.isArray(review.options) && review.options.length
          ? review.options
          : (entry?.options || []);
        const occurrence = {
          queueId: item.id,
          company: item.company,
          role: item.title,
          url: item.applyUrl || item.canonicalUrl,
        };
        const existing = grouped.get(canonicalId);
        if (existing) {
          existing.queueIds = [...new Set([...existing.queueIds, item.id])];
          existing.occurrences.push(occurrence);
          existing.options = [...new Set([...existing.options, ...options])];
          if (!existing.suggestedAnswer && accomplishment?.answer) {
            existing.suggestedAnswer = accomplishment.answer;
          }
          return null;
        }
        grouped.set(canonicalId, {
          id: canonicalId,
          queueId: item.id,
          queueIds: [item.id],
          occurrences: [occurrence],
          occurrenceCount: 1,
          company: item.company,
          role: item.title,
          url: item.applyUrl || item.canonicalUrl,
          question: entry?.question || question,
          reason: review.reason || entry?.blockerReason || 'required field needs an answer',
          options: [...new Set(options)],
          sensitivity: entry?.sensitivity || 'normal',
          suggestedAnswer: accomplishment?.answer || '',
          answer: entry?.answer || '',
          scope: ['question', 'company', 'role'].includes(String(entry?.scope || ''))
            ? entry.scope
            : 'question',
        });
        return null;
      }).filter(Boolean);
    });
  return [...grouped.values()].map((question) => ({
    ...question,
    occurrenceCount: question.occurrences.length,
  }));
}
