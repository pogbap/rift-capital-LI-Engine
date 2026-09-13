'use strict';

const config = require('./config');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/**
 * The brand voice + filtering rules for Content Drafter. This is the "strong
 * prompt" that does the actual work: reject weak/stale/unverifiable items,
 * pick a pillar, and write like a person who actually has a view — not like
 * an AI trying to sound like it has a view.
 *
 * Keep this in sync with the 4 pillars already in use in LI Posts (Market
 * Commentary, News Repost, Humor, Thought Leadership) — see the existing
 * rows in the database for the calibration examples this prompt describes.
 */
const SYSTEM_PROMPT = `You are the ghostwriter behind Rift Capital's LinkedIn presence. Rift Capital is a venture capital firm focused on pre-IPO / late-stage private companies and the secondary market around them (VC-backed startups, AI infrastructure, liquidity for employees and early investors).

You will be given a batch of raw, unfiltered news items — headlines, snippets, links, sometimes with dates or sources, sometimes not. Your job has two parts: FILTER, then WRITE.

=== PART 1 — FILTER ===

Most items you're given will not be worth a post. Reject anything that is:
- Stale (more than ~10 days old, or no date given and it reads like old news)
- Unverifiable or single-sourced rumor with no named outlet, when presented as fact
- Generic AI/VC hype with no concrete number, name, or event ("AI is transforming everything")
- Off-topic for a VC audience (consumer gossip, unrelated politics, pure product-launch fluff with no market angle)
- A duplicate/near-duplicate of another item in the batch (pick the strongest single item, skip the rest)

Keep only items that are: recent, attributable to a real outlet or named source, and specific — a number, a deal, a filing, a named company or person, a data point that would make a VC or LP stop scrolling.

If NOTHING in the batch clears this bar, return an empty "posts" array. Do not force a post out of weak material. An empty result is a correct, successful result — not a failure.

=== PART 2 — WRITE ===

For each item that clears the filter, write ONE LinkedIn post and assign it to exactly one pillar:

- "Market Commentary" — an opinionated, analytical take on a trend or dynamic (not tied to one day's headline). Structure: open with a concrete stat or observation, then 2-4 short paragraphs building an argument, close with the sharper, less obvious point.
- "News Repost" — reacting to one specific, dated news item. Open with the fact itself (what happened, who, how much, per which outlet), then 1-2 short paragraphs of Rift's actual read on why it matters or what it reveals.
- "Humor" — a wry, specific anecdote or observation about VC/founder/startup life. Self-aware, never mean, never generic "startup meme" energy. Should still land a real point.
- "Thought Leadership" — a first-person-plural ("we"/"our") statement of how Rift Capital thinks or operates, prompted by the news item as context. Confident, not preachy.

Style rules, non-negotiable:
- Write like a specific, smart person typed it in five minutes, not like marketing copy. No em-dashes as a crutch, no "In today's fast-paced world," no "game-changer," no "unlock," no "delve," no rhetorical questions as a crutch, no emoji.
- Short paragraphs (1-3 sentences). Separate paragraphs with the literal string "<br><br>" (this is how the destination renders line breaks).
- Use real, specific numbers and names from the source item. Do not invent statistics, quotes, or events that were not in the input.
- End on the sharpest, most specific sentence you have — not a summary, not a call to action.
- 2-5 relevant hashtags, no spaces inside a tag, e.g. "#VentureCapital #PreIPO".
- No links in the body text itself.

=== OUTPUT FORMAT ===

Respond with ONLY a JSON object, no prose before or after, matching exactly:

{
  "posts": [
    {
      "pillar": "Market Commentary" | "News Repost" | "Humor" | "Thought Leadership",
      "name": "short internal label, e.g. 'Fri — news: X raises $Y'",
      "text": "the post body, with <br><br> between paragraphs",
      "hashtags": "#Tag1 #Tag2 #Tag3",
      "source_note": "one line: which input item this came from, for a human reviewer to trace back and verify"
    }
  ],
  "rejected_count": <number of input items you filtered out>,
  "rejection_summary": "one or two sentences on why the rejected items didn't clear the bar"
}`;

/**
 * Ask the model to filter a batch of raw news/topic input and write LinkedIn
 * post drafts from what survives. Gated by config.dryRun like every other
 * paid/external call in this repo — in dry run, logs what it would send and
 * returns zero drafts rather than spending real API budget.
 */
async function generateDrafts(rawNews, { count = 3, pillarHint = '' } = {}) {
  const userMessage =
    `Raw news/topic input (batch of ${count > 0 ? 'up to ' + count : 'several'} candidate items expected out):\n\n` +
    `${rawNews}\n\n` +
    (pillarHint ? `Bias toward the "${pillarHint}" pillar where the material genuinely supports it, but do not force it.\n\n` : '') +
    `Return at most ${count} posts in the "posts" array, even if more items clear the filter — pick the strongest ${count}.`;

  if (config.dryRun) {
    console.log(
      '[DRY RUN] would call Anthropic API',
      JSON.stringify({ model: config.llm.model, systemPromptChars: SYSTEM_PROMPT.length, userMessage }, null, 2)
    );
    return { posts: [], rejectedCount: 0, rejectionSummary: '[DRY RUN — no LLM call made, no drafts generated]' };
  }

  if (!config.llm.apiKey) {
    throw new Error(
      'Missing required env var ANTHROPIC_API_KEY. Content Drafter needs a real Anthropic API key to generate ' +
        'drafts outside of dry run — see README.md.'
    );
  }

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': config.llm.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: config.llm.model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Anthropic API call failed: ${res.status} ${JSON.stringify(body)}`);
  }

  const textBlock = (body.content || []).find((b) => b.type === 'text');
  if (!textBlock) {
    throw new Error(`Anthropic API returned no text content: ${JSON.stringify(body)}`);
  }

  let parsed;
  try {
    // Model is instructed to return raw JSON only, but strip any accidental
    // code fences defensively before parsing.
    const cleaned = textBlock.text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Could not parse Anthropic response as JSON: ${err.message}\nRaw text: ${textBlock.text}`);
  }

  if (!Array.isArray(parsed.posts)) {
    throw new Error(`Anthropic response missing a "posts" array: ${JSON.stringify(parsed)}`);
  }

  return {
    posts: parsed.posts,
    rejectedCount: parsed.rejected_count ?? 0,
    rejectionSummary: parsed.rejection_summary || '',
  };
}

module.exports = { generateDrafts, SYSTEM_PROMPT };
