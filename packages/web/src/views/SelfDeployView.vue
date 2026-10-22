<script setup lang="ts">
import { computed, inject, onMounted, ref, watch } from 'vue';
import type { ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { get, post } from '../api/client';
import { session } from '../api/session';
import { Button, Card, Field, Input, Select } from '../components/ui';
const { locale, t } = useI18n();
const l = (zh: string, en: string): string => locale.value.startsWith('zh') ? zh : en;
const router = useRouter();
const canWrite = inject<ComputedRef<boolean>>('canWrite', computed(() => false));
interface Environment { enabled: boolean; ready: boolean; dockerVersion?: string; composeVersion?: string; cpuCount?: number; memoryBytes?: number; diskFreeBytes?: number; sitesRoot?: string; checks: { key: string; ok: boolean; detail: string }[] }
const environment = ref<Environment | null>(null), mode = ref(''), enabled = ref(false), loading = ref(true), busy = ref(false), error = ref('');
const engine = ref<string | number | null>('sub2api'), version = ref<string | number | null>(''), customVersion = ref(''), label = ref(''), email = ref(session.state.user?.email ?? '');
const versions = ref<{ sub2api: string[]; newapi: string[] }>({ sub2api: [], newapi: [] });
const managed = ref<{ slug: string; label: string; engine: string; version: string; status: string; managed: string }[]>([]);
const options = computed(() => [...(engine.value === 'newapi' ? versions.value.newapi : versions.value.sub2api).filter(v => v !== 'latest').map(v => ({ value: v, label: v })), { value: '__custom__', label: l('手动填写固定版本','Enter a pinned version') }]);
watch(engine, () => { version.value = options.value[0]?.value ?? '__custom__'; });
async function refreshEnvironment(): Promise<void> {
  loading.value = true; error.value = '';
  try { environment.value = await get('/api/local/environment'); }
  catch (e) { environment.value = null; error.value = String(e); }
  finally { loading.value = false; }
}
onMounted(async () => {
  try {
    const config = await get<{ deploymentMode: string; localProvisionEnabled: boolean }>('/api/auth/config'); mode.value = config.deploymentMode; enabled.value = config.localProvisionEnabled;
    if (enabled.value && canWrite.value) await refreshEnvironment();
    if (mode.value === 'self-hosted') {
      const [v, s] = await Promise.all([get<typeof versions.value>('/api/engines/versions'), get<{ sites: typeof managed.value }>('/api/sites')]);
      versions.value = v; version.value = options.value[0]?.value ?? '__custom__'; managed.value = s.sites.filter(s => s.managed === 'compose' && s.status !== 'destroyed');
    }
  } catch (e) { error.value = String(e); }
  finally { loading.value = false; }
});
async function install(): Promise<void> {
  busy.value = true; error.value = '';
  try { const result = await post<{ slug: string; jobId: number }>('/api/sites', { engine: engine.value, version: version.value === '__custom__' ? customVersion.value.trim() : version.value, label: label.value.trim(), adminEmail: email.value.trim() }); await router.push(`/sites/${result.slug}`); }
  catch (e) { error.value = String(e); }
  finally { busy.value = false; }
}
async function retry(slug: string): Promise<void> {
  busy.value = true; error.value = '';
  try { await post(`/api/sites/${slug}/retry-install`); await router.push(`/sites/${slug}`); }
  catch (e) { error.value = String(e); }
  finally { busy.value = false; }
}
const size = (bytes?: number): string => bytes == null ? '—' : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const checkLabel = (key: string): string => ({ docker: l('Docker 引擎','Docker engine'), local: l('本机连接','Local connection'), compose: l('Compose 版本','Compose version'), storage: l('目录与空间','Directory and storage'), network: l('本机网络','Host networking'), encryption: l('凭据加密','Credential encryption') }[key] ?? key);
const checkHelp = (key: string): string => ({ docker: l('安装并启动 Docker，使用 Linux 容器，允许面板访问 Docker socket。','Start Docker with Linux containers and allow socket access.'), local: l('选择本机 Docker context；不支持远程 Docker 主机。','Select a local Docker context; remote hosts are unsupported.'), compose: l('需要 Docker Compose 2.20 或更新版本。','Docker Compose 2.20 or later is required.'), storage: l('站点目录须可写且至少剩余 2 GiB；Docker 数据卷空间需单独监控。','Site directory must be writable with 2 GiB free; monitor Docker volumes separately.'), network: l('容器部署请使用本机管理 compose 覆盖文件，使面板可访问本机回环端口。','Use the local compose override so the panel can reach host loopback.'), encryption: l('设置 RP_SECRET_KEY，用于加密保存自动生成的管理员凭据。','Set RP_SECRET_KEY to encrypt generated admin credentials.') }[key] ?? '');
</script>
<template>
  <div class="rp-page space-y-5">
    <h1 class="text-lg font-semibold">{{ t('security.selfDeploy') }}</h1>
    <p class="text-sm leading-6 text-muted">{{ l('自部署版可以通过面板在本机安装、管理 Sub2API 和 New API。这里的“本机”是运行面板的自有服务器，不是当前浏览器所在的电脑。我们不提供硬件或服务器租赁。','The self-hosted panel installs and manages Sub2API and New API on the machine running the panel, not the computer running your browser. We do not rent or provide hardware.') }}</p>
    <p v-if="error" role="alert" class="text-sm text-red">{{ error }}</p>
    <Card v-if="mode === 'saas'"><template #title>{{ l('在你自己的机器运行管理面板','Run the panel on your own machine') }}</template><p class="mb-3 text-sm text-muted">{{ l('当前是 SaaS 面板，不会在平台服务器上为用户安装引擎。把自部署版安装到你的机器后，即可使用下方本机安装与环境管理能力；也可以直接接入已有站点。','This is the SaaS panel. Install the self-hosted edition on your machine to use local engine installation and environment management, or connect an existing site here.') }}</p><a href="https://github.com/3api-pro/relay-panel/blob/main/docs/SELF-HOST.md" target="_blank" rel="noopener" class="text-accent">{{ t('security.guide') }} ↗</a></Card>
    <Card v-if="mode === 'self-hosted' && canWrite"><template #title>{{ l('本机环境检查','Local environment checks') }}</template>
      <div class="space-y-3 text-sm"><p v-if="!enabled">{{ l('本机安装已被管理员关闭。可设置 RP_LOCAL_PROVISION_ENABLED=1 后重启面板。','Local installation is disabled. Set RP_LOCAL_PROVISION_ENABLED=1 and restart to enable it.') }}</p>
        <template v-if="environment"><p>Docker {{ environment.dockerVersion ?? '—' }} · Compose {{ environment.composeVersion ?? '—' }}</p><p>CPU {{ environment.cpuCount ?? '—' }} · {{ l('引擎可用内存','Engine memory') }} {{ size(environment.memoryBytes) }} · {{ l('站点目录剩余空间','Site directory free space') }} {{ size(environment.diskFreeBytes) }}</p><p v-if="environment.sitesRoot" class="break-all text-xs text-muted">{{ environment.sitesRoot }}</p><div v-for="c in environment.checks" :key="c.key" class="rounded border border-border p-3"><p :class="c.ok ? 'text-green' : 'text-amber'">{{ c.ok ? '✓' : '!' }} {{ checkLabel(c.key) }}</p><p v-if="!c.ok" class="mt-1 text-xs text-muted">{{ checkHelp(c.key) }}</p></div></template>
        <Button v-if="enabled" variant="outline" :loading="loading" @click="refreshEnvironment">{{ l('重新检查环境','Recheck environment') }}</Button>
      </div>
    </Card>
    <Card v-if="mode === 'self-hosted' && enabled && canWrite"><template #title>{{ l('安装到本机','Install on this machine') }}</template>
      <p class="mb-4 text-sm text-muted">{{ l('选择程序和固定版本，面板自动分配标识与端口、创建独立数据和管理员凭据，并显示安装进度。已有数据会在安装重试时保留。','Choose an engine and pinned version. The panel allocates IDs/ports, initializes isolated data and credentials, and reports progress. Installation retries reuse existing data.') }}</p>
      <form class="grid gap-3 sm:grid-cols-2" @submit.prevent="install"><Field :label="l('程序','Application')"><Select v-model="engine" :options="[{value:'sub2api',label:'Sub2API'},{value:'newapi',label:'New API'}]" /></Field><Field :label="l('固定版本','Pinned version')"><Select v-model="version" :options="options" /></Field><Field v-if="version === '__custom__'" :label="l('镜像版本号','Image tag')"><Input v-model="customVersion" required pattern="[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}" /></Field><Field :label="l('站点名称（备注）','Site name (nickname)')"><Input v-model="label" required maxlength="64" /></Field><Field :label="l('初始管理员邮箱','Initial administrator email')"><Input v-model="email" type="email" required /></Field><Button type="submit" :loading="busy" :disabled="!environment?.ready || loading">{{ l('安装到本机','Install locally') }}</Button></form>
    </Card>
    <Card v-if="mode === 'self-hosted'"><template #title>{{ l('已安装的程序','Installed applications') }}</template><div class="space-y-3"><p v-if="!managed.length" class="text-sm text-muted">{{ l('尚未在本机安装站点。','No locally installed sites yet.') }}</p><div v-for="site in managed" :key="site.slug" class="flex flex-wrap items-center gap-3 rounded border border-border p-3 text-sm"><RouterLink :to="`/sites/${site.slug}`" class="text-accent">{{ site.label }}</RouterLink><span>{{ site.engine }} · {{ site.version }} · {{ site.status }}</span><Button v-if="canWrite && (site.status.startsWith('failed:') || ['pending','provisioning'].includes(site.status))" variant="outline" :loading="busy" @click="retry(site.slug)">{{ l('重试中断的安装','Retry interrupted installation') }}</Button></div><p class="text-xs text-muted">{{ l('进入站点详情管理启停、升级、域名和任务。升级前请先备份；旧镜像回滚不能撤销数据库结构变更。','Open a site to manage lifecycle, upgrades, domains and jobs. Back up before upgrading; reverting an image does not reverse database migrations.') }}</p></div></Card>
    <div class="grid gap-4 md:grid-cols-2"><Card><template #title>{{ t('security.connect') }}</template><p class="mb-4 text-sm text-muted">{{ t('security.connectHint') }}</p><RouterLink to="/sites?adopt=1" class="text-accent">{{ t('security.connect') }} →</RouterLink></Card><Card><template #title>{{ l('环境与恢复文档','Environment and recovery documentation') }}</template><a href="https://github.com/3api-pro/relay-panel/blob/main/docs/SELF-HOST.md" target="_blank" rel="noopener" class="block text-accent">{{ l('本机安装与环境配置','Local installation and environment setup') }} ↗</a><a href="https://github.com/3api-pro/relay-panel/blob/main/docs/OPERATIONS.md" target="_blank" rel="noopener" class="mt-3 block text-accent">{{ l('备份、恢复与故障排查','Backup, recovery and troubleshooting') }} ↗</a></Card></div>
  </div>
</template>
