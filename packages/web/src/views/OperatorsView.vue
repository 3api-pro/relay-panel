<script setup lang="ts">
import { computed, inject, onMounted, reactive, ref, type ComputedRef } from 'vue';
import { Check, Copy, Pencil, Plus, ShieldAlert, Trash2, TriangleAlert } from 'lucide-vue-next';
import { del, get, patch, post } from '../api/client';
import { session } from '../api/session';
import type {
  InviteCreatedResponse,
  InvitesResponse,
  InviteView,
  OperatorPatchBody,
  OperatorRole,
  OperatorsResponse,
  OperatorView,
} from '../api/types';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  StatusDot,
  Table,
  Tabs,
  type SelectOption,
  type TableColumn,
} from '../components/ui';
import { toast } from '../components/ui/toast';

/**
 * 操作员与邀请管理（root 专属页）。
 * - Tabs：操作员（GET/PATCH /api/operators）、邀请（GET/POST/DELETE /api/invites）
 * - 新建邀请响应含完整一次性 token，展示层强提示「仅此一次立即保存」+ 复制
 * 非 root 误入显示无权限空态。
 */
const isRoot = session.isRoot;
const canWrite = inject<ComputedRef<boolean>>('canWrite', computed(() => false));

const activeTab = ref('operators');

// ---- 数据态 ----
const operators = ref<OperatorView[]>([]);
const invites = ref<InviteView[]>([]);
const loadingOps = ref(true);
const loadingInv = ref(true);
const errOps = ref('');
const errInv = ref('');

async function loadOperators(): Promise<void> {
  loadingOps.value = true;
  errOps.value = '';
  try {
    const res = await get<OperatorsResponse>('/api/operators', { silent: true });
    operators.value = Array.isArray(res?.operators) ? res.operators : [];
  } catch (err) {
    errOps.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loadingOps.value = false;
  }
}

async function loadInvites(): Promise<void> {
  loadingInv.value = true;
  errInv.value = '';
  try {
    const res = await get<InvitesResponse>('/api/invites', { silent: true });
    invites.value = Array.isArray(res?.invites) ? res.invites : [];
  } catch (err) {
    errInv.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loadingInv.value = false;
  }
}

onMounted(() => {
  if (!isRoot.value) return;
  void loadOperators();
  void loadInvites();
});

// ---- 角色 / 状态 展示 ----
const roleOptions: SelectOption[] = [
  { value: 'root', label: 'Root 超管' },
  { value: 'operator', label: '操作员' },
  { value: 'viewer', label: '只读' },
];
const statusOptions: SelectOption[] = [
  { value: 'active', label: '启用' },
  { value: 'disabled', label: '禁用' },
];

function roleLabel(role: string): string {
  const map: Record<string, string> = { root: 'Root 超管', operator: '操作员', viewer: '只读' };
  return map[role] ?? role;
}
function roleTone(role: string): 'accent' | 'default' | 'muted' {
  if (role === 'root') return 'accent';
  if (role === 'viewer') return 'muted';
  return 'default';
}

// ---- 时间格式化 ----
function parse(iso: string): Date {
  return new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
}
function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = parse(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = parse(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
function relTime(iso?: string | null): string {
  if (!iso) return '从未登录';
  const t = parse(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} 天前`;
  return fmtDate(iso);
}

// ---- 表格列 ----
const opColumns: TableColumn[] = [
  { key: 'email', label: '邮箱' },
  { key: 'displayName', label: '显示名' },
  { key: 'role', label: '角色' },
  { key: 'status', label: '状态' },
  { key: 'siteCount', label: '站点', align: 'right' },
  { key: 'subscription', label: '当前订阅' },
  { key: 'lastLoginAt', label: '最近登录' },
  { key: 'createdAt', label: '创建时间' },
  { key: 'actions', label: '', align: 'right', width: '72px' },
];
const inviteColumns: TableColumn[] = [
  { key: 'tokenPrefix', label: '令牌前缀', mono: true },
  { key: 'role', label: '角色' },
  { key: 'note', label: '备注' },
  { key: 'state', label: '状态' },
  { key: 'expiresAt', label: '到期' },
  { key: 'usedBy', label: '使用者' },
  { key: 'createdAt', label: '创建时间' },
  { key: 'actions', label: '', align: 'right', width: '56px' },
];

// Table rows 需 Record<string, unknown>[]（接口无索引签名，转型后传入）
const opRows = computed(() => operators.value as unknown as Record<string, unknown>[]);
const inviteRows = computed(() => invites.value as unknown as Record<string, unknown>[]);
const asOperator = (row: Record<string, unknown>): OperatorView => row as unknown as OperatorView;
const asInvite = (row: Record<string, unknown>): InviteView => row as unknown as InviteView;

// 邀请状态：已使用 / 已过期 / 有效
function inviteState(inv: InviteView): { label: string; tone: 'muted' | 'red' | 'green' } {
  if (inv.usedBy) return { label: '已使用', tone: 'muted' };
  const exp = parse(inv.expiresAt).getTime();
  if (!Number.isNaN(exp) && exp < Date.now()) return { label: '已过期', tone: 'red' };
  return { label: '有效', tone: 'green' };
}

// ---- 编辑操作员（Drawer）----
const editOpen = ref(false);
const editTarget = ref<OperatorView | null>(null);
const editForm = reactive({ role: '', status: '', displayName: '' });
const saving = ref(false);

function openEdit(op: OperatorView): void {
  editTarget.value = op;
  editForm.role = op.role;
  editForm.status = op.status;
  editForm.displayName = op.displayName ?? '';
  editOpen.value = true;
}

async function saveEdit(): Promise<void> {
  const t = editTarget.value;
  if (!t) return;
  const body: OperatorPatchBody = {};
  if (editForm.role !== t.role) body.role = editForm.role as OperatorRole;
  if (editForm.status !== t.status) body.status = editForm.status as 'active' | 'disabled';
  const name = editForm.displayName.trim();
  if (name !== (t.displayName ?? '')) body.displayName = name;
  if (Object.keys(body).length === 0) {
    editOpen.value = false;
    return;
  }
  saving.value = true;
  try {
    await patch(`/api/operators/${t.id}`, body);
    toast.success('操作员已更新');
    editOpen.value = false;
    await loadOperators();
  } catch {
    // client 已弹 toast（含拒绝禁用/降级最后一个 Root 的 400），保留抽屉供重试
  } finally {
    saving.value = false;
  }
}

// ---- 新建邀请（Modal）----
const createOpen = ref(false);
const createForm = reactive<{ role: string; note: string; ttlHours: number | '' }>({
  role: 'operator',
  note: '',
  ttlHours: 168,
});
const creating = ref(false);

function openCreate(): void {
  createForm.role = 'operator';
  createForm.note = '';
  createForm.ttlHours = 168;
  createOpen.value = true;
}

async function submitCreate(): Promise<void> {
  const ttl = typeof createForm.ttlHours === 'number' && createForm.ttlHours > 0 ? createForm.ttlHours : 168;
  creating.value = true;
  try {
    const res = await post<InviteCreatedResponse>('/api/invites', {
      role: createForm.role as OperatorRole,
      note: createForm.note.trim() || undefined,
      ttlHours: ttl,
    });
    createOpen.value = false;
    tokenResult.value = res;
    copied.value = false;
    tokenOpen.value = true;
    await loadInvites();
  } catch {
    // client 已弹 toast
  } finally {
    creating.value = false;
  }
}

// ---- 一次性 token 展示 ----
const tokenOpen = ref(false);
const tokenResult = ref<InviteCreatedResponse | null>(null);
const copied = ref(false);

async function copyToken(): Promise<void> {
  const token = tokenResult.value?.token;
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    copied.value = true;
    toast.success('邀请令牌已复制');
  } catch {
    toast.error('复制失败，请手动选择令牌文本复制');
  }
}

// ---- 删除邀请（普通确认 Modal）----
const delTarget = ref<InviteView | null>(null);
const deleting = ref(false);

function closeDelete(v: boolean): void {
  if (!v) delTarget.value = null;
}

async function confirmDelete(): Promise<void> {
  const inv = delTarget.value;
  if (!inv) return;
  deleting.value = true;
  try {
    await del(`/api/invites/${encodeURIComponent(inv.tokenPrefix)}`);
    toast.success('邀请已删除');
    delTarget.value = null;
    await loadInvites();
  } catch {
    // client 已弹 toast
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <!-- 非 root 无权限 -->
  <div v-if="!isRoot" class="rp-panel p-10">
    <EmptyState
      title="无权限访问"
      description="操作员与邀请管理仅对 Root 超管开放。如需相关权限，请联系你的 Root 管理员。"
      :icon="ShieldAlert"
    />
  </div>

  <div v-else class="rp-page space-y-5">
    <!-- 页头 -->
    <div class="flex items-end justify-between gap-4">
      <div>
        <h1 class="text-lg font-semibold tracking-tight">操作员与邀请</h1>
        <p class="mt-0.5 text-xs text-muted">管理团队成员的角色与登录权限，签发一次性注册邀请。</p>
      </div>
      <Button
        v-if="canWrite && activeTab === 'invites'"
        variant="primary"
        @click="openCreate"
      >
        <Plus :size="14" /> 新建邀请
      </Button>
    </div>

    <Tabs
      v-model="activeTab"
      :tabs="[
        { key: 'operators', label: '操作员', count: operators.length },
        { key: 'invites', label: '邀请', count: invites.length },
      ]"
    />

    <!-- 操作员 Tab -->
    <template v-if="activeTab === 'operators'">
      <div v-if="errOps" class="rp-panel p-8">
        <EmptyState title="加载失败" :description="errOps">
          <Button @click="loadOperators">重试</Button>
        </EmptyState>
      </div>
      <div v-else class="rp-panel overflow-hidden">
        <Table
          :columns="opColumns"
          :rows="opRows"
          row-key="id"
          :loading="loadingOps"
          empty="还没有操作员"
        >
          <template #cell-displayName="{ value }">
            <span v-if="value">{{ value }}</span>
            <span v-else class="text-muted/60">未设置</span>
          </template>
          <template #cell-role="{ value }">
            <Badge :tone="roleTone(String(value))" size="sm">{{ roleLabel(String(value)) }}</Badge>
          </template>
          <template #cell-status="{ value }">
            <StatusDot
              :tone="String(value) === 'active' ? 'green' : 'muted'"
              :label="String(value) === 'active' ? '启用' : '禁用'"
            />
          </template>
          <template #cell-siteCount="{ value }">
            <span class="tnum">{{ value ?? 0 }}</span>
          </template>
          <template #cell-subscription="{ row }">
            <template v-if="asOperator(row).subscription">
              <div class="flex flex-col gap-0.5">
                <Badge tone="accent" size="sm" mono>{{ asOperator(row).subscription?.planKey }}</Badge>
                <span class="text-[11px] text-muted/70">
                  {{ asOperator(row).subscription?.currentPeriodEnd ? `到期 ${fmtDate(asOperator(row).subscription?.currentPeriodEnd)}` : '长期有效' }}
                </span>
              </div>
            </template>
            <span v-else class="text-muted/50">无</span>
          </template>
          <template #cell-lastLoginAt="{ value }">
            <span class="text-muted">{{ relTime(value ? String(value) : null) }}</span>
          </template>
          <template #cell-createdAt="{ value }">
            <span class="text-muted">{{ fmtDate(value ? String(value) : null) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex justify-end">
              <Button
                v-if="canWrite"
                variant="ghost"
                size="sm"
                @click="openEdit(asOperator(row))"
              >
                <Pencil :size="13" /> 编辑
              </Button>
            </div>
          </template>
        </Table>
      </div>
    </template>

    <!-- 邀请 Tab -->
    <template v-else>
      <div v-if="errInv" class="rp-panel p-8">
        <EmptyState title="加载失败" :description="errInv">
          <Button @click="loadInvites">重试</Button>
        </EmptyState>
      </div>
      <div v-else class="rp-panel overflow-hidden">
        <Table
          :columns="inviteColumns"
          :rows="inviteRows"
          row-key="tokenPrefix"
          :loading="loadingInv"
          empty="还没有邀请，点右上角「新建邀请」签发一个"
        >
          <template #cell-tokenPrefix="{ value }">
            <span class="font-mono text-xs">{{ value }}…</span>
          </template>
          <template #cell-role="{ value }">
            <Badge :tone="roleTone(String(value))" size="sm">{{ roleLabel(String(value)) }}</Badge>
          </template>
          <template #cell-note="{ value }">
            <span v-if="value" class="text-muted">{{ value }}</span>
            <span v-else class="text-muted/50">—</span>
          </template>
          <template #cell-state="{ row }">
            <Badge :tone="inviteState(asInvite(row)).tone" size="sm">{{ inviteState(asInvite(row)).label }}</Badge>
          </template>
          <template #cell-expiresAt="{ value }">
            <span class="tnum text-muted">{{ fmtDateTime(value ? String(value) : null) }}</span>
          </template>
          <template #cell-usedBy="{ row }">
            <div v-if="asInvite(row).usedBy" class="flex flex-col gap-0.5">
              <span>{{ asInvite(row).usedBy }}</span>
              <span v-if="asInvite(row).usedAt" class="text-[11px] text-muted/70">{{ fmtDateTime(asInvite(row).usedAt) }}</span>
            </div>
            <span v-else class="text-muted/50">—</span>
          </template>
          <template #cell-createdAt="{ value }">
            <span class="text-muted">{{ fmtDate(value ? String(value) : null) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex justify-end">
              <Button
                v-if="canWrite"
                variant="ghost"
                size="sm"
                @click="delTarget = asInvite(row)"
              >
                <Trash2 :size="13" />
              </Button>
            </div>
          </template>
        </Table>
      </div>
    </template>
  </div>

  <!-- 编辑操作员抽屉 -->
  <Drawer v-model:open="editOpen" title="编辑操作员" width="440px">
    <div v-if="editTarget" class="space-y-4">
      <div class="rp-panel p-3">
        <p class="truncate text-[13px] font-medium">{{ editTarget.email }}</p>
        <p class="mt-0.5 text-xs text-muted">操作员 ID {{ editTarget.id }} · 创建于 {{ fmtDate(editTarget.createdAt) }}</p>
      </div>
      <Field label="显示名">
        <Input
          :model-value="editForm.displayName"
          placeholder="未设置"
          @update:model-value="(v) => (editForm.displayName = String(v))"
        />
      </Field>
      <Field label="角色" hint="降级最后一个在用 Root 会被后端拒绝。">
        <Select
          :model-value="editForm.role"
          :options="roleOptions"
          @update:model-value="(v) => (editForm.role = String(v))"
        />
      </Field>
      <Field label="状态" hint="禁用后该操作员将无法登录。">
        <Select
          :model-value="editForm.status"
          :options="statusOptions"
          @update:model-value="(v) => (editForm.status = String(v))"
        />
      </Field>
    </div>
    <template #footer>
      <Button variant="ghost" :disabled="saving" @click="editOpen = false">取消</Button>
      <Button variant="primary" :loading="saving" @click="saveEdit">保存变更</Button>
    </template>
  </Drawer>

  <!-- 新建邀请 -->
  <Modal v-model:open="createOpen" title="新建邀请">
    <div class="space-y-4">
      <Field label="角色" required hint="被邀请者注册后获得的初始角色。">
        <Select
          :model-value="createForm.role"
          :options="roleOptions"
          @update:model-value="(v) => (createForm.role = String(v))"
        />
      </Field>
      <Field label="备注" hint="可选，便于识别该邀请用途（如同事姓名/团队）。">
        <Input
          :model-value="createForm.note"
          placeholder="可选"
          @update:model-value="(v) => (createForm.note = String(v))"
        />
      </Field>
      <Field label="有效期（小时）" hint="默认 168 小时（7 天），到期后邀请自动失效。">
        <Input
          type="number"
          :model-value="createForm.ttlHours"
          placeholder="168"
          @update:model-value="(v) => (createForm.ttlHours = v === '' ? '' : Number(v))"
        />
      </Field>
    </div>
    <template #footer>
      <Button variant="ghost" :disabled="creating" @click="createOpen = false">取消</Button>
      <Button variant="primary" :loading="creating" @click="submitCreate">创建邀请</Button>
    </template>
  </Modal>

  <!-- 一次性 token 展示 -->
  <Modal v-model:open="tokenOpen" title="邀请已创建" width="560px">
    <div class="space-y-4">
      <div class="flex items-start gap-2.5 rounded-lg border border-amber/30 bg-amber/10 p-3">
        <TriangleAlert :size="16" class="mt-0.5 shrink-0 text-amber" />
        <p class="text-[13px] leading-relaxed text-amber">
          请立即复制并保存下方邀请令牌，<span class="font-semibold">仅此一次可见</span>；关闭本窗口后将无法再次查看完整令牌。
        </p>
      </div>
      <div>
        <p class="rp-microlabel mb-1.5">邀请令牌</p>
        <div class="flex items-stretch gap-2">
          <code
            class="min-w-0 flex-1 select-all break-all rounded-lg border border-border bg-bg/60 px-3 py-2.5 font-mono text-xs leading-relaxed text-text"
          >{{ tokenResult?.token }}</code>
          <Button variant="primary" @click="copyToken">
            <component :is="copied ? Check : Copy" :size="14" /> {{ copied ? '已复制' : '复制' }}
          </Button>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <p class="rp-microlabel mb-1.5">角色</p>
          <Badge :tone="roleTone(tokenResult?.role ?? 'operator')" size="sm">
            {{ roleLabel(tokenResult?.role ?? 'operator') }}
          </Badge>
        </div>
        <div>
          <p class="rp-microlabel mb-1.5">到期</p>
          <p class="tnum text-[13px]">{{ fmtDateTime(tokenResult?.expiresAt) }}</p>
        </div>
      </div>
      <div v-if="tokenResult?.note">
        <p class="rp-microlabel mb-1.5">备注</p>
        <p class="text-[13px] text-muted">{{ tokenResult.note }}</p>
      </div>
    </div>
    <template #footer>
      <Button variant="ghost" @click="copyToken">复制令牌</Button>
      <Button variant="primary" @click="tokenOpen = false">我已保存</Button>
    </template>
  </Modal>

  <!-- 删除邀请确认 -->
  <Modal
    :open="delTarget !== null"
    title="删除邀请"
    width="420px"
    :closable="!deleting"
    @update:open="closeDelete"
  >
    <p class="text-[13px] leading-relaxed text-muted">
      确认删除邀请
      <code class="mx-0.5 rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-text">{{ delTarget?.tokenPrefix }}…</code>
      ？删除后该邀请链接将立即失效，无法再用于注册。
    </p>
    <template #footer>
      <Button variant="ghost" :disabled="deleting" @click="delTarget = null">取消</Button>
      <Button variant="danger" :loading="deleting" @click="confirmDelete">删除邀请</Button>
    </template>
  </Modal>
</template>
