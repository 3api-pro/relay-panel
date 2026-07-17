<script setup lang="ts">
import { computed, inject, onMounted, ref, type ComputedRef } from 'vue';
import { get, put } from '../../api/client';
import { toast } from '../../components/ui/toast';
import { Button, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import type { SiteBrandingResponse } from './types';

/** 设置页：站点品牌（siteName / logoUrl / announcement）读写。 */
const props = defineProps<{ slug: string }>();
const canWrite = inject<ComputedRef<boolean>>('canWrite', computed(() => false));

const siteName = ref('');
const logoUrl = ref('');
const announcement = ref('');
const loading = ref(true);
const loadError = ref('');
const saving = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await get<SiteBrandingResponse>(`/api/sites/${props.slug}/branding`, { silent: true });
    const b = res.branding ?? {};
    siteName.value = b.siteName ?? '';
    logoUrl.value = b.logoUrl ?? '';
    announcement.value = b.announcement ?? '';
    loadError.value = '';
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function save(): Promise<void> {
  saving.value = true;
  try {
    await put(`/api/sites/${props.slug}/branding`, {
      siteName: siteName.value.trim() || undefined,
      logoUrl: logoUrl.value.trim() || undefined,
      announcement: announcement.value.trim() || undefined,
    });
    toast.success('设置已保存');
    await load();
  } catch {
    /* toast 已弹 */
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="max-w-[600px]">
    <div v-if="loading" class="rp-panel p-5"><Skeleton :lines="5" /></div>

    <div v-else-if="loadError" class="rp-panel p-8">
      <EmptyState title="加载失败" :description="loadError">
        <Button size="sm" @click="load">重试</Button>
      </EmptyState>
    </div>

    <div v-else class="rp-panel space-y-5 p-5">
      <Field label="站点名称" hint="展示在站点前台的名称">
        <Input v-model="siteName" :disabled="!canWrite" placeholder="示例站点" />
      </Field>
      <Field label="Logo URL" hint="站点前台 Logo 图片地址（可选）">
        <Input v-model="logoUrl" mono :disabled="!canWrite" placeholder="https://.../logo.png" />
      </Field>
      <Field label="公告" hint="展示给站点用户的公告（可选）">
        <textarea
          v-model="announcement"
          :disabled="!canWrite"
          rows="4"
          placeholder="输入公告内容…"
          class="w-full resize-y rounded-lg border border-border bg-bg/60 px-3 py-2 text-[13px] leading-relaxed text-text placeholder:text-muted/50 transition-colors hover:border-border-2 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:pointer-events-none disabled:opacity-45"
        />
      </Field>
      <div v-if="canWrite" class="flex justify-end border-t border-border/60 pt-4">
        <Button variant="primary" :loading="saving" @click="save">保存设置</Button>
      </div>
      <p v-else class="border-t border-border/60 pt-4 text-xs text-muted/70">当前角色为只读，无法修改设置。</p>
    </div>
  </div>
</template>
