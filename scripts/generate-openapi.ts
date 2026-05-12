/**
 * scripts/generate-openapi.ts
 *
 * Compiles `src/routes/_openapi-meta.ts` into `docs/openapi.yaml`
 * (OpenAPI 3.0). Run via:
 *
 *   npx ts-node scripts/generate-openapi.ts
 *   # or after `npx tsc`:
 *   node dist/scripts/generate-openapi.js
 *
 * The output is committed so static-export builds and curl users can read
 * it without running the panel.
 *
 * Why not auto-discover Express routes at runtime?
 *   Express has no schema reflection. Maintaining a single hand-written
 *   table in _openapi-meta.ts is simpler, reviewable in PR diffs, and
 *   keeps request / response examples in one place.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ENDPOINTS,
  OPENAPI_INFO,
  SERVERS,
  TAG_DESCRIPTIONS,
  ApiEndpoint,
} from '../src/routes/_openapi-meta';

type YamlPrimitive = string | number | boolean | null;
type YamlValue = YamlPrimitive | YamlValue[] | { [k: string]: YamlValue };

function yamlEscape(s: string): string {
  // Block scalar if multiline; otherwise double-quote when special chars
  // present.
  if (s.includes('\n')) {
    const indent = '    ';
    const lines = s.split('\n');
    return '|\n' + lines.map((l) => indent + l).join('\n');
  }
  // Always quote — covers colons, leading dashes, special-looking values.
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function dumpYaml(value: YamlValue, indent: number = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return yamlEscape(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((v) => {
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          // Inline first key on the dash line.
          const sub = dumpYaml(v, indent + 1);
          // Replace first occurrence of `\n  ` style indent with dash-aligned text.
          const lines = sub.split('\n');
          const first = lines[0].trimStart();
          const rest = lines.slice(1).join('\n');
          return pad + '- ' + first + (rest ? '\n' + rest : '');
        }
        return pad + '- ' + dumpYaml(v, indent + 1);
      })
      .join('\n');
  }
  // Object
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  return keys
    .map((k) => {
      const v = (value as any)[k];
      // Quote numeric-looking keys so YAML doesn't read them as ints
      // (OpenAPI requires response-code keys to be strings).
      const keyOut = /^\d+$/.test(k) ? '"' + k + '"' : k;
      if (
        v !== null &&
        typeof v === 'object' &&
        ((Array.isArray(v) && v.length > 0) || (!Array.isArray(v) && Object.keys(v).length > 0))
      ) {
        return pad + keyOut + ':\n' + dumpYaml(v, indent + 1);
      }
      return pad + keyOut + ': ' + dumpYaml(v, indent + 1);
    })
    .join('\n');
}

function pathItem(eps: ApiEndpoint[]): Record<string, any> {
  const item: Record<string, any> = {};
  for (const ep of eps) {
    const op: any = {
      summary: ep.summary,
      tags: ep.tags,
      responses: {},
    };
    if (ep.description) op.description = ep.description;
    if (ep.auth !== 'none') {
      const scheme =
        ep.auth === 'api_key'
          ? 'apiKey'
          : ep.auth === 'bearer_admin'
          ? 'adminBearer'
          : ep.auth === 'bearer_customer'
          ? 'customerBearer'
          : 'platformToken';
      op.security = [{ [scheme]: [] }];
    }
    if (ep.requestBody) {
      op.requestBody = {
        required: ep.requestBody.required ?? true,
        content: {
          'application/json': {
            example: ep.requestBody.example ?? {},
          },
        },
      };
    }
    for (const [code, r] of Object.entries(ep.responses)) {
      op.responses[code] = {
        description: r.description,
        ...(r.example !== undefined && {
          content: { 'application/json': { example: r.example } },
        }),
      };
    }
    item[ep.method.toLowerCase()] = op;
  }
  return item;
}

function build(): string {
  // Group endpoints by path.
  const byPath = new Map<string, ApiEndpoint[]>();
  for (const ep of ENDPOINTS) {
    const arr = byPath.get(ep.path) || [];
    arr.push(ep);
    byPath.set(ep.path, arr);
  }
  const paths: Record<string, any> = {};
  for (const [p, eps] of byPath.entries()) {
    paths[p] = pathItem(eps);
  }

  const tags = Object.entries(TAG_DESCRIPTIONS).map(([name, description]) => ({
    name,
    description,
  }));

  const doc = {
    openapi: '3.0.3',
    info: OPENAPI_INFO,
    servers: SERVERS,
    tags,
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'sk-...' },
        adminBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        customerBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        platformToken: { type: 'apiKey', in: 'header', name: 'X-Platform-Token' },
      },
    },
    paths,
  };

  return '# Auto-generated — DO NOT EDIT.\n# Edit src/routes/_openapi-meta.ts then run scripts/generate-openapi.ts.\n' + dumpYaml(doc as any) + '\n';
}

function main(): void {
  const out = path.resolve(__dirname, '../docs/openapi.yaml');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, build(), 'utf8');
  const eps = ENDPOINTS.length;
  // eslint-disable-next-line no-console
  console.log(`openapi:generated endpoints=${eps} file=${out}`);
}

if (require.main === module) main();
