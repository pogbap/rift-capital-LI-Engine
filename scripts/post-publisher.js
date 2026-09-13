#!/usr/bin/env node
'use strict';

/**
 * LI Engine — Post Publisher
 * Cron: 30 4 * * 2,3,4  (Tue/Wed/Thu 04:30 Europe/Paris — matches source cadence, §2.5)
 *
 * Source logic being reproduced (blueprint 7324733, confirmed live from the
 * Make account — 0 executions): find the oldest `approved` post, publish it
 * via Unipile, mark published/failed. §6.1 optimizations added on top:
 *   - explicit Retry Count cap (source had none — a broken post retried forever)
 *   - Slack alert once Retry Count hits the cap, instead of silently sitting failed
 */

const config = require('../lib/config');
const { queryDataSource, updatePage, prop, readProp } = require('../lib/notion');
const unipile = require('../lib/unipile');
const { runScenario } = require('../lib/run-log');

async function main() {
  const approved = await queryDataSource(
    config.notion.databases.posts,
    { property: 'Status', select: { equals: 'approved' } },
    [{ property: 'Scheduled Time', direction: 'ascending' }]
  );

  if (approved.length === 0) {
    return { outcome: 'no-op', recordsTouched: 0 };
  }

  const post = approved[0];
  const text = readProp(post, 'Text') || '';
  const hashtags = readProp(post, 'Hashtags') || '';
  const body = text + (hashtags ? `\n\n${hashtags}` : '');

  const res = await unipile.publishPost(body);
  const now = new Date().toISOString();

  if (res.statusCode >= 200 && res.statusCode < 300) {
    await updatePage(post.id, {
      Status: prop.select('published'),
      'Social ID': prop.richText(res.data.id || ''),
      'Last Attempt': prop.date(now),
    });
    return { outcome: 'success', recordsTouched: 1 };
  }

  // Failure path: increment retry count, cap and alert per §6.1.
  const retryCount = (readProp(post, 'Retry Count') || 0) + 1;
  const errText = JSON.stringify(res.data);

  if (retryCount < config.retry.maxAttempts) {
    // Leave Status = approved so the next scheduled firing retries automatically.
    await updatePage(post.id, {
      'Retry Count': prop.number(retryCount),
      'Last Attempt': prop.date(now),
      Error: prop.richText(errText),
    });
    return {
      outcome: 'partial',
      recordsTouched: 1,
      errorDetail: `Post publish failed (attempt ${retryCount}/${config.retry.maxAttempts}): ${errText}`,
    };
  }

  await updatePage(post.id, {
    Status: prop.select('failed'),
    'Retry Count': prop.number(retryCount),
    'Last Attempt': prop.date(now),
    Error: prop.richText(errText),
  });
  return {
    outcome: 'failure',
    recordsTouched: 1,
    alert: true,
    errorDetail: `Post permanently failed after ${retryCount} attempts: ${errText}`,
  };
}

if (require.main === module) {
  runScenario('Post Publisher', main);
}

module.exports = { main };
