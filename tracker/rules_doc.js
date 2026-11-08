// Rules document reader: rules.md is law, and this is the only thing allowed to read it.
//
// Format contract (rules/rules.md):
//   ### rule.<id> <!-- tags: a b c -->
//   ... prose ...
//   ```json
//   { canonical numbers }
//   ```
// The json block is canonical; prose is explanation. Section ids and a content hash go into every
// TurnLog entry, which is how we later prove what the DM was told on round 37.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const HEADING = /^###\s+(rule\.[a-z0-9_.]+)\s*<!--\s*tags:([^>]+?)\s*-->\s*$/;

/** Parse rules.md into { id, tags, body, data, hash }. */
export function parseRules(text) {
  const lines = text.split(/\r?\n/);
  /** @type {{id:string,tags:string[],body:string,data:any,hash:string}[]} */
  const sections = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (m) {
      if (cur) sections.push(finish(cur, lines.slice(cur.start, i)));
      cur = { id: m[1], tags: m[2].trim().split(/\s+/).filter(Boolean), start: i + 1 };
    }
  }
  if (cur) sections.push(finish(cur, lines.slice(cur.start)));
  const byId = new Map(sections.map((s) => [s.id, s]));
  return { sections, byId, text };
}

function finish(head, bodyLines) {
  const body = bodyLines.join('\n').trim();
  const fence = body.match(/```json\s*\n([\s\S]*?)```/);
  let data = null;
  if (fence) {
    try {
      data = JSON.parse(fence[1]);
    } catch (e) {
      throw new Error(`${head.id}: canonical json block is not valid JSON - ${e.message}`);
    }
  }
  return {
    ...head,
    body,
    data,
    // hash the canonical numbers, not the prose: retuning a number must bust the cache, rewording a
    // sentence must not change what the DM was told about the rules that matter.
    hash: createHash('sha256').update(JSON.stringify(data ?? body)).digest('hex').slice(0, 12),
  };
}

/** Deterministic retrieval: union of the tags, sorted by id. No embeddings, no surprise. */
export function retrieve(rules, tags) {
  const want = new Set(tags);
  const hits = rules.sections.filter((s) => s.tags.some((t) => want.has(t)));
  hits.sort((a, b) => (a.id < b.id ? -1 : 1));
  return hits;
}

/** The DM-facing rendering of retrieved sections: id + hash header so the log and the prompt agree. */
export function renderForPrompt(sections) {
  return sections
    .map((s) => `<rule id="${s.id}" hash="${s.hash}">\n${s.body}\n</rule>`)
    .join('\n\n');
}

export function loadRules(path = process.env.DB_RULES || 'rules/rules.md') {
  const rules = parseRules(readFileSync(path, 'utf8'));
  // Fail closed at startup: a missing canonical block means a silently unenforceable rule.
  const noData = rules.sections.filter((s) => s.data === null);
  if (noData.length) {
    throw new Error(`rules.md sections without canonical json: ${noData.map((s) => s.id).join(', ')}`);
  }
  return rules;
}
