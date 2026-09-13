'use strict';

const config = require('./config');
const { createPage, prop } = require('./notion');
const slack = require('./slack');

/**
 * Wraps a scenario's main() so every run — success, partial, failure, or
 * no-op — is logged to `Automation Runs`, and a Slack alert fires on
 * failure or max-retry-exceeded, regardless of how main() exits.
 * This replaces Make's execution history + gives us the alerting the
 * source scenarios never had.
 */
async function runScenario(scenarioName, main) {
  const startedAt = new Date().toISOString();
  let outcome = 'success';
  let recordsTouched = 0;
  let errorDetail = '';
  let shouldAlert = false;

  try {
    const result = await main();
    recordsTouched = result?.recordsTouched ?? 0;
    outcome = result?.outcome ?? (recordsTouched === 0 ? 'no-op' : 'success');
    shouldAlert = !!result?.alert;
    if (result?.errorDetail) errorDetail = result.errorDetail;
  } catch (err) {
    outcome = 'failure';
    errorDetail = err.stack || String(err);
    shouldAlert = true;
    console.error(`[${scenarioName}] run failed:`, err);
  }

  const finishedAt = new Date().toISOString();

  if (shouldAlert) {
    await sendSlackAlert(scenarioName, outcome, errorDetail);
  }

  if (!config.dryRun) {
    await createPage(config.notion.databases.runs, {
      Name: prop.title(`${scenarioName} — ${startedAt}`),
      Scenario: prop.select(scenarioName),
      'Started At': prop.date(startedAt),
      'Finished At': prop.date(finishedAt),
      Outcome: prop.select(outcome),
      'Records Touched': prop.number(recordsTouched),
      'Error Detail': prop.richText(errorDetail),
      Alerted: prop.checkbox(shouldAlert),
    });
  } else {
    console.log(
      `[DRY RUN] Automation Runs log entry:`,
      JSON.stringify({ scenarioName, startedAt, finishedAt, outcome, recordsTouched, errorDetail, shouldAlert }, null, 2)
    );
  }

  if (outcome === 'failure') process.exitCode = 1;
}

async function sendSlackAlert(scenarioName, outcome, detail) {
  const text = `:rotating_light: *LI Engine — ${scenarioName}* ended \`${outcome}\`\n${detail ? '```' + detail.slice(0, 1500) + '```' : ''}`;
  if (!config.slack.botToken || !config.slack.channelId) {
    console.warn(`[ALERT NOT SENT — SLACK_BOT_TOKEN/SLACK_CHANNEL_ID not configured]\n${text}`);
    return;
  }
  try {
    await slack.postAlert(text);
  } catch (err) {
    console.error('Failed to send Slack alert:', err);
  }
}

module.exports = { runScenario };
