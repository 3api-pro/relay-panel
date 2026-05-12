/**
 * Public OpenAPI serving route.
 *
 *   GET /openapi.yaml      — committed at docs/openapi.yaml
 *   GET /openapi.json      — same spec, JSON encoding (built once, cached)
 *
 * No auth — the spec is documentation, not data. swagger-ui-react and
 * curl users both hit this.
 */
import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import { logger } from '../services/logger';

export const openapiRouter = Router();

const YAML_FILE = path.resolve(__dirname, '../../docs/openapi.yaml');

let cachedJson: string | null = null;

function loadYaml(): string | null {
  try {
    return fs.readFileSync(YAML_FILE, 'utf8');
  } catch (err: any) {
    logger.warn({ err: err.message, file: YAML_FILE }, 'openapi:yaml:missing');
    return null;
  }
}

openapiRouter.get('/openapi.yaml', (_req: Request, res: Response) => {
  const text = loadYaml();
  if (!text) {
    res.status(404).type('text/plain').send('openapi.yaml not generated — run scripts/generate-openapi.ts');
    return;
  }
  res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(text);
});

openapiRouter.get('/openapi.json', (_req: Request, res: Response) => {
  if (cachedJson) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(cachedJson);
    return;
  }
  const yaml = loadYaml();
  if (!yaml) {
    res.status(404).json({ error: { type: 'not_found', message: 'openapi.yaml not generated' } });
    return;
  }
  // Tiny YAML -> JSON conversion good enough for the spec we emit (we own
  // the writer, so we never produce anchors / merge keys / multi-doc).
  try {
    const obj = miniYamlParse(yaml);
    cachedJson = JSON.stringify(obj, null, 2);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(cachedJson);
  } catch (err: any) {
    logger.warn({ err: err.message }, 'openapi:json:parse:fail');
    res.status(500).json({ error: { type: 'internal_error', message: 'unable to convert YAML to JSON' } });
  }
});

// ---------------------------------------------------------------------
// Mini YAML parser sized to our generator output.
//
// Supported:
//   - 2-space indent
//   - `key: value` and `key:` (object) and `key: []` and `key: {}`
//   - block scalar `key: |`
//   - sequences `- value` and `- key: value`
//   - double-quoted strings with \" escape
//   - numbers / booleans / null
//   - comments starting with `#` (line ignored)
//
// Not supported: anchors, merge keys, flow style, multi-doc.
// ---------------------------------------------------------------------
function miniYamlParse(input: string): any {
  const lines: { indent: number; raw: string }[] = [];
  for (const ln of input.split('\n')) {
    if (ln.trim() === '') continue;
    if (ln.trimStart().startsWith('#')) continue;
    const indent = ln.match(/^( *)/)![1].length;
    lines.push({ indent, raw: ln });
  }

  let pos = 0;

  function parseValue(text: string): any {
    text = text.trim();
    if (text === '') return undefined;
    if (text === 'null' || text === '~') return null;
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === '[]') return [];
    if (text === '{}') return {};
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    if (text.startsWith('"') && text.endsWith('"')) {
      // Unescape \" and \\.
      return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return text;
  }

  function parseBlock(baseIndent: number): any {
    // Decide between object, array, or fall through.
    if (pos >= lines.length) return undefined;
    const first = lines[pos];
    if (first.indent < baseIndent) return undefined;

    // Array if it starts with "- "
    const firstContent = first.raw.slice(first.indent);
    if (firstContent.startsWith('- ')) {
      const out: any[] = [];
      while (pos < lines.length && lines[pos].indent === baseIndent && lines[pos].raw.slice(baseIndent).startsWith('- ')) {
        const ln = lines[pos];
        const after = ln.raw.slice(baseIndent + 2); // skip "- "
        pos++;
        // The item may be "key: value" (inline first key of an object),
        // pure scalar, or start an object whose first key is here.
        const colonIdx = colonSplit(after);
        if (colonIdx >= 0) {
          const key = after.slice(0, colonIdx).trim();
          const rest = after.slice(colonIdx + 1).trim();
          const obj: any = {};
          if (rest === '') {
            obj[key] = parseBlock(baseIndent + 2);
          } else {
            obj[key] = parseValue(rest);
          }
          // Continue parsing object at indent + 2.
          while (pos < lines.length && lines[pos].indent === baseIndent + 2 && !lines[pos].raw.slice(baseIndent + 2).startsWith('- ')) {
            const kv = lines[pos];
            const content2 = kv.raw.slice(baseIndent + 2);
            const ci2 = colonSplit(content2);
            if (ci2 < 0) {
              pos++;
              continue;
            }
            const k2 = content2.slice(0, ci2).trim();
            const v2 = content2.slice(ci2 + 1).trim();
            pos++;
            if (v2 === '') {
              obj[k2] = parseBlock(baseIndent + 4);
            } else if (v2 === '|') {
              obj[k2] = consumeBlockScalar(baseIndent + 4);
            } else {
              obj[k2] = parseValue(v2);
            }
          }
          out.push(obj);
        } else {
          out.push(parseValue(after));
        }
      }
      return out;
    }

    // Object
    const obj: any = {};
    while (pos < lines.length && lines[pos].indent === baseIndent) {
      const ln = lines[pos];
      const content = ln.raw.slice(baseIndent);
      const ci = colonSplit(content);
      if (ci < 0) { pos++; continue; }
      const key = content.slice(0, ci).trim();
      const rest = content.slice(ci + 1).trim();
      pos++;
      if (rest === '') {
        obj[key] = parseBlock(baseIndent + 2);
      } else if (rest === '|') {
        obj[key] = consumeBlockScalar(baseIndent + 2);
      } else {
        obj[key] = parseValue(rest);
      }
    }
    return obj;
  }

  function consumeBlockScalar(indent: number): string {
    const buf: string[] = [];
    while (pos < lines.length && lines[pos].indent >= indent) {
      buf.push(lines[pos].raw.slice(indent));
      pos++;
    }
    return buf.join('\n');
  }

  function colonSplit(s: string): number {
    // First colon that's followed by space or end-of-string. Skips colons
    // inside double-quoted keys (we never emit those, so a simple scan
    // suffices).
    let inQuote = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') inQuote = !inQuote;
      if (c === ':' && !inQuote) {
        if (i === s.length - 1 || s[i + 1] === ' ') return i;
      }
    }
    return -1;
  }

  return parseBlock(0);
}
