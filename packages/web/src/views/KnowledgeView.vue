<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { get, post } from '../api/client';
import { session } from '../api/session';
import { Button, Card, Field, Input, Select, EmptyState } from '../components/ui';
import ContentPreview from '../components/knowledge/ContentPreview.vue';
import { blankContent, blankCompatibility, capabilityKeys, contentLabels, type KnowledgeContent } from '../components/knowledge/content';
interface Site { id: number; label: string; engine: string }
interface Space { siteId: number; token: string; title: string; description: string; published: boolean; version: number }
interface Entry { id: number; title: string; token: string; kind: string; category: string; version: number; publishedRevision: number | null }
interface Document { id: number; token: string; draft: KnowledgeContent; published: KnowledgeContent | null; version: number; publishedRevision: number | null; publishedAt: string | null }
interface Revision { version: number; action: string; content: KnowledgeContent; createdAt: string }
const base = '/api/services/knowledge', route = useRoute(), { locale } = useI18n();
const l = (zh: string, en: string) => locale.value.startsWith('zh') ? zh : en;
const label = (key: string) => contentLabels[key] ? l(...contentLabels[key]) : key;
const options = (keys: string[]) => keys.map(value => ({ value, label: label(value) }));
const sites = ref<Site[]>([]), siteId = ref<string | number | null>(null), busy = ref(false), error = ref(''), notice = ref('');
const space = ref<Space | null>(null), canPublish = ref(false), spaceTitle = ref(''), spaceDescription = ref(''), spacePreview = ref(false);
const items = ref<Entry[]>([]), hasMore = ref(false), query = ref(''), kind = ref<string | number | null>('all'), tab = ref('articles');
const selected = ref<Document | null>(null), content = ref<KnowledgeContent>(blankContent()), editing = ref(false), view = ref('edit');
const history = ref<Revision[]>([]), moreHistory = ref(false), chosenHistory = ref<Revision | null>(null);
const dirty = computed(() => JSON.stringify(content.value) !== JSON.stringify(selected.value?.draft ?? blankContent()));
const changedSincePublication = computed(() => selected.value && JSON.stringify(selected.value.draft) !== JSON.stringify(selected.value.published));
const helpUrl = computed(() => space.value ? `${window.location.origin}/public/help/${space.value.token}` : '');
const articleUrl = computed(() => selected.value && helpUrl.value ? `${helpUrl.value}/${selected.value.token}` : '');
const textArea = 'min-h-28 w-full rounded-lg border border-border bg-bg/60 p-3 text-sm leading-6 focus:border-accent focus:outline-none disabled:opacity-60';
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
async function action(fn: () => Promise<void>) { if (busy.value) return; busy.value = true; error.value = ''; notice.value = ''; try { await fn(); } catch (e) { error.value = String(e); } finally { busy.value = false; } }
function resetEditor() { selected.value = null; content.value = blankContent(); editing.value = false; history.value = []; chosenHistory.value = null; view.value = 'edit'; }
function discard() { return !dirty.value || window.confirm(l('有未保存的修改，是否放弃？', 'Discard unsaved changes?')); }
async function list(append = false) {
  const params = new URLSearchParams({ siteId: String(siteId.value), q: query.value });
  if (kind.value && kind.value !== 'all') params.set('kind', String(kind.value));
  if (append && items.value.length) params.set('beforeId', String(items.value.at(-1)!.id));
  const r = await get<{ items: Entry[]; hasMore: boolean }>(`${base}/documents?${params}`);
  items.value = append ? [...items.value, ...r.items] : r.items; hasMore.value = r.hasMore;
}
async function load() {
  if (!siteId.value) return;
  const r = await get<{ item: Space | null; canPublish: boolean }>(`${base}/space?siteId=${siteId.value}`);
  space.value = r.item; canPublish.value = r.canPublish; spaceTitle.value = r.item?.title ?? ''; spaceDescription.value = r.item?.description ?? ''; spacePreview.value = false;
  await list();
}
async function chooseSite(value: string | number | null) { if (busy.value || !discard()) return; siteId.value = value; resetEditor(); items.value = []; space.value = null; query.value = ''; kind.value = 'all'; await action(load); }
onMounted(() => void action(async () => { const r = await get<{ sites: Site[] }>('/api/services/catalog'); sites.value = r.sites; siteId.value = r.sites.find(s => String(s.id) === route.query.site)?.id ?? r.sites[0]?.id ?? null; await load(); }));
watch(() => content.value.kind, value => { if (value === 'model') content.value.compatibility ??= blankCompatibility(); else content.value.compatibility = null; });
watch(content, () => { if (view.value === 'preview') view.value = 'edit'; }, { deep: true });
watch([spaceTitle, spaceDescription], () => { spacePreview.value = false; });
async function open(entry: Entry) { if (!discard()) return; await action(async () => { const r = await get<{ item: Document }>(`${base}/documents/${entry.id}`); selected.value = r.item; content.value = clone(r.item.draft); editing.value = true; view.value = 'edit'; chosenHistory.value = null; history.value = []; }); }
function create() { if (!discard()) return; resetEditor(); editing.value = true; }
async function save() { await action(async () => {
  const r = selected.value ? await post<{ item: Document }>(`${base}/documents/${selected.value.id}`, { action: 'save', version: selected.value.version, content: content.value })
    : await post<{ item: Document }>(`${base}/documents`, { siteId: Number(siteId.value), content: content.value });
  selected.value = r.item; content.value = clone(r.item.draft); await list(); notice.value = l('草稿已保存，客户页面尚未更新。', 'Draft saved. The customer page has not changed.');
}); }
async function publish(actionName: 'publish' | 'unpublish') { if (!selected.value) return; await action(async () => {
  const r = await post<{ item: Document }>(`${base}/documents/${selected.value!.id}`, { action: actionName, version: selected.value!.version });
  selected.value = r.item; content.value = clone(r.item.draft); view.value = 'edit'; await list(); notice.value = actionName === 'publish' ? l('内容已发布。客户帮助页启用后可访问。', 'Published. Accessible while the customer help page is enabled.') : l('内容已撤回，历史记录保留。', 'Unpublished. History is retained.');
}); }
async function showHistory(append = false) { if (!selected.value) return; await action(async () => {
  const before = append && history.value.length ? `?beforeVersion=${history.value.at(-1)!.version}` : '';
  const r = await get<{ items: Revision[]; hasMore: boolean }>(`${base}/documents/${selected.value!.id}/history${before}`);
  history.value = append ? [...history.value, ...r.items] : r.items; moreHistory.value = r.hasMore; chosenHistory.value = null; view.value = 'history';
}); }
async function restore() { if (!selected.value || !chosenHistory.value || !discard()) return; await action(async () => {
  const r = await post<{ item: Document }>(`${base}/documents/${selected.value!.id}`, { action: 'restore', version: selected.value!.version, sourceVersion: chosenHistory.value!.version });
  selected.value = r.item; content.value = clone(r.item.draft); view.value = 'edit'; chosenHistory.value = null; await list(); notice.value = l('历史内容已恢复为新草稿，需重新预览发布。', 'Restored as a new draft. Preview and publish to update customers.');
}); }
async function saveSpace(published: boolean) { await action(async () => {
  const r = await post<{ item: Space }>(`${base}/space`, { siteId: Number(siteId.value), version: space.value?.version ?? 0, title: published ? spaceTitle.value : space.value?.title ?? spaceTitle.value, description: published ? spaceDescription.value : space.value?.description ?? spaceDescription.value, published });
  space.value = r.item; spacePreview.value = false; notice.value = published ? l('客户帮助页已启用。', 'Customer help page enabled.') : l('客户帮助页已停用，所有文章公开链接均不可访问。', 'Customer help page disabled. All public article links are unavailable.');
}); }
async function copy(value: string) { await action(async () => { await navigator.clipboard.writeText(value); notice.value = l('链接已复制。', 'Link copied.'); }); }
</script>
<template>
  <div class="rp-page space-y-5">
    <div><p class="text-xs uppercase tracking-widest text-accent">CUSTOMER KNOWLEDGE</p><h1 class="mt-1 text-xl font-semibold">{{ l('客户知识库', 'Customer knowledge') }}</h1><p class="mt-2 max-w-3xl text-sm leading-6 text-muted">{{ l('整理接入指南、常见问题与模型能力，预览后发布给客户。草稿与已发布内容独立保存。', 'Maintain setup guides, FAQs and model capabilities. Preview before publishing; drafts stay separate from published content.') }}</p></div>
    <p v-if="error" role="alert" class="rounded border border-red/30 bg-red/10 p-3 text-sm text-red">{{ error }}</p><p v-if="notice" role="status" class="text-sm text-accent">{{ notice }}</p>
    <EmptyState v-if="!sites.length && !busy" :title="l('先接入一个站点', 'Connect a site to begin')" />
    <template v-if="sites.length">
      <Field :label="l('当前站点', 'Current site')"><Select :model-value="siteId" :disabled="busy" :options="sites.map(s => ({ value: s.id, label: s.label + ' · ' + s.engine }))" @update:model-value="chooseSite" /></Field>
      <nav class="flex flex-wrap gap-2" :aria-label="l('知识库模块', 'Knowledge sections')"><Button :variant="tab === 'articles' ? 'primary' : 'outline'" @click="tab = 'articles'">{{ l('内容与模型说明', 'Articles and models') }}</Button><Button :variant="tab === 'space' ? 'primary' : 'outline'" @click="tab = 'space'">{{ l('客户帮助页', 'Customer help page') }}</Button></nav>
      <div v-if="tab === 'articles'" class="grid items-start gap-5 xl:grid-cols-[minmax(260px,1fr)_minmax(0,2fr)]">
        <Card class="min-w-0 [&>div]:space-y-4">
          <form class="space-y-3" @submit.prevent="action(() => list())"><Field :label="l('搜索标题、摘要或分类', 'Search title, summary or category')"><Input v-model="query" maxlength="100" /></Field><Field :label="l('内容类型筛选', 'Filter by type')"><Select v-model="kind" :options="[{ value: 'all', label: l('全部类型', 'All types') }, ...options(['guide', 'faq', 'runbook', 'model'])]" /></Field><div class="flex gap-2"><Button type="submit" variant="outline" :disabled="busy">{{ l('搜索', 'Search') }}</Button><Button v-if="session.canWrite.value" :disabled="busy" @click="create">{{ l('新建内容', 'New article') }}</Button></div></form>
          <p v-if="!items.length && !busy" class="text-sm text-muted">{{ l('暂无匹配内容。', 'No matching content.') }}</p>
          <button v-for="entry in items" :key="entry.id" :disabled="busy" class="block w-full rounded-lg border border-border p-3 text-left hover:border-accent disabled:opacity-50" :class="selected?.id === entry.id ? 'border-accent bg-accent/5' : ''" @click="open(entry)"><span class="block break-words text-sm font-medium">{{ entry.title }}</span><span class="mt-1 block text-xs text-muted">{{ label(entry.kind) }} · {{ entry.publishedRevision ? l('已有发布版', 'Published version available') : l('草稿', 'Draft') }}</span></button>
          <Button v-if="hasMore" variant="outline" :disabled="busy" @click="action(() => list(true))">{{ l('更多内容', 'More articles') }}</Button>
        </Card>
        <Card v-if="editing" class="min-w-0 [&>div]:space-y-4">
          <div class="flex flex-wrap items-center gap-2"><Button :variant="view === 'edit' ? 'primary' : 'outline'" @click="view = 'edit'">{{ l('编辑', 'Edit') }}</Button><Button :variant="view === 'preview' ? 'primary' : 'outline'" @click="view = 'preview'">{{ l('预览客户可见内容', 'Preview customer content') }}</Button><Button v-if="selected" :variant="view === 'history' ? 'primary' : 'outline'" :disabled="busy" @click="showHistory()">{{ l('版本历史', 'Version history') }}</Button></div>
          <p v-if="selected" class="text-xs text-muted">{{ l('当前版本', 'Current version') }} {{ selected.version }} · {{ selected.published ? changedSincePublication ? l('草稿有未发布修改', 'Unpublished draft changes') : l('与发布版一致', 'Matches published content') : l('未公开发布', 'Not published') }}</p>
          <form v-if="view === 'edit'" class="space-y-4" @submit.prevent="save">
            <fieldset :disabled="!session.canWrite.value || busy" class="min-w-0 [&>div]:space-y-4">
              <div class="grid gap-3 sm:grid-cols-2"><Field :label="l('内容类型', 'Content type')"><Select v-model="content.kind" :options="options(['guide', 'faq', 'runbook', 'model'])" /></Field><Field :label="l('分类', 'Category')"><Input v-model="content.category" maxlength="60" /></Field></div>
              <Field :label="l('标题', 'Title')" required><Input v-model="content.title" minlength="3" maxlength="160" required /></Field>
              <Field :label="l('摘要', 'Summary')" required><textarea v-model="content.summary" :class="textArea" minlength="5" maxlength="500" required /></Field>
              <Field :label="l('正文', 'Body')" :hint="l('按纯文本显示，保留换行和配置示例；请勿填写密钥或客户隐私。', 'Plain text with line breaks and configuration examples. Exclude keys and customer private data.')" required><textarea v-model="content.body" :class="textArea" style="min-height:220px" minlength="10" maxlength="20000" required /></Field>
              <template v-if="content.compatibility">
                <div class="grid gap-3 sm:grid-cols-2"><Field :label="l('模型名称', 'Model name')" required><Input v-model="content.compatibility.model" maxlength="160" required /></Field><Field :label="l('接入协议', 'API protocol')"><Select v-model="content.compatibility.protocol" :options="['chat_completions', 'responses', 'anthropic_messages', 'gemini_generate'].map(value => ({ value, label: value }))" /></Field></div>
                <p class="text-xs leading-6 text-muted">{{ l('支持或不支持的结论必须有验证日期、引擎版本和依据；没有验证就保留“未验证”。', 'Supported or unsupported claims require a verification date, engine version and evidence. Keep untested capabilities unverified.') }}</p>
                <div class="grid gap-3 sm:grid-cols-2"><Field v-for="capability in capabilityKeys" :key="capability" :label="label(capability)"><Select v-model="content.compatibility.capabilities[capability]" :options="options(['unknown', 'supported', 'unsupported'])" /></Field></div>
                <div class="grid gap-3 sm:grid-cols-2"><Field :label="l('验证日期', 'Verification date')"><input :value="content.compatibility.testedOn ?? ''" @input="content.compatibility.testedOn = ($event.target as HTMLInputElement).value || null" type="date" class="h-9 w-full rounded border border-border bg-bg/60 px-3 text-sm" /></Field><Field :label="l('验证时引擎版本', 'Tested engine version')"><Input v-model="content.compatibility.engineVersion" maxlength="120" /></Field></div>
                <Field :label="l('验证依据与限制', 'Evidence and limitations')" :hint="l('公开可见：记录验证场景、客户端版本和结果，避免内部日志或密钥。', 'Public content: record the scenario, client version and result; exclude private logs and keys.')"><textarea v-model="content.compatibility.evidence" :class="textArea" maxlength="2000" /></Field>
              </template>
              <Button v-if="session.canWrite.value" type="submit" :loading="busy">{{ l('保存草稿', 'Save draft') }}</Button>
            </fieldset>
          </form>
          <template v-else-if="view === 'preview'">
            <ContentPreview :content="content" />
            <p v-if="dirty || !selected" class="text-sm text-muted">{{ l('请先保存草稿，再确认发布此版本。', 'Save the draft before publishing this version.') }}</p>
            <Button v-if="canPublish" :disabled="busy || dirty || !selected" @click="publish('publish')">{{ l('确认发布以上内容', 'Publish the previewed content') }}</Button>
            <p v-else class="text-xs text-muted">{{ l('公开发布由站点所有者或管理员完成。', 'The site owner or administrator publishes content.') }}</p>
          </template>
          <template v-else>
            <div class="flex flex-wrap gap-2"><Button v-for="revision in history" :key="revision.version" variant="outline" size="sm" @click="chosenHistory = revision">v{{ revision.version }} · {{ label(revision.action) }}</Button><Button v-if="moreHistory" :disabled="busy" variant="outline" size="sm" @click="showHistory(true)">{{ l('更早版本', 'Older versions') }}</Button></div>
            <template v-if="chosenHistory"><p class="text-xs text-muted">v{{ chosenHistory.version }} · {{ chosenHistory.createdAt }} UTC</p><ContentPreview :content="chosenHistory.content" /><Button v-if="session.canWrite.value" :disabled="busy" @click="restore">{{ l('将此版本恢复为草稿', 'Restore this version as a draft') }}</Button></template>
            <p v-else class="text-sm text-muted">{{ l('选择版本查看完整内容；恢复操作不会直接修改客户页面。', 'Select a version to inspect it. Restoring does not change the customer page.') }}</p>
          </template>
          <div v-if="selected?.published" class="space-y-2 border-t border-border pt-4"><p class="text-xs text-muted">{{ space?.published ? l('客户帮助页已启用', 'Customer help page enabled') : l('客户帮助页尚未启用，公开链接不可访问', 'Customer help page is disabled; public links are unavailable') }}</p><div class="flex flex-wrap gap-2"><a v-if="space?.published" :href="articleUrl" target="_blank" rel="noopener noreferrer" class="text-sm text-accent">{{ l('查看已发布页面', 'Open published page') }} ↗</a><Button v-if="space?.published" size="sm" variant="outline" :disabled="busy" @click="copy(articleUrl)">{{ l('复制文章链接', 'Copy article link') }}</Button><Button v-if="canPublish" size="sm" variant="outline" :disabled="busy || dirty" @click="publish('unpublish')">{{ l('撤回此内容', 'Unpublish article') }}</Button></div></div>
        </Card>
        <EmptyState v-else :title="l('选择或新建一篇内容', 'Select or create an article')" :description="l('团队编辑者整理草稿，站点所有者审核后公开。', 'Team editors prepare drafts; the site owner reviews and publishes.')" />
      </div>
      <Card v-else class="max-w-3xl [&>div]:space-y-4">
        <p class="text-sm leading-6 text-muted">{{ l('启用后，任何获得链接的人都能阅读已发布文章。停用会同时关闭帮助页及所有文章链接；草稿与历史始终不公开。', 'When enabled, anyone with the link can read published articles. Disabling closes the help page and all article links. Drafts and history remain private.') }}</p>
        <fieldset :disabled="busy || !canPublish" class="space-y-4"><Field :label="l('帮助页标题', 'Help page title')" required><Input v-model="spaceTitle" minlength="3" maxlength="160" /></Field><Field :label="l('帮助页简介', 'Help page introduction')"><textarea v-model="spaceDescription" :class="textArea" maxlength="1000" /></Field><Button v-if="canPublish" variant="outline" @click="spacePreview = true">{{ l('预览帮助页信息', 'Preview help page information') }}</Button></fieldset>
        <div v-if="spacePreview" class="space-y-3 rounded border border-border p-4"><h2 class="break-words text-lg font-semibold">{{ spaceTitle }}</h2><p class="whitespace-pre-wrap break-words text-sm">{{ spaceDescription }}</p><p class="text-xs text-muted">{{ l('页面只列出已经单独发布的文章。', 'Only individually published articles are listed.') }}</p><Button :disabled="busy" @click="saveSpace(true)">{{ l('确认启用客户帮助页', 'Enable customer help page') }}</Button></div>
        <div v-if="space?.published" class="flex flex-wrap items-center gap-3"><a :href="helpUrl" target="_blank" rel="noopener noreferrer" class="text-sm text-accent">{{ l('打开客户帮助页', 'Open customer help page') }} ↗</a><Button variant="outline" size="sm" :disabled="busy" @click="copy(helpUrl)">{{ l('复制帮助页链接', 'Copy help page link') }}</Button><Button v-if="canPublish" variant="outline" size="sm" :disabled="busy" @click="saveSpace(false)">{{ l('停用所有公开页面', 'Disable all public pages') }}</Button></div>
        <p v-else class="text-sm text-muted">{{ l('帮助页尚未启用。', 'Customer help page is disabled.') }}</p>
      </Card>
    </template>
  </div>
</template>
