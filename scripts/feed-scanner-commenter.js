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
 *
 * §6.2.1 broadened per operator request (2026-09-14): a single run now walks
 * *every* active target, round-robin order, until it finds at least one post
 * from the last 7 days that isn't already tracked — not just the one
 * least-recently-scanned target. This still only ever creates empty `draft`
 * rows; it does not comment or post anything itself. Every target visited
 * this run (whether or not it produced a draft) gets `Last Scanned` bumped,
 * so the round-robin ordering for the *next* run naturally continues from
 * wherever this run stopped.
 */

const config = require('../lib/config');
const { queryDataSource, createPage, updatePage, prop, readProp } = require('../lib/notion');
const unipile = require('../lib/unipile');
const { runScenario } = require('../lib/run-log');

const RECENCY_WINDOW_DAYS = 7;

// Unipile's exact field name for a post's publish date isn't pinned down in
// our docs access — try the field names its API has used across versions
// rather than hard-failing on one. If none parse, treat the post's date as
// unknown and skip it (never draft on something we can't confirm is recent —
// same "don't guess" spirit as the manual BLOCKED row this replaces).
function extractPostDate(post) {
  const candidates = [
    post.date,
    post.parsed_datetime,
    post.created_at,
    post.posted_at,
    post.share_date,
    post.time,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function isWithinRecencyWindow(date) {
  if (!date) return false;
  const ageMs = Date.now() - date.getTime();
  return ageMs >= 0 && ageMs <= RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

async function scanPass() {
  const active = await queryDataSource(config.notion.databases.targets, {
    property: 'Active',
    checkbox: { equals: true },
  });
  if (active.length === 0) return { scanned: 0, drafted: 0, checkedTargets: [] };

  // Round-robin: least-recently-scanned first, nulls (never scanned) first.
  active.sort((a, b) => {
    const ta = readProp(a, 'Last Scanned');
    const tb = readProp(b, 'Last Scanned');
    if (!ta && !tb) return 0;
    if (!ta) return -1;
    if (!tb) return 1;
    return new Date(ta) - new Date(tb);
  });

  let scanned = 0;
  let drafted = 0;
  const checkedTargets = [];
  const noDateSkips = [];

  for (const target of active) {
    const name = readProp(target, 'Name');
    const linkedinUrl = readProp(target, 'LinkedIn URL');
    let handle;
    try {
      handle = unipile.extractHandle(linkedinUrl);
    } catch (err) {
      checkedTargets.push(`${name} (skipped — ${err.message})`);
      continue; // don't burn a real API call on a target with no usable URL
    }

    await unipile.randomSleep(8, 13); // source pacing, §2.4

    const res = await unipile.getUserPosts(handle, 3);
    const items = res.data?.items || [];
    scanned += 1;

    let draftedForTarget = 0;
    let sawUndatedPost = false;

    for (const post of items) {
      const postDate = extractPostDate(post);
      if (!isWithinRecencyWindow(postDate)) {
        if (!postDate) sawUndatedPost = true;
        continue; // too old, or we can't confirm the date — don't draft on a guess
      }

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
      draftedForTarget += 1;
    }

    drafted += draftedForTarget;
    await updatePage(target.id, { 'Last Scanned': prop.date(new Date().toISOString()) });
    checkedTargets.push(
      `${name}${draftedForTarget > 0 ? ` (drafted ${draftedForTarget})` : sawUndatedPost ? ' (undated posts, skipped)' : ' (nothing in last 7d)'}`
    );
    if (sawUndatedPost) noDateSkips.push(name);

    if (draftedForTarget > 0) break; // found a real, recent, commentable post — stop here per operator request
  }

  return { scanned, drafted, checkedTargets, noDateSkips };
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

  const scanSummary =
    `Scanned ${scan.scanned} target(s) of ${scan.checkedTargets.length} checked: ` +
    scan.checkedTargets.join('; ') +
    (scan.drafted > 0 ? '.' : ' — no post from the last 7 days found to draft a comment on.');

  return {
    outcome: post.failed > 0 ? 'partial' : recordsTouched === 0 ? 'no-op' : 'success',
    recordsTouched,
    alert: post.failed > 0,
    errorDetail: post.failed > 0 ? `${post.failed} comment(s) failed to post. ${scanSummary}` : scanSummary,
  };
}

if (require.main === module) {
  runScenario('Feed Scanner + Commenter', main);
}

module.exports = { main, scanPass, postPass };
