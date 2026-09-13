# LI Engine — Make-Free, Notion-Backed Rebuild

Status: **scripts written and syntax-checked; not yet run against real
credentials.** Nothing here posts or comments until a human supplies real
Unipile/Notion/Slack credentials, flips `LI_ENGINE_DRY_RUN=false`, and runs
the manual dry run in §7 of the plan. See "Open questions" below for what's
still blocking that.

## What exists now

1. **Notion data layer** — created live in the workspace, under a page
   titled "LI Engine — Automation":
   - `LI Posts` — data source `bccf543f-a3c7-4216-a2e9-3ca631eea146`
   - `LI Targets` — data source `da7c8dc6-12e6-4917-87a9-2225bc9a1fe5`
   - `LI Comments` — data source `95bdd8ae-5c91-4d4a-a5b1-04839b2a8abd` (relation → Targets)
   - `LI Metrics` — data source `f6d08955-3344-4622-9cdd-93aa9c08fa83` (relation → Posts)
   - `Automation Runs` — data source `7de4a2e1-b4d0-4984-9a51-5fa46c7e8a7a`

   These match the schema in §4 of the plan, with the two structural fixes
   called out there: `Replies Received` defaults to 0 at creation (fixes the
   uninitialized-field bug in the source Make design), and `Last Scanned` /
   `Needs Attention` were added for round-robin scanning and reply
   surfacing respectively.

2. **Five scenario scripts** (`scripts/*.js`), each a standalone Node
   script with no dependencies beyond Node 18+'s built-in `fetch`:
   - `approval-sync.js` — cron every 15 min, e.g. `*/15 * * * *` — **new**,
     not in the source Make design; see "Slack approval flow" below
   - `post-publisher.js` — cron `30 4 * * 2,3,4`
   - `feed-scanner-commenter.js` — cron `0 5-17/2 * * 1-5`
   - `reply-monitor.js` — cron `0 6-18/2 * * 1-5`
   - `engagement-tracker.js` — cron `0 20 * * *`

   Each reproduces the exact logic of the corresponding source Make
   blueprint (pulled live from the Make account — scenario IDs 7324733,
   7324773, 7324782, 7324726, all confirmed at 0 executions) plus the
   specific optimizations called out per-scenario in §6 of the plan
   (retry caps + alerting, round-robin targets, content-aware dedupe,
   the replies-received fix, the account_id gap in Engagement Tracker).

   `lib/` holds the shared pieces: `config.js` (env loading, fails loudly
   if anything's missing), `notion.js` (thin REST wrapper), `unipile.js`
   (thin REST wrapper + the randomized human-pacing sleeps from §2.4), and
   `run-log.js` (wraps every scenario run, logs to `Automation Runs`,
   fires a Slack alert on failure).

3. **Safety default**: `LI_ENGINE_DRY_RUN=true` unless explicitly set to
   `false`. In dry run, Unipile calls are logged, not sent, and the
   Automation Runs write is logged, not sent. This is deliberate — it lets
   someone exercise the Notion-reading/logic side safely before any real
   credential exists.

## Slack approval flow (added on top of the original plan)

`Status` on `LI Posts` and `LI Comments` now has an extra state:
`draft → pending_review → approved → published/posted`. `approval-sync.js`
is what moves a record between the first three:

1. **Notify pass** — any row sitting at `draft` gets posted to the Slack
   channel you configure (the post/comment text, plus instructions), flips
   to `pending_review`, and remembers the Slack thread (`Slack Thread TS` /
   `Slack Channel`) so it knows what to check next.
2. **Listen pass** — any row at `pending_review` gets its thread checked
   for a reply:
   - reply exactly `approve` → `Status = approved`, content unchanged.
   - reply is anything else → that text **replaces** the post/comment
     text AND `Status = approved` in the same step — editing it in Slack
     is itself the approval, no separate confirm needed.
   - no reply yet → stays `pending_review`, checked again next run.

Only `approved` rows are ever touched by Post Publisher's publish step or
Feed Scanner + Commenter's post-pass — Approval Sync is a hard gate in
front of both, so nothing reaches LinkedIn without a Slack reply from a
human.

## What is NOT done, and why

- **No cron schedules are registered.** Per the plan's own build sequence
  (§7), schedules only get registered after a clean manual dry run against
  real credentials. Once they do, register these as Claude scheduled tasks
  (not local cron) — five separate scheduled tasks, one per script, each
  invoking the relevant `npm run <name>` in this project with real env
  vars set, on the cadences above.
- **No Slack channel/bot wired up yet.** `SLACK_BOT_TOKEN` /
  `SLACK_CHANNEL_ID` are env var placeholders — see "Setting up Slack"
  below for how to get real values.
- **The content pipeline (§5) is not automated on purpose.** Drafting posts
  and comments via the `linkedin-skills` bundle is explicitly
  human-invoked, not scheduled — that bundle isn't installed in this
  environment and shouldn't be wired into a cron job even once it is; a
  person (or a manually-run Claude session) drafts into `LI Posts` /
  `LI Comments` with `Status = draft`, and only a human flip to `approved`
  lets either scheduled script touch the record.
- **Real integration testing hasn't happened.** These scripts are
  syntax-checked (`node -c` on every file passes) and the config loader's
  fail-fast behavior was verified, but no live call has been made to
  Notion or Unipile — that requires the credentials in `.env.example`,
  which don't exist yet.

## Open questions still outstanding

1. Where does the raw Unipile API key live at runtime long-term? There's
   no Make-style masked credential vault here — for now it's a plain env
   var, which is fine for a first live test but worth revisiting once this
   is running unattended on a schedule.
2. Unipile connection: **resolved** — already connected on Jules Resny's
   LinkedIn. Still need from you: the account's `UNIPILE_BASE_URL` (the
   per-account API subdomain Unipile issued), `UNIPILE_API_KEY`, and
   `UNIPILE_ACCOUNT_ID`.
3. Does the partner want to personally approve every post/comment in
   Slack, or should others be able to reply "approve" too? Right now
   Approval Sync accepts a reply from anyone in the channel — restrict the
   channel's membership if that's not the intent.
4. Does Unipile's engagement-stats endpoint (`GET /api/v1/posts/{id}`)
   require `account_id`? The source scenario never passed one and was
   never validated live. `lib/unipile.js#getPostStats` now passes it —
   confirm against current Unipile docs and adjust if it turns out to be
   rejected rather than just optional.
5. Confirm the exact Unipile endpoint paths/methods for posting comments
   and fetching reply counts (used as `POST /api/v1/posts/{id}/comments`
   and `GET /api/v1/posts/{id}/comments` here) — the source blueprints
   only showed posts-fetch and profile-lookup in detail.

## Setting up Notion access (step by step)

1. Go to https://www.notion.so/profile/integrations (while logged into
   the Rift Capital workspace) and click **New integration**.
2. Name it something like `LI Engine automation`, pick the Rift Capital
   workspace, and under **Capabilities** enable Read content, Update
   content, and Insert content. Save.
3. On the integration's **Secrets** tab, copy the **Internal Integration
   Token** (starts with `ntn_` or `secret_`) — this is your
   `NOTION_API_KEY`.
4. In Notion, open the **"LI Engine — Automation"** page (the parent page
   these 5 databases live under). Click the `•••` menu in the top right →
   **Connections** → add the `LI Engine automation` integration you just
   created. Connecting it at the parent page level gives it access to all
   5 databases underneath automatically.
5. Paste the token into `.env` as `NOTION_API_KEY`. The 5 database IDs are
   already filled in for you in `.env.example` (they're fixed — I created
   these databases already, they won't change).

## Setting up Slack (step by step)

1. Go to https://api.slack.com/apps → **Create New App** → **From
   scratch**. Name it (e.g. `LI Engine`) and pick the Rift Capital
   workspace.
2. Under **OAuth & Permissions** → **Scopes** → **Bot Token Scopes**, add:
   `chat:write`, and `channels:history` if the alert channel will be a
   public channel (use `groups:history` instead for a private channel).
3. Still on **OAuth & Permissions**, click **Install to Workspace** at the
   top, approve it, then copy the **Bot User OAuth Token** (starts with
   `xoxb-`) — this is your `SLACK_BOT_TOKEN`.
4. In Slack, create or pick the channel you want approval requests and
   failure alerts to land in, then invite the bot: type `/invite @LI
   Engine` in that channel (use whatever you named the app in step 1).
5. Get the channel ID: open the channel, click its name at the top →
   scroll to the bottom of the details panel → copy the **Channel ID**
   (looks like `C0123456789`). That's your `SLACK_CHANNEL_ID`.
6. Paste both into `.env`.

## Running a dry run (step by step)

This validates the logic without touching Unipile, Slack, or the
Automation Runs log — safe to do before real Unipile credentials exist,
once Notion/Slack are set up per the two sections above.

1. Make sure Node 18+ is installed (`node -v`). This project has zero npm
   dependencies — it only uses Node's built-in `fetch`.
2. In the `li-engine` folder: `cp .env.example .env`, then fill in
   `NOTION_API_KEY` and the 5 `NOTION_DB_*_ID` values (already correct in
   the example), plus `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID`. Leave the
   three `UNIPILE_*` vars blank for now — dry run doesn't need them to be
   real, but the config loader still requires them to be *present*, so set
   them to any placeholder string (e.g. `UNIPILE_BASE_URL=https://placeholder`,
   `UNIPILE_API_KEY=placeholder`, `UNIPILE_ACCOUNT_ID=placeholder`).
3. Leave `LI_ENGINE_DRY_RUN=true` (the default).
4. Load the env file and run each script one at a time:
   ```bash
   set -a && source .env && set +a
   node scripts/approval-sync.js
   node scripts/post-publisher.js
   node scripts/feed-scanner-commenter.js
   node scripts/reply-monitor.js
   node scripts/engagement-tracker.js
   ```
5. Read the console output — each `[DRY RUN]` line shows exactly what
   would have been sent to Slack or Unipile, and what would have been
   written to `Automation Runs`, without anything actually happening.
   Real Notion reads/writes for Posts/Targets/Comments/Metrics DO happen
   in dry run (only Unipile calls and the Automation Runs log are
   suppressed) — that's intentional, so you can watch real Notion records
   move through `draft → pending_review → approved` in the Notion UI as
   you reply "approve" in Slack, even before Unipile is wired up.
6. Once that all looks right, set `LI_ENGINE_DRY_RUN=false` and get real
   Unipile credentials in before running `post-publisher.js` or
   `feed-scanner-commenter.js` again — those are the only two that ever
   call Unipile with side effects (publishing a post, posting a comment).
