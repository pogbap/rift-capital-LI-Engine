'use strict';

const config = require('./config');

/**
 * Slack Web API client (bot token, not just an incoming webhook) — needed
 * because the approval flow has to both POST a message and later READ the
 * thread's replies, which an incoming webhook can't do.
 * Scopes needed on the bot token: chat:write, and one of
 * channels:history / groups:history / im:history depending on where
 * SLACK_CHANNEL_ID points (public channel, private channel, or DM).
 */
async function slackApi(method, params) {
  if (config.dryRun) {
    console.log(`[DRY RUN] would call Slack ${method}`, params);
    if (method === 'chat.postMessage') return { ok: true, ts: `dryrun-${Date.now()}` };
    if (method === 'conversations.replies') return { ok: true, messages: [] };
    return { ok: true };
  }
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.slack.botToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(params),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Slack API ${method} failed: ${body.error}`);
  return body;
}

/** Post a message (optionally as a thread reply) and return its ts. */
async function postMessage(text) {
  const body = await slackApi('chat.postMessage', {
    channel: config.slack.channelId,
    text,
  });
  return { channel: config.slack.channelId, ts: body.ts };
}

/** Send a plain alert (failure notices) — no thread tracking needed. */
function postAlert(text) {
  return postMessage(text);
}

/**
 * Read every reply after the original message in a thread.
 * Returns [] if nobody has replied yet.
 */
async function getThreadReplies(channel, threadTs) {
  const body = await slackApi('conversations.replies', {
    channel,
    ts: threadTs,
  });
  const messages = body.messages || [];
  // First message in the array is the original post itself — drop it.
  return messages.slice(1).filter((m) => !m.bot_id); // ignore the bot's own messages
}

module.exports = { postMessage, postAlert, getThreadReplies };
