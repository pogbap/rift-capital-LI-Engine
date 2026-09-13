'use strict';

const config = require('./config');

const NOTION_API = 'https://api.notion.com/v1';
// Notion's multi-data-source API. Every database created for this project is
// single-source, so "data source id" and "database id" are numerically the
// same underlying collection — but the query/create endpoints below are the
// current (2025-09-03+) data-source-shaped ones, not the older database ones.
const NOTION_VERSION = '2025-09-03';

async function notionFetch(path, opts = {}) {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${config.notion.apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Notion API ${opts.method || 'GET'} ${path} failed: ${res.status} ${JSON.stringify(body)}`
    );
  }
  return body;
}

/** Query all pages in a data source matching a Notion filter object, handling pagination. */
async function queryDataSource(dataSourceId, filter, sorts) {
  const results = [];
  let cursor;
  do {
    const body = await notionFetch(`/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: JSON.stringify({
        ...(filter ? { filter } : {}),
        ...(sorts ? { sorts } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
        page_size: 100,
      }),
    });
    results.push(...body.results);
    cursor = body.has_more ? body.next_cursor : undefined;
  } while (cursor);
  return results;
}

/** Create a page in a data source. `properties` uses Notion's property-value shape. */
function createPage(dataSourceId, properties) {
  return notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { data_source_id: dataSourceId },
      properties,
    }),
  });
}

function updatePage(pageId, properties) {
  return notionFetch(`/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });
}

// --- Small property-shape helpers, so scripts read declaratively ---
const prop = {
  title: (text) => ({ title: [{ text: { content: String(text).slice(0, 2000) } }] }),
  richText: (text) => ({ rich_text: [{ text: { content: String(text ?? '').slice(0, 2000) } }] }),
  select: (name) => (name ? { select: { name } } : { select: null }),
  number: (n) => ({ number: n === undefined || n === null ? null : Number(n) }),
  checkbox: (b) => ({ checkbox: !!b }),
  date: (iso) => ({ date: iso ? { start: iso } : null }),
  url: (u) => ({ url: u || null }),
  relation: (pageIds) => ({ relation: (pageIds || []).map((id) => ({ id })) }),
};

/** Pull a plain JS value back out of a Notion page's `properties` object. */
function readProp(page, name) {
  const p = page.properties[name];
  if (!p) return undefined;
  switch (p.type) {
    case 'title':
      return p.title.map((t) => t.plain_text).join('');
    case 'rich_text':
      return p.rich_text.map((t) => t.plain_text).join('');
    case 'select':
      return p.select ? p.select.name : null;
    case 'number':
      return p.number;
    case 'checkbox':
      return p.checkbox;
    case 'date':
      return p.date ? p.date.start : null;
    case 'url':
      return p.url;
    case 'relation':
      return p.relation.map((r) => r.id);
    default:
      return undefined;
  }
}

module.exports = { queryDataSource, createPage, updatePage, prop, readProp };
