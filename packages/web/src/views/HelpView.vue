<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { BookOpen, ExternalLink, Link2, LifeBuoy, Mail, Plus, Wallet } from 'lucide-vue-next';
import { get, put } from '../api/client';
import { session } from '../api/session';
import { Button, Card, Field, Input, toast } from '../components/ui';

/**
 * 帮助与支持：托管版 onboarding（开新站 / 接入已有站双路径）+ 订阅指引 +
 * 支持联系（GET /api/support）；root 可就地编辑支持信息（PUT /api/settings/support）。
 */
const router = useRouter();
const { t } = useI18n();
const isRoot = session.isRoot;

interface SupportInfo {
  email: string | null;
  url: string | null;
  docsUrl: string | null;
}

const support = ref<SupportInfo>({ email: null, url: null, docsUrl: null });

async function loadSupport(): Promise<void> {
  try {
    support.value = await get<SupportInfo>('/api/support', { silent: true });
  } catch {
    // 支持信息缺失不阻塞页面
  }
}
onMounted(() => void loadSupport());

// root 编辑
const editing = ref(false);
const fEmail = ref('');
const fUrl = ref('');
const fDocs = ref('');
const saving = ref(false);

function startEdit(): void {
  fEmail.value = support.value.email ?? '';
  fUrl.value = support.value.url ?? '';
  fDocs.value = support.value.docsUrl ?? '';
  editing.value = true;
}

async function saveSupport(): Promise<void> {
  saving.value = true;
  try {
    await put('/api/settings/support', {
      email: fEmail.value.trim() === '' ? null : fEmail.value.trim(),
      url: fUrl.value.trim() === '' ? null : fUrl.value.trim(),
      docsUrl: fDocs.value.trim() === '' ? null : fDocs.value.trim(),
    });
    toast.success(t('help.supportSaved'));
    editing.value = false;
    await loadSupport();
  } catch {
    // client 已弹错误 toast
  } finally {
    saving.value = false;
  }
}

interface StepCard {
  icon: typeof Plus;
  title: string;
  desc: string;
  action: string;
  to: string;
}

const steps: StepCard[] = [
  {
    icon: Plus,
    title: t('help.pathNew.title'),
    desc: t('help.pathNew.desc'),
    action: t('help.pathNew.action'),
    to: '/sites',
  },
  {
    icon: Link2,
    title: t('help.pathAdopt.title'),
    desc: t('help.pathAdopt.desc'),
    action: t('help.pathAdopt.action'),
    to: '/sites',
  },
  {
    icon: Wallet,
    title: t('help.pathBilling.title'),
    desc: t('help.pathBilling.desc'),
    action: t('help.pathBilling.action'),
    to: '/billing',
  },
];
</script>

<template>
  <div class="rp-page space-y-5">
    <!-- 快速上手 -->
    <section>
      <p class="rp-microlabel mb-3">{{ t('help.gettingStarted') }}</p>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <article v-for="(s, i) in steps" :key="i" class="rp-panel flex flex-col p-4">
          <div class="flex items-center gap-2">
            <span class="rounded-lg border border-accent/25 bg-accent/10 p-1.5 text-accent">
              <component :is="s.icon" :size="15" />
            </span>
            <h3 class="text-sm font-semibold">{{ s.title }}</h3>
          </div>
          <p class="mt-2 flex-1 text-xs leading-relaxed text-muted">{{ s.desc }}</p>
          <div class="mt-4">
            <Button size="sm" variant="outline" @click="() => router.push(s.to)">
              {{ s.action }}
            </Button>
          </div>
        </article>
      </div>
    </section>

    <!-- 支持联系 -->
    <Card>
      <template #title>
        <span class="flex items-center gap-2"><LifeBuoy :size="15" /> {{ t('help.supportSection') }}</span>
      </template>
      <template #actions>
        <Button v-if="isRoot && !editing" size="sm" variant="ghost" @click="startEdit">{{ t('common.edit') }}</Button>
      </template>

      <div v-if="!editing" class="space-y-3">
        <p class="text-xs leading-relaxed text-muted">{{ t('help.supportIntro') }}</p>
        <div class="flex flex-wrap items-center gap-3">
          <a v-if="support.email" :href="`mailto:${support.email}`">
            <Button size="sm" variant="outline"><Mail :size="14" /> {{ support.email }}</Button>
          </a>
          <a v-if="support.url" :href="support.url" target="_blank" rel="noopener">
            <Button size="sm" variant="outline"><ExternalLink :size="14" /> {{ t('help.supportPortal') }}</Button>
          </a>
          <a v-if="support.docsUrl" :href="support.docsUrl" target="_blank" rel="noopener">
            <Button size="sm" variant="outline"><BookOpen :size="14" /> {{ t('help.docs') }}</Button>
          </a>
          <p v-if="!support.email && !support.url && !support.docsUrl" class="text-xs text-muted/70">
            {{ t('help.noSupportConfigured') }}
          </p>
        </div>
      </div>

      <div v-else class="space-y-4">
        <Field :label="t('help.supportEmail')">
          <Input v-model="fEmail" type="email" placeholder="support@example.com" />
        </Field>
        <Field :label="t('help.supportUrl')" :hint="t('help.supportUrlHint')">
          <Input v-model="fUrl" mono placeholder="https://support.example.com" />
        </Field>
        <Field :label="t('help.docsUrl')">
          <Input v-model="fDocs" mono placeholder="https://docs.example.com" />
        </Field>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" :disabled="saving" @click="editing = false">{{ t('common.cancel') }}</Button>
          <Button variant="primary" :loading="saving" @click="saveSupport">{{ t('common.save') }}</Button>
        </div>
      </div>
    </Card>

    <!-- 常见问题 -->
    <Card>
      <template #title>{{ t('help.faqSection') }}</template>
      <dl class="space-y-4">
        <div v-for="i in 4" :key="i">
          <dt class="text-[13px] font-medium">{{ t(`help.faq.q${i}`) }}</dt>
          <dd class="mt-1 text-xs leading-relaxed text-muted">{{ t(`help.faq.a${i}`) }}</dd>
        </div>
      </dl>
    </Card>
  </div>
</template>
