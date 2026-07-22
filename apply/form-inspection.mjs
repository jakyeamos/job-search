// @ts-check

/** @param {string} url */
export function normalizeApplicationUrl(url) {
  const value = String(url || '').trim();
  if (!value) return value;
  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase().includes('ashbyhq.com') && !/\/application\/?$/i.test(parsed.pathname)) {
      parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/application`;
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

/** @param {string} url */
export function applicationAdapter(url) {
  try {
    const host = new URL(normalizeApplicationUrl(url)).hostname.toLowerCase();
    if (host.includes('greenhouse')) return 'greenhouse';
    if (host.includes('ashbyhq')) return 'ashby';
    if (host.includes('lever.co')) return 'lever';
  } catch { /* malformed URLs are reported by the caller */ }
  return 'unknown';
}

/**
 * Inspect the rendered form without filling controls, selecting options,
 * uploading files, clicking buttons, or reading current values.
 * @param {import('playwright').Page} page
 * @param {{ expectedTitle?: string }} [options]
 */
export async function inspectApplicationPage(page, options = {}) {
  const report = await page.evaluate((expectedTitle) => {
    const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const cleanLabel = (value) => compact(value).replace(/[\u2731*]+$/g, '').trim();
    const fieldContainer = (el) => el.closest(
      '[data-field-path], [data-testid*="field" i], [class*="_fieldEntry"], [class*="application-question"], [class*="question" i], fieldset, [class*="Field"], [class*="field" i]',
    );
    const visible = (el) => {
      if (el.getAttribute('aria-hidden') === 'true' || el.closest('[aria-hidden="true"]')) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
    };
    const labelFor = (el) => {
      const container = fieldContainer(el);
      const choice = (el.getAttribute('type') || '').toLowerCase() === 'radio'
        || (el.getAttribute('type') || '').toLowerCase() === 'checkbox';
      if (choice && container) {
        const heading = container.querySelector('legend, [class*="question-title" i], [data-field-label], [class*="_heading" i], h1, h2, h3');
        const description = container.querySelector('[class*="description" i], [data-field-description]');
        const headingText = compact(heading?.textContent);
        const descriptionText = compact(description?.textContent);
        const genericDescription = /^(input gender|gender input|input race|race input|input veteran|veteran input)$/i.test(descriptionText);
        const sensitiveHeading = /gender|race|veteran|disabilit/i.test(headingText);
        const groupLabel = descriptionText && !genericDescription && !sensitiveHeading
          ? descriptionText
          : [headingText, descriptionText].filter(Boolean).join(' ');
        if (compact(groupLabel)) return cleanLabel(groupLabel);
      }
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label && compact(label.textContent)) return cleanLabel(label.textContent);
      }
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
        if (compact(text)) return cleanLabel(text);
      }
      const wrapper = el.closest('label');
      if (wrapper && compact(wrapper.textContent)) return cleanLabel(wrapper.textContent);
      if (container) {
        const heading = container.querySelector('legend, [class*="label" i], [class*="heading" i], [class*="question-title" i], label');
        if (heading && compact(heading.textContent)) return cleanLabel(heading.textContent);
      }
      return cleanLabel(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || 'Unlabeled field');
    };
    const requiredFor = (el, container) => el.hasAttribute('required')
      || el.getAttribute('aria-required') === 'true'
      || Boolean(container?.querySelector('[aria-required="true"], [class*="required" i], [data-required="true"]'));
    const optionText = (option) => cleanLabel(option.textContent || option.getAttribute('aria-label') || option.getAttribute('data-label'));
    const categoryFor = (label, kind) => {
      if (kind === 'file' || /resume|résumé|curriculum vitae|cover letter|cover note/i.test(label)) return 'artifact';
      if (/first name|last name|full name|legal name|email|phone|linkedin|github|portfolio|website/i.test(label)) return 'standard';
      return 'question';
    };
    const manualReason = (label) => {
      if (/gender|race|ethnic|hispanic|latino|veteran|disabilit|self[-\s]?identif|voluntary self/i.test(label)) return 'voluntary self-identification — complete manually';
      if (/captcha|recaptcha|hcaptcha|one[- ]time password|multi[- ]factor|verification code/i.test(label)) return 'CAPTCHA or identity verification — complete manually';
      if (/attest|certif|background|criminal|conviction|terms (?:and|of)|agree.*(?:accurate|truth|conditions|terms)/i.test(label)) return 'legal or attestation field — review manually';
      if (/marketing|newsletter|updates|promotional|subscribe|receive (?:emails|communications)/i.test(label)) return 'marketing consent — leave unchecked unless you choose otherwise';
      return '';
    };
    const controls = [];
    const grouped = new Set();
    const containerIds = new WeakMap();
    let nextContainerId = 0;
    const containerKey = (container) => {
      if (!container) return '';
      if (!containerIds.has(container)) containerIds.set(container, `container-${nextContainerId++}`);
      return containerIds.get(container);
    };
    const elements = Array.from(document.querySelectorAll('input, textarea, select, [role="combobox"]'))
      .filter((el) => {
        if (el.type === 'hidden' || el.name === 'g-recaptcha-response') return false;
        if (visible(el)) return true;
        const type = (el.getAttribute('type') || el.tagName).toLowerCase();
        return (type === 'radio' || type === 'checkbox') && visible(fieldContainer(el));
      });

    for (const el of elements) {
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || tag).toLowerCase();
      const container = fieldContainer(el);
      const isChoice = type === 'radio' || type === 'checkbox';
      const groupKey = isChoice
        ? `${type}:${containerKey(container) || el.name || el.id}`
        : '';
      if (isChoice && grouped.has(groupKey)) continue;
      if (isChoice) grouped.add(groupKey);
      const label = labelFor(el);
      const kind = type === 'textarea' ? 'textarea'
        : type === 'file' ? 'file'
          : tag === 'select' ? 'select'
            : el.getAttribute('role') === 'combobox' ? 'combobox'
              : isChoice ? type : 'text';
      const options = isChoice
        ? (() => {
          const optionNodes = Array.from(container?.querySelectorAll('button, label, [role="option"]') || []);
          const headingText = compact(container?.querySelector('[class*="heading" i], [class*="question-title" i]')?.textContent);
          const descriptionText = compact(container?.querySelector('[class*="description" i], [data-field-description]')?.textContent);
          const visibleOptions = optionNodes.map((node) => cleanLabel(node.textContent || node.getAttribute('aria-label')))
            .filter((value) => value && value !== headingText && value !== descriptionText);
          if (visibleOptions.length) return visibleOptions;
          return Array.from(container?.querySelectorAll(`input[type="${type}"]`) || [el]).map((input) => {
            const optionLabel = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : input.closest('label');
            return cleanLabel(optionLabel?.textContent || input.getAttribute('value'));
          }).filter(Boolean);
        })()
        : tag === 'select'
          ? Array.from(el.options).map(optionText).filter(Boolean)
          : kind === 'combobox'
            ? (() => {
              const listId = el.getAttribute('aria-controls');
              const list = listId ? document.getElementById(listId) : container;
              return Array.from(list?.querySelectorAll('[role="option"], .select__option') || []).map(optionText).filter(Boolean);
            })()
            : [];
      const fieldPath = container?.getAttribute('data-field-path') || '';
      const field = {
        id: el.id || '',
        name: el.name || '',
        tag,
        type,
        kind,
        label,
        required: requiredFor(el, container),
        options: [...new Set(options)],
        fieldPath,
        category: categoryFor(label, kind),
        manualReason: manualReason(label),
      };
      controls.push(field);
    }

    const buttonNodes = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
    const buttons = buttonNodes
      .filter(visible)
      .map((el) => {
        const text = compact(el.textContent || el.getAttribute('value') || el.getAttribute('aria-label'));
        return {
        text,
        type: el.getAttribute('type') || '',
        submitLike: /submit|apply(?: now)?|send application|finish|complete application/i.test(text),
        nextLike: /^(next|continue|save and continue|go to next|review application|proceed)\b/i.test(text),
        blockedLike: /captcha|recaptcha|hcaptcha|verification|multi[- ]factor|one[- ]time password|sign in|log in/i.test(text),
        disabled: Boolean(el.disabled),
        };
      })
      .filter((button) => button.text);
    const bodyText = compact(document.body?.innerText || '');
    const titleVisible = expectedTitle
      ? [document.title, document.querySelector('h1')?.textContent, bodyText]
        .map(compact)
        .some((value) => value.toLowerCase().includes(compact(expectedTitle).toLowerCase()))
      : Boolean(compact(document.title) || compact(document.querySelector('h1')?.textContent));
    const authRequired = /(?:sign|log)\s*in|create an account|register to apply|account required/i.test(bodyText)
      && Boolean(document.querySelector('input[type="password"], input[autocomplete="username"], input[autocomplete="email"]'));
    const challengeDetected = /captcha|recaptcha|hcaptcha|verify you are human|one[- ]time password|multi[- ]factor|identity verification/i.test(bodyText)
      || controls.some((control) => Boolean(control.manualReason && /captcha|identity verification/i.test(control.manualReason)));
    const manualSignals = [...new Set([
      ...controls.map((control) => control.manualReason).filter(Boolean),
      ...buttons.map((button) => /captcha|recaptcha|hcaptcha|verification|multi[- ]factor/i.test(button.text) ? button.text : '').filter(Boolean),
    ])];
    return {
      title: compact(document.title),
      heading: compact(document.querySelector('h1')?.textContent),
      formCount: document.querySelectorAll('form').length,
      controls,
      buttons,
      manualSignals,
      titleVisible,
      authRequired,
      challengeDetected,
      formReady: controls.length > 0 && (document.querySelectorAll('form').length > 0
        || buttons.some((button) => button.submitLike)
        || Boolean(document.querySelector('[class*="application-form" i], [data-testid*="application" i]'))),
    };
  }, String(options.expectedTitle || ''));
  return { url: page.url(), ...report };
}

/**
 * Traverse only safe, local form steps. The traversal never reads current
 * values and never fills, selects, uploads, submits, or follows external
 * navigation controls.
 * @param {import('playwright').Page} page
 * @param {{ maxPages?: number, settleMs?: number, expectedTitle?: string }} [options]
 */
export async function inspectApplicationFlow(page, options = {}) {
  const maxPages = Math.max(1, Math.min(Number(options.maxPages || 8), 20));
  const pages = [];
  const warnings = [];
  const visited = new Set();
  let blockedReason = '';

  for (let index = 0; index < maxPages; index += 1) {
    const inspection = await inspectApplicationPage(page, { expectedTitle: options.expectedTitle });
    const identity = JSON.stringify({
      url: inspection.url,
      title: inspection.title,
      heading: inspection.heading,
      controls: (inspection.controls || []).map((control) => [control.label, control.kind, control.required]),
      buttons: (inspection.buttons || []).map((button) => [button.text, button.nextLike, button.submitLike]),
    });
    if (visited.has(identity)) {
      warnings.push('read-only form traversal stopped because the page repeated');
      break;
    }
    visited.add(identity);
    pages.push(inspection);

    if (inspection.authRequired) {
      blockedReason = 'login or account verification is required before the application form can be inspected';
      break;
    }
    if (inspection.challengeDetected) {
      blockedReason = 'CAPTCHA, MFA, or identity verification was detected; complete it manually';
      break;
    }

    const nextIndex = (inspection.buttons || []).findIndex((button) => button.nextLike && !button.disabled && !button.submitLike && !button.blockedLike);
    if (nextIndex < 0) break;
    const requiredControls = (inspection.controls || []).filter((control) => control.required === true);
    if (requiredControls.length) {
      blockedReason = 'required application fields are present; fill them manually before continuing to the next page';
      break;
    }

    try {
      const buttons = page.locator('button:visible, input[type="button"]:visible, input[type="submit"]:visible');
      const button = buttons.nth(nextIndex);
      await button.click({ timeout: 3_000 });
      await Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, options.settleMs || 250)),
      ]);
    } catch (error) {
      blockedReason = `read-only form traversal could not continue: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }

  if (pages.length >= maxPages && !blockedReason && pages.length > 0) {
    warnings.push(`read-only form traversal stopped at the ${maxPages}-page safety limit`);
  }
  const current = pages[pages.length - 1] || {
    url: page.url(), title: '', heading: '', controls: [], buttons: [], formReady: false,
  };
  return {
    ...current,
    pages,
    pageCount: pages.length,
    blocked: Boolean(blockedReason),
    blockedReason,
    warnings,
  };
}
