#!/usr/bin/env node
'use strict';

/**
 * LI Engine — Feed Scanner + Commenter
 * Cron: 0 5-17/2 * * 1-5  (every 2h, weekdays 05:00–17:00 — matches source cadence, §2.5)
 *
 * Source logic being reproduced (blueprint 7324773, confirmed live — 0 executions):
 * scan one target's last 3 posts, create a draft comment record for any not
 * already tracked, then (separately) post any comment that's been approved.
 *
 * §6.2 optimizations added on top of source:
 *   - round-robin target selection via `Last Scanned` (source always scanned
 *     whichever target sorted first — same target every run)
 *   - dedupe via a real relational lookup on `Target Post Social ID` instead
 *     of the source's ad hoc `cmt_<id>` key convention
 *   - comment drafting is NOT done here — this only creates an empty draft
 *     record for a human/`linkedin-skills` pass to fill in (§5)
 *   - only `approved` comments get posted; nothing here posts autonomously
 */

const config = require('../lib/config');
const { queryDataSource, createPage, updatePage, prop, readProp } = require('../lib/notion');
const unipile = require('../lib/unipile');
const { runScenario } = require('../lib/run-log');

async function scanPass() {
  const active = await queryDataSource(config.notion.databases.targets, {
    property: 'Active',
    checkbox: { equals: true },
  });
  if (active.length === 0) return { scanned: 0, drafted: 0 };

  // Round-robin: least-recently-scanned first, nulls (never scanned) first.
  active.sort((a, b) => {
    const ta = readProp(a, 'Last Scanned');
    const tb = readProp(b, 'Last Scanned');
    if (!ta && !tb) return 0;
    if (!ta) return -1;
    if (!tb) return 1;
    return new Date(ta) - new Date(tb);
  });
  const target = active[0];
  const linkedinUrl = readProp(target, 'LinkedIn URL');
  const handle = unipile.extractHandle(linkedinUrl);

  await unipile.randomSleep(8, 13); // source pacing, §2.4

  const res = await unipile.getUserPosts(handle, 3);
  const items = res.data?.items || [];

  let drafted = 0;
  for (const post of items) {
    const existing = await queryDataSource(config.notion.databases.comments, {
      property: 'Target Post Social ID',
      rich_text: { equals: post.id },
    });
    if (existing.length > 0) continue; // already tracked — source's dedupe intent, done relationally

    await createPage(config.notion.databases.comments, {
      Name: prop.title(`Draft comment on ${post.id}`),
      Target: prop.relation([target.id]),
      'Target Post Social ID': prop.richText(post.id),
      'Comment Text': prop.richText(''), // left empty for §5 drafting pipeline
      Status: prop.select('draft'),
      'Is Reply': prop.checkbox(false),
      'Replies Received': prop.number(0), // fixes source's uninitialized-field bug, §4.3
      'Needs Attention': prop.checkbox(false),
      Timestamp: prop.date(new Date().toISOString()),
    });
    drafted += 1;
  }

  await updatePage(target.id, { 'Last Scanned': prop.date(new Date().toISOString()) });
  return { scanned: 1, drafted };
}

async function postPass() {
  const approved = await queryDataSource(config.notion.databases.comments, {
    property: 'Status',
    select: { equals: 'approved' },
  });

  let posted = 0;
  let failed = 0;
  for (const comment of approved) {
    await unipile.randomSleep(8, 13); // source pacing, §2.4
    const socialId = readProp(comment, 'Target Post Social ID');
    const text = readProp(comment, 'Comment Text');
    const res = await unipile.postComment(socialId, text);
    const now = new Date().toISOString();

    if (res.statusCode >= 200 && res.statusCode < 300) {
      await updatePage(comment.id, { Status: prop.select('posted'), Timestamp: prop.date(now) });
      posted += 1;
    } else {
      await updatePage(comment.id, {
        Status: prop.select('failed'),
        Timestamp: prop.date(now),
      });
      failed += 1;
    }
  }
  return { posted, failed };
}

async function main() {
  const scan = await scanPass();
  const post = await postPass();
  const recordsTouched = scan.drafted + post.posted + post.failed;
  return {
    outcome: post.failed > 0 ? 'partial' : recordsTouched === 0 ? 'no-op' : 'success',
    recordsTouched,
    alert: post.failed > 0,
    errorDetail: post.failed > 0 ? `${post.failed} comment(s) failed to post` : '',
  };
}

if (require.main === module) {
  runScenario('Feed Scanner + Commenter', main);
}

module.exports = { main, scanPass, postPass };
