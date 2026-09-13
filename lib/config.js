'use strict';

/**
 * Central config loader. Every credential and ID here is intentionally
 * pulled from the environment — nothing is ever hardcoded in a script or
 * embedded in a scheduled-task prompt. See §2.3 / §8 of the rebuild plan:
 * where this key actually lives at runtime (a secrets manager, the
 * scheduled-task's env, etc.) is an open question for a human to resolve
 * before this ever runs against a real account.
 */
function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env var ${name}. See li-engine/README.md — this must be ` +
        `set before any script in this package can run against real data.`
    );
  }
  return v;
}

function optional(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const config = {
  unipile: {
    // e.g. https://api58.unipile.com:18826 in the source export — will be a
    // different per-account subdomain once the partner's Unipile account exists.
    baseUrl: required('UNIPILE_BASE_URL'),
    apiKey: required('UNIPILE_API_KEY'),
    accountId: required('UNIPILE_ACCOUNT_ID'),
  },
  notion: {
    apiKey: required('NOTION_API_KEY'),
    databases: {
      posts: required('NOTION_DB_POSTS_ID'),
      targets: required('NOTION_DB_TARGETS_ID'),
      comments: required('NOTION_DB_COMMENTS_ID'),
      metrics: required('NOTION_DB_METRICS_ID'),
      runs: required('NOTION_DB_RUNS_ID'),
    },
  },
  llm: {
    // Used only by Content Drafter (scripts/content-drafter.js) to filter
    // raw news input and write draft posts. Optional at the config layer —
    // every other script in this repo runs fine without it — but
    // lib/llm.js#generateDrafts throws loudly if a real (non-dry-run) call
    // is attempted without it.
    apiKey: optional('ANTHROPIC_API_KEY', null),
    model: optional('ANTHROPIC_MODEL', 'claude-sonnet-4-5'),
  },
  slack: {
    // Bot token (not just an incoming webhook) because the approval flow
    // both posts messages AND reads thread replies. Needs chat:write plus
    // channels:history / groups:history / im:history (whichever matches
    // SLACK_CHANNEL_ID). Leave unset in dev/dry-run — calls are logged, not sent.
    botToken: optional('SLACK_BOT_TOKEN', null),
    channelId: optional('SLACK_CHANNEL_ID', null),
  },
  retry: {
    maxAttempts: parseInt(optional('LI_ENGINE_MAX_RETRIES', '3'), 10),
  },
  // Safety valve: when true, scripts print what they *would* do (including
  // the Unipile request they would send) but do not actually call Unipile or
  // write back to Notion. Use this for the manual dry runs required by §7.3
  // before any cron schedule is registered.
  dryRun: optional('LI_ENGINE_DRY_RUN', 'true') === 'true',
};

module.exports = config;
