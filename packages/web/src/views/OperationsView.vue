<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { get, post } from '../api/client';
import type { BackupRunView, BackupCheckView, BackupsResponse, BackupChecksResponse } from '../api/types';
import { Button, Card, Drawer, Field, Select, Table } from '../components/ui';
import type { TableColumn } from '../components/ui';
const { t, locale } = useI18n();
const l = (zh: string, en: string) => locale.value.startsWith('zh') ? zh : en;
const state = ref<{ deploymentMode: string; accountEmailReady: boolean; emailVerificationRequired: boolean; adminMfaRequired: boolean; adminsWithoutMfa: number;
  backupExcludedTables: string[]; automaticBackupEnabled: boolean; backupOverdue: boolean; backup: { status: string; completedAt?: string; error?: string } | null;
  latestSuccessfulBackup: BackupRunView | null; paidUnfulfilled: number; failedNotifications: number; migrations: string[] } | null>(null);
const busy = ref(false), error = ref('');
const records = ref<BackupRunView[]>([]), hasMore = ref(false), loading = ref(false), filter = ref<string | number | null>('');
const drawerOpen = ref(false), selected = ref<BackupRunView | null>(null), checks = ref<BackupCheckView[]>([]), checksMore = ref(false), checksLoading = ref(false);
const verifying = ref<number | null>(null), detailError = ref('');
let alive = true, generation = 0, detailGeneration = 0, summaryGeneration = 0;
const badIntegrity = computed(() => {
  const status = state.value?.latestSuccessfulBackup?.lastCheck?.status;
  return status && !['running', 'verified'].includes(status);
});
const columns = computed<TableColumn[]>(() => [
  { key: 'id', label: l('备份', 'Backup') }, { key: 'startedAt', label: l('创建时间', 'Created') },
  { key: 'databaseKind', label: l('数据库', 'Database') }, { key: 'status', label: l('备份结果', 'Backup result') },
  { key: 'bytes', label: l('大小', 'Size') }, { key: 'lastCheck', label: l('最近文件核验', 'Latest file check') },
]);
const rows = computed(() => records.value as unknown as Record<string, unknown>[]);
function statusText(status?: string | null): string {
  const labels: Record<string, [string, string]> = {
    running: ['进行中', 'Running'], succeeded: ['创建成功', 'Created'], failed: ['创建失败', 'Failed'],
    interrupted: ['已中断，未确认', 'Interrupted, unconfirmed'], verified: ['文件一致', 'Files match'],
    missing: ['文件缺失', 'Files missing'], mismatch: ['校验不一致', 'Checksum mismatch'], unavailable: ['无法读取', 'Unavailable'],
  };
  const pair = labels[status ?? '']; return pair ? l(...pair) : l('尚未核验', 'Not checked');
}
function time(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(/Z$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale.value);
}
function bytes(value: unknown): string {
  if (typeof value !== 'number') return '—';
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(2)} MiB` : `${value.toLocaleString()} B`;
}
async function loadSummary(): Promise<void> {
  const current = ++summaryGeneration;
  const response = await get<NonNullable<typeof state.value>>('/api/admin/operations');
  if (alive && current === summaryGeneration) state.value = response;
}
async function loadHistory(older = false): Promise<void> {
  if (older && (loading.value || !hasMore.value || !records.value.length)) return;
  const current = ++generation;
  loading.value = true;
  try {
    const response = await get<BackupsResponse>('/api/admin/operations/backups', { query: {
      limit: 20, ...(filter.value ? { status: String(filter.value) } : {}), ...(older ? { beforeId: records.value.at(-1)!.id } : {}),
    } });
    if (!alive || current !== generation) return;
    records.value = older ? [...records.value, ...response.backups] : response.backups;
    hasMore.value = response.hasMore;
    if (selected.value) selected.value = records.value.find(r => r.id === selected.value!.id) ?? selected.value;
  } catch (e) { if (alive && current === generation) error.value = String(e); }
  finally { if (current === generation) loading.value = false; }
}
async function load(): Promise<void> {
  error.value = '';
  try { await Promise.all([loadSummary(), loadHistory()]); }
  catch (e) { if (alive) error.value = String(e); }
}
async function backup(): Promise<void> {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try { await post('/api/admin/operations/backup'); }
  catch (e) { if (alive) error.value = String(e); }
  finally { busy.value = false; if (alive) { await Promise.all([loadSummary(), loadHistory()]).catch(e => { error.value = String(e); }); } }
}
async function loadChecks(older = false): Promise<void> {
  const id = selected.value?.id;
  if (!id || (older && (checksLoading.value || !checksMore.value || !checks.value.length))) return;
  const current = ++detailGeneration;
  checksLoading.value = true;
  try {
    const response = await get<BackupChecksResponse>(`/api/admin/operations/backups/${id}/checks`, { query: { limit: 20, ...(older ? { beforeId: checks.value.at(-1)!.id } : {}) } });
    if (!alive || selected.value?.id !== id || current !== detailGeneration) return;
    checks.value = older ? [...checks.value, ...response.checks] : response.checks;
    checksMore.value = response.hasMore;
  } catch (e) { if (alive && selected.value?.id === id && current === detailGeneration) detailError.value = String(e); }
  finally { if (current === detailGeneration) checksLoading.value = false; }
}
function openBackup(row: Record<string, unknown>): void {
  selected.value = row as unknown as BackupRunView;
  checks.value = []; checksMore.value = false; detailError.value = ''; drawerOpen.value = true;
  void loadChecks();
}
async function verify(): Promise<void> {
  const id = selected.value?.id;
  if (!id || verifying.value !== null) return;
  verifying.value = id; detailError.value = '';
  try {
    const result = await post<{ check: BackupCheckView }>(`/api/admin/operations/backups/${id}/verify`);
    if (!alive) return;
    if (selected.value?.id === id) { selected.value.lastCheck = result.check; await loadChecks(); }
    await Promise.all([loadSummary(), loadHistory()]);
  } catch (e) { if (alive && selected.value?.id === id) detailError.value = String(e); }
  finally { verifying.value = null; }
}
watch(filter, () => { error.value = ''; void loadHistory(); });
watch(drawerOpen, open => { if (!open) { selected.value = null; ++detailGeneration; checksLoading.value = false; } });
onMounted(load);
onBeforeUnmount(() => { alive = false; ++generation; ++detailGeneration; });
</script>
<template>
  <div class="rp-page space-y-5">
    <div class="flex justify-between gap-3"><h1 class="text-lg font-semibold">{{ t('operations.title') }}</h1><Button variant="ghost" @click="load">{{ t('operations.refresh') }}</Button></div>
    <p v-if="error" role="alert" class="break-words text-sm text-red">{{ error }}</p>
    <template v-if="state">
      <div class="grid gap-4 md:grid-cols-2">
        <Card><template #title>{{ t('operations.account') }}</template><div class="space-y-3 text-sm"><p>{{ t('operations.mail') }}：{{ t(state.accountEmailReady ? 'operations.ready' : 'operations.missing') }}</p><p>{{ t('operations.verify') }}：{{ t(state.emailVerificationRequired ? 'security.enabled' : 'security.disabled') }}</p><p>{{ t('operations.mfa') }}：{{ state.adminsWithoutMfa }}</p><RouterLink to="/settings" class="text-accent">{{ t('security.title') }} →</RouterLink></div></Card>
        <Card><template #title>{{ t('operations.attention') }}</template><div class="space-y-3 text-sm"><p>{{ t('operations.pendingPayment') }}：{{ state.paidUnfulfilled }}</p><p>{{ t('operations.failedMail') }}：{{ state.failedNotifications }}</p><RouterLink to="/admin/billing" class="text-accent">{{ t('nav.platformBilling') }} →</RouterLink></div></Card>
        <Card><template #title>{{ t('operations.backup') }}</template><div class="space-y-3 text-sm">
          <p>{{ t('operations.automatic') }}：{{ t(state.automaticBackupEnabled ? 'security.enabled' : 'security.disabled') }}</p>
          <p :class="state.backupOverdue ? 'text-amber' : 'text-muted'">{{ t(state.backupOverdue ? 'operations.overdue' : 'operations.recent') }}</p>
          <p>{{ l('最近创建成功','Last successful creation') }}：{{ time(state.latestSuccessfulBackup?.completedAt ?? (state.backup?.status === 'success' ? state.backup.completedAt : null)) }}</p>
          <p v-if="state.latestSuccessfulBackup" :class="badIntegrity ? 'text-red' : 'text-muted'">{{ l('最近文件核验','Latest file check') }}：{{ statusText(state.latestSuccessfulBackup.lastCheck?.status) }}</p>
          <p v-if="badIntegrity" class="text-red">{{ l('该备份的文件未通过最近核验，请检查存储并选择可靠副本。','This backup did not pass its latest check. Inspect storage and select a reliable copy.') }}</p>
          <p v-if="state.backup?.error" class="text-red">{{ state.backup.error }}</p>
          <p class="text-xs leading-6 text-muted">{{ t('operations.backupScope') }}</p>
          <p v-if="state.backupExcludedTables.length" class="break-all text-xs text-muted">{{ t('operations.excludedArchives') }}: {{ state.backupExcludedTables.join(', ') }}</p>
          <Button :loading="busy" :disabled="busy" @click="backup">{{ t('operations.runBackup') }}</Button>
        </div></Card>
        <Card><template #title>{{ t('operations.audit') }}</template><p class="mb-3 text-sm text-muted">{{ t('operations.auditHint') }}</p><a href="/api/audit/export.csv" class="text-accent">{{ t('operations.export') }} ↓</a></Card>
      </div>
      <Card>
        <template #title>{{ l('备份历史与文件核验','Backup history and file checks') }}</template>
        <p class="mb-3 text-xs leading-6 text-muted">{{ l('创建记录、文件校验、恢复演练是不同证据。文件一致不代表已经恢复成功，也不代表存在异机副本。历史从本版新创建的备份开始记录，旧文件不会自动导入或删除。','Creation, file verification and restore drills are separate evidence. Matching files do not prove successful recovery or an off-machine copy. History records new backups; older files are not imported or deleted automatically.') }}</p>
        <div class="mb-3 flex flex-wrap items-end gap-3"><Field :label="l('备份结果筛选','Filter backup results')"><Select v-model="filter" :options="[{value:'',label:l('全部','All')},{value:'succeeded',label:l('创建成功','Created')},{value:'failed',label:l('创建失败','Failed')},{value:'running',label:l('进行中','Running')},{value:'interrupted',label:l('已中断','Interrupted')}]" /></Field><Button v-if="hasMore" :disabled="loading" @click="loadHistory(true)">{{ l('加载更早备份','Load older backups') }}</Button></div>
        <Table :columns="columns" :rows="rows" row-key="id" :loading="loading" clickable :empty="l('暂无备份历史','No backup history')" @row-click="openBackup">
          <template #cell-id="{ value }">#{{ value }}</template>
          <template #cell-startedAt="{ value }"><span class="whitespace-nowrap">{{ time(String(value)) }}</span></template>
          <template #cell-status="{ value }">{{ statusText(String(value)) }}</template>
          <template #cell-bytes="{ value }">{{ bytes(value) }}</template>
          <template #cell-lastCheck="{ value }">{{ statusText((value as BackupCheckView | null)?.status) }}</template>
        </Table>
      </Card>
      <Card><template #title>{{ t('operations.recovery') }}</template><p class="mb-3 text-sm leading-6 text-muted">{{ t('operations.recoveryHint') }}</p><a href="https://github.com/3api-pro/relay-panel/blob/main/docs/OPERATIONS.md" target="_blank" rel="noopener noreferrer" class="text-accent">{{ t('security.guide') }} ↗</a></Card>
    </template>
    <Drawer v-model:open="drawerOpen" :title="selected ? l('备份','Backup') + ' #' + selected.id : l('备份详情','Backup details')">
      <div v-if="selected" class="space-y-5 text-sm">
        <p v-if="detailError" role="alert" class="break-words text-red">{{ detailError }}</p>
        <dl class="grid grid-cols-2 gap-3">
          <div><dt class="text-xs text-muted">{{ l('创建结果','Creation result') }}</dt><dd>{{ statusText(selected.status) }}</dd></div>
          <div><dt class="text-xs text-muted">{{ l('大小','Size') }}</dt><dd>{{ bytes(selected.bytes) }}</dd></div>
          <div><dt class="text-xs text-muted">{{ l('开始时间','Started') }}</dt><dd>{{ time(selected.startedAt) }}</dd></div>
          <div><dt class="text-xs text-muted">{{ l('完成时间','Completed') }}</dt><dd>{{ time(selected.completedAt) }}</dd></div>
        </dl>
        <p class="break-all text-xs text-muted">{{ l('备份目录内的文件','File under the backup directory') }}：{{ selected.storageKey }}/{{ selected.archiveFile }}</p>
        <p v-if="selected.error" class="text-red">{{ selected.error }}</p>
        <p v-if="selected.sha256" class="break-all font-mono text-xs">SHA-256: {{ selected.sha256 }}</p>
        <p v-if="selected.excludedTables.length" class="break-all text-xs text-muted">{{ t('operations.excludedArchives') }}：{{ selected.excludedTables.join(', ') }}</p>
        <div class="space-y-3 rounded border border-border p-3">
          <p class="text-xs leading-6 text-muted">{{ l('核验只读取已登记备份及清单并比较校验值，不恢复数据库、不启动引擎、不导出备份内容。','Verification reads the recorded archive and manifest and compares checksums. It does not restore databases, start engines or export backup contents.') }}</p>
          <p>{{ l('最近文件核验','Latest file check') }}：{{ statusText(selected.lastCheck?.status) }}</p>
          <Button v-if="selected.status === 'succeeded'" :loading="verifying === selected.id" :disabled="verifying !== null || selected.lastCheck?.status === 'running'" @click="verify">{{ l('核验备份文件','Verify backup files') }}</Button>
        </div>
        <section class="space-y-3">
          <h2 class="font-semibold">{{ l('检查记录','Verification history') }}</h2>
          <p v-if="!checks.length && !checksLoading" class="text-xs text-muted">{{ l('尚无检查记录','No verification records') }}</p>
          <article v-for="check in checks" :key="check.id" class="space-y-2 rounded border border-border p-3 text-xs">
            <p class="flex flex-wrap justify-between gap-2"><strong>{{ statusText(check.status) }}</strong><span class="text-muted">{{ time(check.startedAt) }}</span></p>
            <p class="break-words leading-6">{{ check.detail }}</p>
            <p class="break-all text-muted">{{ check.actor }}</p>
          </article>
          <Button v-if="checksMore" :disabled="checksLoading" @click="loadChecks(true)">{{ l('加载更早检查','Load older checks') }}</Button>
        </section>
      </div>
    </Drawer>
  </div>
</template>
