import { describe, expect, it } from 'vitest';
import { buildChannelSpec } from '../src/marketplace/grant.js';
import type { ChannelTemplate } from '../src/marketplace/types.js';

const byoTpl: ChannelTemplate = {
  key: 'k',
  title: 'Claude BYO',
  protocol: 'anthropic',
  models: ['claude-sonnet-4'],
  modelMapping: { 'claude-sonnet-4': 'claude-sonnet-4-20250101' },
  source: 'byo',
};

const managedTpl: ChannelTemplate = {
  key: 'm',
  title: 'Managed',
  protocol: 'openai',
  models: ['gpt-4o'],
  source: 'managed',
};

describe('buildChannelSpec', () => {
  it('builds spec from byo template + input', () => {
    const spec = buildChannelSpec(byoTpl, {
      siteSlug: 's',
      templateKey: 'k',
      byo: { baseUrl: 'https://up.example', apiKey: 'sk-x' },
      groupIds: ['3'],
      priority: 5,
    });
    expect(spec).toMatchObject({
      name: 'Claude BYO',
      protocol: 'anthropic',
      baseUrl: 'https://up.example',
      apiKey: 'sk-x',
      models: ['claude-sonnet-4'],
      modelMapping: { 'claude-sonnet-4': 'claude-sonnet-4-20250101' },
      groups: ['3'],
      priority: 5,
    });
  });

  it('honors channelName override', () => {
    const spec = buildChannelSpec(byoTpl, {
      siteSlug: 's',
      templateKey: 'k',
      channelName: 'my-claude',
      byo: { baseUrl: 'https://up.example', apiKey: 'sk-x' },
    });
    expect(spec.name).toBe('my-claude');
  });

  it('rejects byo template without credentials', () => {
    expect(() => buildChannelSpec(byoTpl, { siteSlug: 's', templateKey: 'k' })).toThrow(/byo/);
  });

  it('rejects managed template (gateway not wired)', () => {
    expect(() =>
      buildChannelSpec(managedTpl, { siteSlug: 's', templateKey: 'm' }),
    ).toThrow(/metering gateway/);
  });
});
