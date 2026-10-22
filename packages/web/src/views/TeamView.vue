<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { get, put, post, patch, del } from '../api/client';
import { Button, Card, Field, Input, Select } from '../components/ui';
const { t } = useI18n();
const workspaces = ref<{ ownerId: number; name: string; role: string }[]>([]);
const members = ref<{ id: number; email: string; role: string }[]>([]);
const invites = ref<{ id: number; email: string; role: string; expiresAt: string; usedAt: string | null; revokedAt: string | null }[]>([]);
const name = ref(''), email = ref(''), inviteLink = ref(''), token = ref(''), error = ref(''), busy = ref(false);
const role = ref<string | number | null>('reader');
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('invite')) { token.value = fragment.get('invite') ?? ''; history.replaceState(history.state, '', location.pathname); }
async function load(): Promise<void> {
  try { const [w, team] = await Promise.all([get<{ workspaces: typeof workspaces.value }>('/api/team/workspaces'), get<{ organization: { name: string } | null; members: typeof members.value; invites: typeof invites.value }>('/api/team')]); workspaces.value = w.workspaces; name.value = team.organization?.name ?? ''; members.value = team.members; invites.value = team.invites; }
  catch (e) { error.value = String(e); }
}
onMounted(load);
function select(id: number): void { localStorage.setItem('rp-workspace', String(id)); location.assign('/'); }
async function run(action: () => Promise<unknown>): Promise<void> { busy.value = true; error.value = ''; try { await action(); await load(); } catch (e) { error.value = String(e); } finally { busy.value = false; } }
async function invite(): Promise<void> { await run(async () => { const result = await post<{ token: string }>('/api/team/invites', { email: email.value, role: role.value }); inviteLink.value = `${location.origin}/team#invite=${result.token}`; }); }
</script>
<template><div class="rp-page space-y-5">
  <h1 class="text-lg font-semibold">{{ t('team.title') }}</h1><p class="text-sm text-muted">{{ t('team.scope') }}</p><p v-if="error" role="alert" class="text-sm text-red">{{ error }}</p>
  <Card><template #title>{{ t('team.workspaces') }}</template><div class="flex flex-wrap gap-3"><Button v-for="w in workspaces" :key="w.ownerId" variant="outline" @click="select(w.ownerId)">{{ w.name }} · {{ t(`team.${w.role}`) }}</Button></div></Card>
  <Card><template #title>{{ t('team.join') }}</template><form class="flex flex-wrap gap-3" @submit.prevent="run(async () => { await post('/api/team/accept', { token }); token = ''; })"><Input v-model="token" :placeholder="t('team.token')" required class="min-w-0 flex-1" /><Button type="submit" :loading="busy">{{ t('team.accept') }}</Button></form></Card>
  <Card><template #title>{{ t('team.ownTeam') }}</template><form class="flex flex-wrap gap-3" @submit.prevent="run(() => put('/api/team', { name }))"><Input v-model="name" :placeholder="t('team.name')" maxlength="64" required /><Button type="submit" :loading="busy">{{ t('ops.save') }}</Button></form></Card>
  <Card><template #title>{{ t('team.invite') }}</template><form class="grid gap-3 sm:grid-cols-2" @submit.prevent="invite"><Field :label="t('security.email')"><Input v-model="email" type="email" required /></Field><Field :label="t('team.role')"><Select v-model="role" :options="['reader','editor'].map(r => ({ value: r, label: t(`team.${r}`) }))" /></Field><Button type="submit" :loading="busy" :disabled="!name">{{ t('team.createInvite') }}</Button></form><p v-if="inviteLink" class="mt-3 break-all rounded bg-panel-2 p-3 text-xs">{{ t('team.copyInvite') }}<br />{{ inviteLink }}</p></Card>
  <Card><template #title>{{ t('team.members') }}</template><div v-for="m in members" :key="m.id" class="flex flex-wrap items-center justify-between gap-2 border-b border-border py-3 text-sm"><span>{{ m.email }} · {{ t(`team.${m.role}`) }}</span><div class="flex gap-2"><Button variant="ghost" @click="run(() => patch(`/api/team/members/${m.id}`, { role: m.role === 'reader' ? 'editor' : 'reader' }))">{{ t('team.changeRole') }}</Button><Button variant="outline" @click="run(() => patch(`/api/team/members/${m.id}`, { role: 'remove' }))">{{ t('team.remove') }}</Button></div></div></Card>
  <Card><template #title>{{ t('team.invites') }}</template><div v-for="i in invites" :key="i.id" class="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 text-sm"><span>{{ i.email }} · {{ t(`team.${i.role}`) }} · {{ i.expiresAt }} UTC</span><span v-if="i.usedAt">{{ t('team.used') }}</span><span v-else-if="i.revokedAt">{{ t('team.revoked') }}</span><Button v-else variant="outline" @click="run(() => del(`/api/team/invites/${i.id}`))">{{ t('team.revoke') }}</Button></div></Card>
</div></template>
