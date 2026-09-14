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
 *
 * §6.2.2 ROOT CAUSE FOUND + FIXED (2026-09-14): a real run against the full
 * 75-target pool came back "nothing in last 7d" for EVERY single target —
 * including Alex Konrad, manually confirmed to have posted 3 days prior and
 * reposted something 4 days prior. All 75 targets returning zero in their
 * last 3 posts is not a quiet week, it's a systematic failure. The actual
 * bug: `unipileRequest()` never checks whether the HTTP call succeeded —
 * `getUserPosts()` gets back whatever `res.json()` parsed (or `{}` on parse
 * failure) for ANY status code, and the old scanPass did
 * `res.data?.items || []` unconditionally. A 401/404/422/5xx from Unipile —
 * bad account_id, expired connection, wrong identifier format, whatever —
 * silently became "0 posts", which is indistinguishable from a genuinely
 * quiet target. That's why this needed a human to notice a missed post
 * before anyone realized the scanner wasn't actually seeing anything.
 *
 * Fix: scanPass now checks `res.statusCode` on every getUserPosts call. A
 * non-2xx is logged as an explicit API ERROR (with status + response body)
 * in the target's summary line, counted separately from genuine "0 posts in
 * window", and flips the run's `alert` so it surfaces in Automation Runs
 * instead of reading as a clean no-op. A future credentials/config problem
 * will now show up as a visible failure the same run it happens, not as
 * silence that only gets caught by someone screenshotting LinkedIn by hand.
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
  let apiErrors = 0;
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

    // §6.2.2 — a non-2xx from Unipile is a failed call, not "zero posts".
    // Treating it as the latter is exactly the bug that made a systematic
    // outage look like a quiet week across all 75 targets. Surface it.
    if (res.statusCode < 200 || res.statusCode >= 300) {
      apiErrors += 1;
      await updatePage(target.id, { 'Last Scanned': prop.date(new Date().toISOString()) });
      checkedTargets.push(
        `${name} (API ERROR ${res.statusCode}: ${JSON.stringify(res.data).slice(0, 200)})`
      );
      continue; // don't draft on data we never actually got
    }

    const items = res.data?.items || [];
    scanned += 1;

    let draftedForTarget = 0;
    let sawUndatedPost = false;
    const postDebug = []; // §6.2.2 — raw date-parse outcome per post, for diagnosing false negatives

    for (const post of items) {
      const postDate = extractPostDate(post);
      postDebug.push(
        postDate
          ? `${postDate.toISOString().slice(0, 10)}${isWithinRecencyWindow(postDate) ? '' : ' (outside 7d)'}`
          : `unparsed(raw date=${JSON.stringify(post.date)}, parsed_datetime=${JSON.stringify(post.parsed_datetime)})`
      );
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
    const outcomeLabel =
      draftedForTarget > 0
        ? ` (drafted ${draftedForTarget})`
        : items.length === 0
          ? ' (no posts returned)'
          : ` (${items.length} post(s), none in 7d: ${postDebug.join(', ')})`;
    checkedTargets.push(`${name}${outcomeLabel}`);
    if (sawUndatedPost) noDateSkips.push(name);

    if (draftedForTarget > 0) break; // found a real, recent, commentable post — stop here per operator request
  }

  return { scanned, drafted, apiErrors, checkedTargets, noDateSkips };
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
  const hasApiErrors = scan.apiErrors > 0;

  const scanSummary =
    `Scanned ${scan.scanned} target(s) of ${scan.checkedTargets.length} checked` +
    (hasApiErrors ? ` (${scan.apiErrors} API error(s))` : '') +
    `: ` +
    scan.checkedTargets.join('; ') +
    (scan.drafted > 0 ? '.' : ' — no post from the last 7 days found to draft a comment on.');

  return {
    outcome: post.failed > 0 || hasApiErrors ? 'partial' : recordsTouched === 0 ? 'no-op' : 'success',
    recordsTouched,
    alert: post.failed > 0 || hasApiErrors,
    errorDetail:
      post.failed > 0
        ? `${post.failed} comment(s) failed to post. ${scanSummary}`
        : hasApiErrors
          ? `${scan.apiErrors} Unipile call(s) failed during scan — see per-target detail. ${scanSummary}`
          : scanSummary,
  };
}

if (require.main === module) {
  runScenario('Feed Scanner + Commenter', main);
}

module.exports = { main, scanPass, postPass };
