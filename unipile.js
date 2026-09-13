'use strict';

const config = require('./config');

/**
 * Thin Unipile client. Every LinkedIn-facing action lives here so it's easy
 * to audit exactly what leaves the process and to keep pacing (§2.4)
 * centralized instead of duplicated per script.
 */
async function unipileRequest(method, path, { query, body } = {}) {
  const url = new URL(`${config.unipile.baseUrl}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

  if (config.dryRun) {
    console.log(`[DRY RUN] would ${method} ${url.toString()}`, body ? { body } : '');
    return { dryRun: true, statusCode: 200, data: {} };
  }

  const res = await fetch(url, {
    method,
    headers: {
      'X-API-KEY': config.unipile.apiKey,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { statusCode: res.status, data };
}

function publishPost(text) {
  return unipileRequest('POST', '/api/v1/posts', {
    body: { account_id: config.unipile.accountId, text },
  });
}

function getUserPosts(handle, limit = 3) {
  return unipileRequest('GET', `/api/v1/users/${encodeURIComponent(handle)}/posts`, {
    query: { account_id: config.unipile.accountId, limit },
  });
}

function postComment(postSocialId, text) {
  return unipileRequest('POST', `/api/v1/posts/${encodeURIComponent(postSocialId)}/comments`, {
    body: { account_id: config.unipile.accountId, text },
  });
}

function getPostComments(postSocialId) {
  return unipileRequest('GET', `/api/v1/posts/${encodeURIComponent(postSocialId)}/comments`, {
    query: { account_id: config.unipile.accountId },
  });
}

function getPostStats(postSocialId) {
  // §6.4: the source scenario called GET /api/v1/posts/{id} with NO account_id
  // and never had it validated (0 executions). Passing account_id here too —
  // confirm against current Unipile docs during build whether it's required,
  // accepted-but-ignored, or rejected, and adjust.
  return unipileRequest('GET', `/api/v1/posts/${encodeURIComponent(postSocialId)}`, {
    query: { account_id: config.unipile.accountId },
  });
}

/** Extract the LinkedIn public handle from a profile URL, matching source regex /in/([^/?#]+). */
function extractHandle(linkedinUrl) {
  const m = /\/in\/([^/?#]+)/.exec(linkedinUrl || '');
  if (!m) throw new Error(`Could not extract LinkedIn handle from URL: ${linkedinUrl}`);
  return m[1];
}

/** Randomized human-like pacing delay, matching/exceeding source sleeps (§2.4). Never skip this. */
function randomSleep(minSeconds, maxSeconds) {
  const ms = Math.floor((Math.random() * (maxSeconds - minSeconds) + minSeconds) * 1000);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  publishPost,
  getUserPosts,
  postComment,
  getPostComments,
  getPostStats,
  extractHandle,
  randomSleep,
};
