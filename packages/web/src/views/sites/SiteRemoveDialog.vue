<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SiteView } from '../../api/types';
import { post } from '../../api/client';
import { ConfirmDanger } from '../../components/ui';
import { toast } from '../../components/ui/toast';

const props = defineProps<{ open: boolean; site: SiteView | null }>();
const emit = defineEmits<{ 'update:open': [open: boolean]; removed: [] }>();
const { t } = useI18n();
const busy = ref(false);
async function remove(): Promise<void> {
  if (!props.site || busy.value) return;
  const slug = props.site.slug;
  busy.value = true;
  try {
    await post(`/api/sites/${encodeURIComponent(slug)}/remove`, { confirm: slug, preserveResources: true });
    toast.success(t('sites.remove.success'));
    emit('update:open', false);
    emit('removed');
  } catch { /* The API client displays the actionable error; keep the dialog open. */ }
  finally { busy.value = false; }
}
</script>

<template>
  <ConfirmDanger :open="open" :title="t('sites.remove.title')" :confirm-text="site?.label || site?.slug || ''"
    :message="t('sites.remove.message')" :action-label="t('sites.remove.action')" :loading="busy"
    @update:open="emit('update:open', $event)" @confirm="remove" />
</template>
