import { z } from 'zod';

export const documentKinds = ['guide', 'faq', 'runbook', 'model'] as const;
export const capabilityKeys = ['streaming', 'tools', 'vision', 'json', 'reasoning', 'caching'] as const;
const state = z.enum(['supported', 'unsupported', 'unknown']);
const compatibility = z.object({
  model: z.string().trim().min(1).max(160),
  protocol: z.enum(['chat_completions', 'responses', 'anthropic_messages', 'gemini_generate']),
  engineVersion: z.string().trim().max(120),
  capabilities: z.object({ streaming: state, tools: state, vision: state, json: state, reasoning: state, caching: state }).strict(),
  testedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v && v <= new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)).nullable(),
  evidence: z.string().trim().max(2000),
}).strict().superRefine((value, ctx) => {
  if (Object.values(value.capabilities).some(s => s !== 'unknown') && (!value.testedOn || value.evidence.length < 10 || !value.engineVersion)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '能力结论需填写验证日期、引擎版本和验证依据；未验证的能力请选择未知' });
  }
});
export const documentContentSchema = z.object({
  kind: z.enum(documentKinds), title: z.string().trim().min(3).max(160), summary: z.string().trim().min(5).max(500),
  body: z.string().trim().min(10).max(20000), category: z.string().trim().max(60),
  compatibility: compatibility.nullable(),
}).strict().refine(v => (v.kind === 'model') === (v.compatibility !== null), '只有模型说明需要模型能力记录');
export type DocumentContent = z.infer<typeof documentContentSchema>;

export function compatibilityFreshness(content: DocumentContent, now = Date.now()): 'unverified' | 'recorded' | 'review_due' | null {
  const record = content.compatibility;
  if (!record) return null;
  if (!record.testedOn || Object.values(record.capabilities).every(v => v === 'unknown')) return 'unverified';
  return now - Date.parse(record.testedOn + 'T00:00:00+08:00') > 30 * 86400000 ? 'review_due' : 'recorded';
}
