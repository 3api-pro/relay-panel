export const capabilityKeys = ['streaming', 'tools', 'vision', 'json', 'reasoning', 'caching'] as const;
export type Capability = typeof capabilityKeys[number];
export interface KnowledgeContent {
  kind: 'guide' | 'faq' | 'runbook' | 'model'; title: string; summary: string; body: string; category: string;
  compatibility: {
    model: string; protocol: string; engineVersion: string; testedOn: string | null; evidence: string;
    capabilities: Record<Capability, 'supported' | 'unsupported' | 'unknown'>;
  } | null;
}
export const blankContent = (): KnowledgeContent => ({ kind: 'guide', title: '', summary: '', body: '', category: '', compatibility: null });
export const blankCompatibility = (): NonNullable<KnowledgeContent['compatibility']> => ({ model: '', protocol: 'chat_completions', engineVersion: '', testedOn: null, evidence: '', capabilities: { streaming: 'unknown', tools: 'unknown', vision: 'unknown', json: 'unknown', reasoning: 'unknown', caching: 'unknown' } });
export const contentLabels: Record<string, [string, string]> = {
  guide: ['接入指南', 'Setup guide'], faq: ['常见问题', 'FAQ'], runbook: ['操作手册', 'Runbook'], model: ['模型兼容性', 'Model compatibility'],
  streaming: ['流式输出', 'Streaming'], tools: ['工具调用', 'Tool calling'], vision: ['图像输入', 'Image input'], json: ['结构化输出', 'Structured output'], reasoning: ['推理参数', 'Reasoning parameters'], caching: ['提示缓存', 'Prompt caching'],
  supported: ['支持（站长记录）', 'Supported (owner record)'], unsupported: ['不支持（站长记录）', 'Unsupported (owner record)'], unknown: ['未验证', 'Unverified'],
  created: ['创建草稿', 'Draft created'], save: ['保存草稿', 'Draft saved'], publish: ['发布', 'Published'], unpublish: ['撤回', 'Unpublished'], restore: ['恢复到草稿', 'Restored to draft'],
};
