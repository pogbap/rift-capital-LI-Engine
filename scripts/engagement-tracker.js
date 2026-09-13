#!/usr/bin/env node
'use strict';

/**
 * LI Engine — Engagement Tracker
 * Cron: 0 20 * * *  (daily 20:00 — matches source cadence, §2.5)
 *
 * Source logic being reproduced (blueprint 7324726, confirmed live — 0 executions):
 * for every `published` post, fetch engagement stats via Unipile and record
 * a metrics snapshot. §6.4 note carried over verbatim from the plan: the
 * source's GET /api/v1/posts/{id} call passed NO account_id — never
 * validated live. This client (lib/unipile.js#getPostStats) now passes it;
 * confirm against current Unipile docs whether that's required, harmless,
 * or breaks the call, and adjust getPostStats() accordingly.
 *
 * Unlike source, this writes a NEW `LI Metrics` row per post per run (time
 * series), not an overwrite — the databases are separate per §4, so this was
 * already implied by the data model, not an extra optimization.
 */

const config = require('../lib/config');
const { queryDataSource, createPage, prop, readProp } = require('../lib/notion');
const unipile = require('../lib/unipile');
const { runScenario } = require('../lib/run-log');

async function main() {
  const published = await queryDataSource(config.notion.databases.posts, {
    property: 'Status',
    select: { equals: 'published' },
  });

  if (published.length === 0) return { outcome: 'no-op', recordsTouched: 0 };

  let recorded = 0;
  let failed = 0;

  for (const post of published) {
    await unipile.randomSleep(2, 7); // source pacing, §2.4
    const socialId = readProp(post, 'Social ID');
    if (!socialId) continue;

    const res = await unipile.getPostStats(socialId);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      failed += 1;
      continue;
    }

    const d = res.data || {};
    const impressions = d.impressions || 0;
    const comments = d.comments_count || 0;
    const saves = d.saves_count || 0;

    await createPage(config.notion.databases.metrics, {
      Name: prop.title(`${socialId} — ${new Date().toISOString().slice(0, 10)}`),
      Post: prop.relation([post.id]),
      Impressions: prop.number(impressions),
      Likes: prop.number(d.reactions_count || 0),
      'Comments Count': prop.number(comments),
      Saves: prop.number(saves),
      Shares: prop.number(d.shares_count || 0),
      'Comment Ratio': prop.number(impressions > 0 ? (comments / impressions) * 100 : 0),
      'Save Ratio': prop.number(impressions > 0 ? (saves / impressions) * 100 : 0),
      'Recorded At': prop.date(new Date().toISOString()),
    });
    recorded += 1;
  }

  return {
    outcome: failed > 0 ? 'partial' : 'success',
    recordsTouched: recorded,
    alert: failed > 0,
    errorDetail: failed > 0 ? `${failed} post(s) failed to fetch stats` : '',
  };
}

if (require.main === module) {
  runScenario('Engagement Tracker', main);
}

module.exports = { main };
