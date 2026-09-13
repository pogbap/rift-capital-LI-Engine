#!/usr/bin/env node
'use strict';

/**
 * LI Engine — Content Drafter
 *
 * Not part of the original 5-scenario Make rebuild. Fills the gap called
 * out in README.md ("What is NOT done, and why" — the content pipeline is
 * deliberately not automated): this script is the human-invoked step that
 * turns raw news/topic input into new draft rows in `LI Posts`.
 *
 * It never publishes anything. Every row it creates is `Status = draft`,
 * the same gate every other post goes through — Approval Sync (or a human
 * directly in Notion) still has to move it to `pending_review` → `approved`
 * before Post Publisher will ever touch it.
 *
 * Input: CONTENT_DRAFTER_RAW_NEWS (env var) — a blob of pasted headlines,
 * snippets, links, whatever. The LLM call in lib/llm.js does the actual
 * filtering (rejecting stale/unverifiable/off-topic items) and writing.
 */

const config = require('../lib/config');
const { createPage, prop } = require('../lib/notion');
const llm = require('../lib/llm');
const { runScenario } = require('../lib/run-log');

const VALID_PILLARS = ['Market Commentary', 'News Repost', 'Humor', 'Thought Leadership'];

async function main() {
  const rawNews = (process.env.CONTENT_DRAFTER_RAW_NEWS || '').trim();
  const count = parseInt(process.env.CONTENT_DRAFTER_COUNT || '3', 10) || 3;
  const pillarHint = (process.env.CONTENT_DRAFTER_PILLAR_HINT || '').trim();

  if (!rawNews) {
    return {
      outcome: 'no-op',
      recordsTouched: 0,
      errorDetail: 'CONTENT_DRAFTER_RAW_NEWS was empty — nothing to filter, no drafts generated.',
    };
  }

  const { posts, rejectedCount, rejectionSummary } = await llm.generateDrafts(rawNews, {
    count,
    pillarHint,
  });

  if (posts.length === 0) {
    return {
      outcome: 'no-op',
      recordsTouched: 0,
      errorDetail: config.dryRun
        ? '[DRY RUN] No drafts generated (LLM call skipped in dry run).'
        : `LLM filtered out everything in the input batch. Rejected ${rejectedCount} item(s): ${rejectionSummary}`,
    };
  }

  let created = 0;
  const problems = [];

  for (const post of posts) {
    if (!post || typeof post.text !== 'string' || !post.text.trim()) {
      problems.push(`Skipped a post with no text: ${JSON.stringify(post)}`);
      continue;
    }
    const pillar = VALID_PILLARS.includes(post.pillar) ? post.pillar : null;
    if (!pillar) {
      problems.push(`Skipped "${post.name || '(untitled)'}" — invalid/missing pillar "${post.pillar}".`);
      continue;
    }

    await createPage(config.notion.databases.posts, {
      Name: prop.title(post.name || `Draft — ${new Date().toISOString()}`),
      Pillar: prop.select(pillar),
      Status: prop.select('draft'),
      Text: prop.richText(post.text),
      Hashtags: prop.richText(post.hashtags || ''),
      Format: prop.select('text'),
      'Retry Count': prop.number(0),
    });
    created += 1;
  }

  const summaryBits = [
    `Created ${created} draft LI Posts row(s) from ${posts.length} model-written post(s).`,
    rejectedCount ? `Filtered out ${rejectedCount} input item(s): ${rejectionSummary}` : null,
    problems.length ? `Problems: ${problems.join(' | ')}` : null,
  ].filter(Boolean);

  return {
    outcome: created > 0 ? 'success' : 'partial',
    recordsTouched: created,
    errorDetail: summaryBits.join(' '),
  };
}

if (require.main === module) {
  runScenario('Content Drafter', main);
}

module.exports = { main };
