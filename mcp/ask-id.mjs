const ASK_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Validate an agent-supplied ask id, returning it unchanged when safe.
 * @param {unknown} id
 * @returns {string}
 * @throws {Error} when the id could escape the pending/answers directories.
 */
export function sanitizeAskId(id) {
  if (typeof id !== 'string' || !ASK_ID_PATTERN.test(id) || id === '.' || id === '..') {
    throw new Error(`Invalid ask id: ${JSON.stringify(id)}`);
  }
  return id;
}

export const askIdPattern = ASK_ID_PATTERN;
