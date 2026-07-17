<script setup lang="ts">
import { ref } from 'vue';
import { Server } from 'lucide-vue-next';
import {
  AreaChart,
  Badge,
  Button,
  Card,
  ConfirmDanger,
  Drawer,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Sparkline,
  StatCard,
  StatusDot,
  Table,
  Tabs,
  useToast,
  type AreaPoint,
  type TableColumn,
} from '../components/ui';

/**
 * 组件厨房（仅 dev 路由 /kitchen）：UI 库全量陈列，供视觉验收与 H2 参照。
 * 不进生产构建路由表。
 */
const { success, error, info } = useToast();

const showModal = ref(false);
const showConfirm = ref(false);
const showDrawer = ref(false);
const confirmLoading = ref(false);

const tab = ref('one');

const inputText = ref('');
const inputSlug = ref('site-a');
const selectVal = ref<string | number | null>(null);

const columns: TableColumn[] = [
  { key: 'slug', label: '站点', mono: true },
  { key: 'engine', label: '引擎' },
  { key: 'status', label: '状态' },
  { key: 'requests', label: '24h 请求', align: 'right' },
];
const rows = [
  { slug: 'site-a', engine: 'engine-x', status: 'active', requests: 12034 },
  { slug: 'site-b', engine: 'engine-y', status: 'stopped', requests: 0 },
  { slug: 'site-c', engine: 'engine-x', status: 'failed:health', requests: 233 },
];

const areaData: AreaPoint[] = Array.from({ length: 14 }, (_, i) => ({
  label: `07-${String(i + 1).padStart(2, '0')}`,
  value: Math.round(400 + Math.sin(i / 2) * 260 + i * 40),
}));

const sparkData = [4, 6, 5, 9, 7, 11, 10, 14, 12, 16];

function onConfirmDanger(): void {
  confirmLoading.value = true;
  window.setTimeout(() => {
    confirmLoading.value = false;
    showConfirm.value = false;
    success('销毁流程已模拟触发');
  }, 800);
}
</script>

<template>
  <div class="mx-auto max-w-[1100px] space-y-6 px-6 py-8">
    <header>
      <p class="text-lg font-semibold tracking-tight">组件厨房</p>
      <p class="text-xs text-muted">UI 库全量陈列（仅 dev 环境路由）</p>
    </header>

    <Card title="Button 按钮">
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="primary">主要操作</Button>
        <Button>次级操作</Button>
        <Button variant="ghost">弱操作</Button>
        <Button variant="danger">危险操作</Button>
        <Button variant="primary" loading>提交中</Button>
        <Button disabled>禁用</Button>
        <Button variant="primary" size="sm">小号</Button>
        <Button size="sm">小号次级</Button>
      </div>
    </Card>

    <Card title="Badge / StatusDot 徽标与状态点">
      <div class="flex flex-wrap items-center gap-2">
        <Badge>默认</Badge>
        <Badge tone="accent">强调</Badge>
        <Badge tone="green">健康</Badge>
        <Badge tone="red">异常</Badge>
        <Badge tone="amber">警告</Badge>
        <Badge tone="muted">次要</Badge>
        <Badge tone="muted" mono size="sm">v1.2.3</Badge>
      </div>
      <div class="mt-4 flex flex-wrap items-center gap-5">
        <StatusDot status="active" />
        <StatusDot status="provisioning" />
        <StatusDot status="running" />
        <StatusDot status="stopped" />
        <StatusDot status="failed:compose" />
        <StatusDot status="destroyed" />
        <StatusDot tone="accent" label="自定义" />
      </div>
    </Card>

    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="站点总数" :value="12" :icon="Server" hint="不含已销毁" />
      <StatCard label="健康站点" value="11/12" tone="green" hint="1 个站点异常" />
      <StatCard label="24h 请求" value="86,420" :spark="sparkData" />
      <StatCard label="加载中示例" value="" loading />
    </div>

    <Card title="AreaChart 面积图（悬停出十字线与提示框）">
      <AreaChart :points="areaData" :height="200" />
    </Card>

    <Card title="Table 表格" :padded="false">
      <Table :columns="columns" :rows="rows" row-key="slug" clickable @row-click="(r) => info(`点击行：${r.slug}`)">
        <template #cell-status="{ value }">
          <StatusDot :status="String(value)" />
        </template>
        <template #cell-requests="{ value }">
          {{ Number(value).toLocaleString('en-US') }}
        </template>
      </Table>
    </Card>

    <Card title="Tabs 标签页">
      <Tabs
        v-model="tab"
        :tabs="[
          { key: 'one', label: '概览' },
          { key: 'two', label: '渠道', count: 3 },
          { key: 'three', label: '审计', count: 128 },
        ]"
      />
      <p class="pt-3 text-xs text-muted">当前标签：{{ tab }}</p>
    </Card>

    <Card title="表单：Field / Input / Select">
      <div class="grid max-w-[520px] grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="站点名称" hint="展示用名称" required>
          <Input v-model="inputText" placeholder="示例站点" />
        </Field>
        <Field label="slug" error="slug 已被占用">
          <Input v-model="inputSlug" mono placeholder="site-a" />
        </Field>
        <Field label="引擎">
          <Select
            v-model="selectVal"
            :options="[
              { value: 'engine-x', label: 'engine-x' },
              { value: 'engine-y', label: 'engine-y' },
            ]"
            placeholder="选择引擎"
          />
        </Field>
      </div>
    </Card>

    <Card title="弹层：Modal / ConfirmDanger / Drawer / Toast">
      <div class="flex flex-wrap gap-2">
        <Button @click="showModal = true">打开 Modal</Button>
        <Button variant="danger" @click="showConfirm = true">打开 ConfirmDanger</Button>
        <Button @click="showDrawer = true">打开 Drawer</Button>
        <Button variant="ghost" @click="success('操作成功')">success toast</Button>
        <Button variant="ghost" @click="error('出错了：示例错误文案')">error toast</Button>
        <Button variant="ghost" @click="info('提示信息')">info toast</Button>
      </div>
    </Card>

    <Card title="Skeleton / EmptyState / Sparkline">
      <div class="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Skeleton :lines="4" />
        <EmptyState title="暂无数据" description="接入数据源后此处将展示内容。" />
        <div class="flex items-end"><Sparkline :points="sparkData" :height="40" /></div>
      </div>
    </Card>

    <Modal v-model:open="showModal" title="示例弹窗">
      <p class="text-[13px] leading-relaxed text-muted">
        这是一个居中弹窗。支持 ESC 关闭、遮罩点击关闭、footer 操作区。
      </p>
      <template #footer>
        <Button variant="ghost" @click="showModal = false">取消</Button>
        <Button variant="primary" @click="showModal = false">确定</Button>
      </template>
    </Modal>

    <ConfirmDanger
      v-model:open="showConfirm"
      title="销毁站点"
      confirm-text="site-a"
      message="销毁后站点容器与路由将被移除（示例文案，仅演示交互）。"
      action-label="确认销毁"
      :loading="confirmLoading"
      @confirm="onConfirmDanger"
    />

    <Drawer v-model:open="showDrawer" title="任务详情（示例）">
      <div class="space-y-3">
        <p class="text-[13px] text-muted">右侧抽屉，任务 steps 时间线等纵深内容用。</p>
        <Skeleton :lines="6" />
      </div>
      <template #footer>
        <Button variant="ghost" @click="showDrawer = false">关闭</Button>
      </template>
    </Drawer>
  </div>
</template>
