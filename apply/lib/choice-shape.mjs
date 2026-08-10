// @ts-check

/** @param {unknown} value */
function cleanOption(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const CHOICE_KINDS = new Set(['radio', 'checkbox', 'select', 'combobox']);

/** @param {unknown} value */
function cleanQuestionLabel(value) {
  return cleanOption(value).replace(/[\u2731*]+$/g, '').trim();
}

/** @param {unknown} kind */
export function isChoiceField(kind) {
  return CHOICE_KINDS.has(String(kind || '').trim().toLowerCase());
}

/**
 * Preserve a choice-shaped control even when an adapter did not provide a
 * field kind. A prompt that explicitly asks someone to select or choose an
 * answer is enough to classify an otherwise untyped field as a single-choice
 * control; explicit text/textarea kinds remain authoritative.
 *
 * @param {unknown} kind
 * @param {unknown} label
 * @param {unknown} options
 */
export function inferChoiceFieldKind(kind, label = '', options = []) {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  if (isChoiceField(normalizedKind) || normalizedKind === 'text' || normalizedKind === 'textarea' || normalizedKind === 'file') {
    return normalizedKind;
  }
  if (normalizeChoiceOptions(options).length || /\b(?:select|choose|pick)\b/i.test(String(label || ''))) return 'select';
  return normalizedKind;
}

/**
 * Ashby can expose a conditional follow-up through one concatenated
 * accessibility label: parent question + choice summary + selected choice +
 * follow-up label. Preserve the follow-up, not the container transcript.
 * @param {unknown} value
 */
export function normalizeChoiceFollowUpLabel(value) {
  const split = splitChoiceFollowUpLabel(value);
  return cleanQuestionLabel(split?.followUp || value);
}

/**
 * Recover a conditional Yes follow-up from Ashby's concatenated accessibility
 * transcript while preserving the parent binary question.
 * @param {unknown} value
 * @returns {{ question: string, followUp: string, trigger: 'Yes' }|null}
 */
export function splitChoiceFollowUpLabel(value) {
  const label = cleanOption(value);
  const compound = label.match(
    /^(.+?\?)\s+(?:multiple choice|select one):\s*yes\s*\/\s*no\s+(?:yes\s+)?(.+)$/i,
  );
  if (!compound?.[1] || !compound?.[2]) return null;
  return {
    question: compound[1].trim(),
    followUp: compound[2].trim(),
    trigger: 'Yes',
  };
}

/**
 * Remove browser transport values and duplicate visible choices.
 * An unchecked HTML checkbox has no submitted value; when no value is
 * declared, browsers expose the synthetic checked value "on".
 * @param {unknown} options
 */
export function normalizeChoiceOptions(options = []) {
  if (!Array.isArray(options)) return [];
  return [...new Set(options.map(cleanOption).filter((option) => option && !/^on$/i.test(option)))];
}

/** @param {unknown} options */
export function isBinaryChoice(options = []) {
  const normalized = normalizeChoiceOptions(options);
  if (normalized.length !== 2) return false;
  const choices = normalized.map((option) => {
    if (/^yes(?:\b|[\s,.:;(\-])/i.test(option)) return 'yes';
    if (/^no(?:\b|[\s,.:;(\-])/i.test(option)) return 'no';
    return '';
  });
  return choices.includes('yes') && choices.includes('no');
}

/**
 * DOM type and answer cardinality are separate. Some ATS widgets use
 * checkbox-backed buttons for a single Yes/No answer.
 * @param {unknown} kind
 * @param {unknown} options
 * @param {unknown} explicitMultiple
 */
export function choiceAllowsMultiple(kind, options = [], explicitMultiple = undefined) {
  const normalized = normalizeChoiceOptions(options);
  if (isBinaryChoice(normalized)) return false;
  if (typeof explicitMultiple === 'boolean') return explicitMultiple;
  return String(kind || '').toLowerCase() === 'checkbox' && normalized.length > 0;
}

/** @param {Record<string, unknown>} field */
export function normalizeChoiceField(field) {
  const options = normalizeChoiceOptions(field.options);
  const label = normalizeChoiceFollowUpLabel(field.label);
  const kind = inferChoiceFieldKind(field.kind, label, options);
  return {
    ...field,
    label,
    kind,
    options,
    multiple: choiceAllowsMultiple(kind, options, field.multiple),
  };
}
