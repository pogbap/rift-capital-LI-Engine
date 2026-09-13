#!/usr/bin/env node
'use strict';

/**
 * LI Engine — Approval Sync  (new scenario, not in the source Make design)
 * Cron: every 15 min, e.g. star/15 * * * *  (tune to taste — this is just
 * notifying/reading Slack, no LinkedIn-facing calls, so no pacing concerns)
 *
 * Closes the loop the user asked for: approving/editing posts and comments
 * from Slack instead of only in Notion.
 *
 * Pass 1 (notify): any LI Posts / LI Comments row sitting at `draft` with no
 * Slack thread yet gets posted to the approval channel and flipped to
 * `pending_review`.
 *
 * Pass 2 (listen): any row at `pending_review` gets its Slack thread
 * checked for a reply.
 *   - reply is exactly "approve" (case-insensitive) -> Status = approved,
 *     content unchanged.
 *   - reply is anything else -> that text REPLACES Text/Comment Text, and
 *     Status = approved (an edit from the person who owns the content is
 *     itself the approval — no second round trip required).
 *   - no reply yet -> left as pending_review for the next run to check again.
 *
 * Nothing ever reaches `approved` without a human reply in Slack. Post
 * Publisher / Feed Scanner + Commenter's post-pass only ever act on
 * `approved` rows, so this is a strict prerequisite gate in front of them.
 */

const config = require('../lib/config');
const { queryDataSource, updatePage, prop, readProp } = require('../lib/notion');
const slack = require('../lib/slack');
const { runScenario } = require('../lib/run-log');

async function notifyPass(dbId, kind) {
  const drafts = (
    await queryDataSource(dbId, { property: 'Status', select: { equals: 'draft' } })
  ).filter((r) => !readProp(r, 'Slack Thread TS'));

  let notified = 0;
  for (const record of drafts) {
    const body =
      kind === 'post'
        ? readProp(record, 'Text') + (readProp(record, 'Hashtags') ? `\n\n${readProp(record, 'Hashtags')}` : '')
        : readProp(record, 'Comment Text');

    if (kind === 'comment' && !body) {
      // Comment drafting (§5) hasn't happened yet — nothing to review.
      continue;
    }

    const label = kind === 'post' ? 'New LinkedIn post ready for review' : 'New LinkedIn comment ready for review';
    const text =
      `:memo: *${label}*\n` +
      '```' + body + '```\n' +
      '_Reply "approve" in this thread to publish as-is, or reply with edited text to use that instead (an edit counts as approval)._';

    const { channel, ts } = await slack.postMessage(text);
    await updatePage(record.id, {
      Status: prop.select('pending_review'),
      'Slack Thread TS': prop.richText(ts),
      'Slack Channel': prop.richText(channel),
    });
    notified += 1;
  }
  return notified;
}

async function listenPass(dbId, kind) {
  const pending = await queryDataSource(dbId, { property: 'Status', select: { equals: 'pending_review' } });

  let resolved = 0;
  for (const record of pending) {
    const channel = readProp(record, 'Slack Channel');
    const ts = readProp(record, 'Slack Thread TS');
    if (!channel || !ts) continue;

    const replies = await slack.getThreadReplies(channel, ts);
    if (replies.length === 0) continue; // nobody's answered yet

    const latest = replies[replies.length - 1];
    const replyText = (latest.text || '').trim();
    const isApproveAsIs = /^approve$/i.test(replyText);

    const contentField = kind === 'post' ? 'Text' : 'Comment Text';
    const update = { Status: prop.select('approved') };
    if (!isApproveAsIs && replyText) {
      update[contentField] = prop.richText(replyText);
    }
    if (kind === 'post') update['Approved By'] = prop.richText(latest.user || 'slack-reply');

    await updatePage(record.id, update);
    resolved += 1;
  }
  return resolved;
}

async function main() {
  const notifiedPosts = await notifyPass(config.notion.databases.posts, 'post');
  const notifiedComments = await notifyPass(config.notion.databases.comments, 'comment');
  const resolvedPosts = await listenPass(config.notion.databases.posts, 'post');
  const resolvedComments = await listenPass(config.notion.databases.comments, 'comment');

  const recordsTouched = notifiedPosts + notifiedComments + resolvedPosts + resolvedComments;
  return { outcome: recordsTouched === 0 ? 'no-op' : 'success', recordsTouched };
}

if (require.main === module) {
  runScenario('Approval Sync', main);
}

module.exports = { main, notifyPass, listenPass };
