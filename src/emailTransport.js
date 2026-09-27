const MAILTRAP_RULE_ID = 289432;

/**
 * Build a session rule removing Origin only from this extension's known mail POSTs.
 * @param {string} extensionId Initiator extension ID; never a wildcard.
 * @returns {object} Chrome declarativeNetRequest rule.
 */
export function mailtrapHeaderRule(extensionId) {
  return {
    id: MAILTRAP_RULE_ID,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: {
      regexFilter: '^https://(sandbox\\.api\\.mailtrap\\.io/api/send/[1-9][0-9]*|(send|bulk)\\.api\\.mailtrap\\.io/api/send)/?$',
      initiatorDomains: [extensionId],
      requestMethods: ['post'],
      resourceTypes: ['xmlhttprequest'],
    },
  };
}

/**
 * Install the idempotent header rule before sending; preserve it across concurrent tabs.
 * Browser previews are a no-op, while an installed extension missing permissions fails.
 * @param {object} [chromeApi=globalThis.chrome] Chrome API or a compatible test double.
 * @returns {Promise<void>}
 * @throws {Error} Required permission/API is unavailable or the rule cannot be installed.
 */
export async function prepareMailtrapTransport(chromeApi = globalThis.chrome) {
  // Browser previews cannot modify Origin. Installed extension pages can, using
  // existing host access plus a rule restricted to this extension's mail POSTs.
  if (!chromeApi?.runtime?.id) return;
  if (!chromeApi.declarativeNetRequest?.updateSessionRules) {
    throw new Error('Reload LinkSlope in chrome://extensions to enable the email request fix, then reopen the scanner.');
  }
  try {
    await chromeApi.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [MAILTRAP_RULE_ID],
      addRules: [mailtrapHeaderRule(chromeApi.runtime.id)],
    });
  } catch {
    throw new Error('Could not enable the email request fix. Reload LinkSlope in chrome://extensions and reopen the scanner.');
  }
  // Retain the idempotent session rule so overlapping sends in different tabs
  // cannot remove each other's rule. Chrome clears it at browser shutdown.
}
