<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { TriangleAlert } from 'lucide-vue-next';
import Modal from './Modal.vue';
import Button from './Button.vue';
import Input from './Input.vue';

/**
 * 破坏性操作确认：要求逐字输入 confirmText（如站点 slug）才能点确认。
 * 用法：<ConfirmDanger v-model:open="show" title="销毁站点" :confirm-text="site.slug" @confirm="doDestroy" />
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** 必须逐字输入的文本（通常是 slug） */
    confirmText: string;
    /** 说明文案 */
    message?: string;
    /** 确认按钮文字 */
    actionLabel?: string;
    loading?: boolean;
  }>(),
  { message: '', actionLabel: '确认执行', loading: false },
);

const emit = defineEmits<{ 'update:open': [v: boolean]; confirm: [] }>();

const typed = ref('');
const matched = computed(() => typed.value === props.confirmText);

watch(
  () => props.open,
  (open) => {
    if (open) typed.value = '';
  },
);

function close(): void {
  emit('update:open', false);
}
</script>

<template>
  <Modal :open="props.open" :title="props.title" width="440px" :closable="!props.loading" @update:open="close">
    <div class="flex items-start gap-3">
      <div class="mt-0.5 rounded-lg border border-red/25 bg-red/10 p-2 text-red">
        <TriangleAlert :size="16" />
      </div>
      <div class="min-w-0 flex-1 space-y-3">
        <p v-if="props.message" class="text-[13px] leading-relaxed text-muted">{{ props.message }}</p>
        <p class="text-[13px] text-muted">
          此操作不可撤销。请输入
          <code class="mx-0.5 rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-red">{{ props.confirmText }}</code>
          以确认：
        </p>
        <Input v-model="typed" mono :placeholder="props.confirmText" :disabled="props.loading" autofocus />
      </div>
    </div>
    <template #footer>
      <Button variant="ghost" :disabled="props.loading" @click="close">取消</Button>
      <Button variant="danger" :disabled="!matched" :loading="props.loading" @click="emit('confirm')">
        {{ props.actionLabel }}
      </Button>
    </template>
  </Modal>
</template>
