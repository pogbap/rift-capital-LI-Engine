#!/usr/bin/env node
'use strict';

/**
 * LI Engine — Reply Monitor
 * Cron: 0 6-18/2 * * 1-5  (every 2h, weekdays 06:00–18:00 — matches source cadence, §2.5)
 *
 * Source logic being reproduced (blueprint 7324782, confirmed live — 0 executions):
 * for up to 10 `posted` comments, fetch the current reply count and compare
 * against the stored `Replies Received`; if higher, flag it.
 *
 * §6.3 fix: source compared `length(replies) > replies_received` but
 * `replies_received` was never initialized anywhere in the source design —
 * the comparison only worked by accident on a truthy/blank value. Because
 * Feed Scanner + Commenter now initializes it to 0 at creation (§4.3), this
 * comparison is correct from the very first check.
 *
 * §6.3 addition: flips `Needs Attention` so a human actually goes and reads
 * the new replies — the source only ever recorded the count, it never
 * surfaced anything for a person to act on.
 */

const config = require('../lib/config');
const { queryDataSource, updatePage, prop, readProp } = require('../lib/notion');
const unipile = require('../lib/unipile');
const { runScenario } = require('../lib/run-log');

const BATCH_LIMIT = 10; // preserves source's per-run cap

async function main() {
  const posted = (
    await queryDataSource(config.notion.databases.comments, {
      property: 'Status',
      select: { equals: 'posted' },
    })
  ).slice(0, BATCH_LIMIT);

  if (posted.length === 0) return { outcome: 'no-op', recordsTouched: 0 };

  let flagged = 0;
  let checked = 0;

  for (const comment of posted) {
    await unipile.randomSleep(3, 7); // source pacing, §2.4
    const socialId = readProp(comment, 'Target Post Social ID');
    const res = await unipile.getPostComments(socialId);
    const currentCount = (res.data?.items || []).length;
    const storedCount = readProp(comment, 'Replies Received') || 0;
    checked += 1;

    if (currentCount > storedCount) {
      await updatePage(comment.id, {
        'Replies Received': prop.number(currentCount),
        'Needs Attention': prop.checkbox(true),
        Timestamp: prop.date(new Date().toISOString()),
      });
      flagged += 1;
    }
  }

  return { outcome: flagged > 0 ? 'success' : 'no-op', recordsTouched: checked };
}

if (require.main === module) {
  runScenario('Reply Monitor', main);
}

module.exports = { main };
