// @ts-check

/** @param {unknown} value */
function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** @param {unknown} value */
function normalizedLabel(value) {
  return compact(value).replace(/[\u2731*]+$/g, '').trim().toLowerCase();
}

/** @param {string} value */
function idSelector(value) {
  return `[id="${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

/**
 * Read choices from a React Select-style combobox without choosing one.
 * The menu is opened only long enough to read its rendered options, then
 * closed again. This keeps option discovery separate from answer selection.
 *
 * @param {import('playwright').Page} page
 * @param {{ id?: string, label?: string, settleMs?: number }} [target]
 * @returns {Promise<string[]>}
 */
export async function readReactSelectOptions(page, target = {}) {
  const input = await findCombobox(page, target);
  if (!input || !(await input.count())) return [];

  const wasOpen = (await input.getAttribute('aria-expanded')) === 'true';
  try {
    if (!wasOpen) {
      const control = input.locator(
        'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " select__control ")][1]',
      );
      if (await control.count()) await control.click();
      else await input.click();
      await page.waitForTimeout(Number(target.settleMs ?? 120));
    }

    const listboxId = await input.getAttribute('aria-controls');
    const listbox = listboxId
      ? page.locator(idSelector(listboxId)).first()
      : page.locator('[role="listbox"]:visible, .select__menu:visible').last();
    const optionLocator = listbox.locator('[role="option"], .select__option');
    const values = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      values.splice(0, values.length, ...(await optionLocator.allTextContents()).map(compact).filter(Boolean));
      if (values.length) break;
      await page.waitForTimeout(100);
    }
    return [...new Set(values)];
  } catch {
    return [];
  } finally {
    if (!wasOpen) await input.press('Escape').catch(() => {});
  }
}

/**
 * Locate by stable input id first, then by its associated label. The label
 * fallback covers adapters whose question collector only retains visible text.
 *
 * @param {import('playwright').Page} page
 * @param {{ id?: string, label?: string }} target
 */
async function findCombobox(page, target) {
  if (target.id) {
    const byId = page.locator(idSelector(target.id)).first();
    if (await byId.count()) return byId;
  }
  const expected = normalizedLabel(target.label);
  if (!expected) return null;
  const labels = page.locator('label');
  for (let index = 0; index < await labels.count(); index += 1) {
    const label = labels.nth(index);
    if (normalizedLabel(await label.innerText().catch(() => '')) !== expected) continue;
    const id = await label.getAttribute('for');
    if (id) {
      const byLabel = page.locator(idSelector(id)).first();
      if (await byLabel.count()) return byLabel;
    }
    const nested = label.locator('input[role="combobox"], [role="combobox"]').first();
    if (await nested.count()) return nested;
  }
  return null;
}
