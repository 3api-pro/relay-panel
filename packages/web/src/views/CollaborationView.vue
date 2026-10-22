<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { get, post, del } from '../api/client';
import { session } from '../api/session';
import { Button, Card, Field, Input, Select, EmptyState } from '../components/ui';
const route = useRoute(), { locale } = useI18n();
const l = (zh:string,en:string) => locale.value.startsWith('zh') ? zh : en;
const labels:Record<string,[string,string]> = {
  supplier:['供应商','Supplier'], reseller:['代理','Reseller'], operations:['运维','Operations'], support:['客服','Support'], finance:['财务','Finance'],
  open:['待处理','Open'], in_progress:['处理中','In progress'], waiting:['等待材料','Waiting'], submitted:['已提交，待复核','Submitted for review'], accepted:['已复核','Accepted'], closed:['已关闭','Closed'],
  incident:['故障事件','Incident'], billing_review:['费用复核','Billing review'], maintenance:['维护','Maintenance'], upgrade:['升级','Upgrade'], recovery:['恢复','Recovery'], quote:['报价','Quote'], settlement:['结算','Settlement'], onboarding:['客户接入','Onboarding'],
};
const label = (key:string) => labels[key] ? l(...labels[key]) : key;
interface Site {id:number;label:string}
interface Access {id:number;email:string;role:string;partnerId:number|null;acceptedAt:string|null;revokedAt:string|null;expiresAt:string;inviteExpiresAt:string}
interface Work {id:number;title:string;kind:string;partnerId:number|null}
interface Partner {id:number;name:string;kind:string;status:string}
interface Assignment {id:number;title:string;brief:string;status:string;version:number;revokedAt:string|null;updatedAt:string;email?:string;role:string;kind?:string;workId?:number;accessId?:number}
interface Message {id:number;staff:boolean;body:string;status:string;createdAt:string}
const canManage = computed(() => session.state.user?.role !== 'viewer' && session.state.workspaceRole === 'owner');
const mode = ref(canManage.value && (session.isRoot.value || route.query.mode === 'manage') ? 'manage' : 'mine');
const sites=ref<Site[]>([]),siteId=ref<string|number|null>(null),access=ref<Access[]>([]),partners=ref<Partner[]>([]),works=ref<Work[]>([]),roles=ref<Record<string,string[]>>({});
const items=ref<Assignment[]>([]),selected=ref<Assignment|null>(null),messages=ref<Message[]>([]),active=ref(false),hasMore=ref(false),moreMessages=ref(false),moreWorks=ref(false),accessLimited=ref(false);
const busy=ref(false),loading=ref(false),error=ref(''),notice=ref(''),email=ref(''),role=ref<string|number|null>('support'),partnerId=ref<string|number|null>(''),days=ref<number|string>(30),inviteLink=ref(''),token=ref('');
const accessId=ref<string|number|null>(''),workId=ref<string|number|null>(''),title=ref(''),brief=ref(''),preview=ref(false),body=ref(''),status=ref<string|number|null>('in_progress');
try { token.value=sessionStorage.getItem('rp-collaboration-invite')??''; } catch { /* A code can be pasted manually. */ }
const base=computed(()=>mode.value==='manage'?'/api/services/collaboration':'/api/collaboration');
const valid=(a:Access)=>!a.revokedAt&&Date.parse(a.expiresAt+'Z')>Date.now();
const chosenAccess=computed(()=>access.value.find(a=>a.id===Number(accessId.value)));
const availableWorks=computed(()=>works.value.filter(w=>chosenAccess.value&&(roles.value[chosenAccess.value.role]??[]).includes(w.kind)&&(!chosenAccess.value.partnerId||w.partnerId===chosenAccess.value.partnerId)));
const availablePartners=computed(()=>partners.value.filter(p=>p.status==='active'&&p.kind===(role.value==='operations'?'operator':role.value)));
const nextStatuses=computed(()=>{
  if(!selected.value)return[];
  const transitions:Record<string,string[]>=mode.value==='manage'?{
    open:['open','in_progress','waiting'],in_progress:['in_progress','waiting'],waiting:['waiting','in_progress'],submitted:['submitted','in_progress','waiting','accepted'],accepted:['accepted','closed','in_progress'],closed:['closed','in_progress'],
  }:{open:['open','in_progress','waiting','submitted'],in_progress:['in_progress','waiting','submitted'],waiting:['waiting','in_progress','submitted'],submitted:['submitted'],accepted:[],closed:[]};
  return (transitions[selected.value.status]??[]).map(value=>({value,label:label(value)}));
});
async function run(fn:()=>Promise<void>){if(busy.value)return;busy.value=true;error.value='';notice.value='';try{await fn();}catch(e){error.value=String(e);}finally{busy.value=false;}}
let epoch=0;
async function load(){
  const current=++epoch;loading.value=true;
  try {
    if(mode.value==='manage'){
      if(!siteId.value)return;
      const q={siteId:Number(siteId.value)};
      const [a,w,p,list]=await Promise.all([
        get<{items:Access[];roles:Record<string,string[]>;limited:boolean}>('/api/services/collaboration/access',{query:q}),
        get<{items:Work[];hasMore:boolean}>('/api/services/work',{query:q}),get<{items:Partner[]}>('/api/services/partners',{query:q}),
        get<{items:Assignment[];hasMore:boolean}>('/api/services/collaboration/assignments',{query:q}),
      ]);
      if(current!==epoch)return;
      access.value=a.items;roles.value=a.roles;accessLimited.value=a.limited;works.value=w.items;moreWorks.value=w.hasMore;partners.value=p.items;items.value=list.items;hasMore.value=list.hasMore;
    }else{const r=await get<{items:Assignment[];hasMore:boolean}>('/api/collaboration/assignments');if(current===epoch){items.value=r.items;hasMore.value=r.hasMore;}}
  }finally{if(current===epoch)loading.value=false;}
}
function reset(){selected.value=null;messages.value=[];items.value=[];access.value=[];works.value=[];partners.value=[];accessId.value='';workId.value='';title.value='';brief.value='';preview.value=false;inviteLink.value='';body.value='';}
onMounted(async()=>{
  try {if(canManage.value){const c=await get<{sites:Site[]}>('/api/services/catalog');sites.value=c.sites;siteId.value=c.sites.find(s=>String(s.id)===route.query.site)?.id??c.sites[0]?.id??null;}await load();}catch(e){error.value=String(e);}
});
watch([mode,siteId],()=>{reset();void load().catch(e=>error.value=String(e));});
watch(role,()=>partnerId.value='');
watch(accessId,()=>{workId.value='';preview.value=false;});
watch([title,brief,workId],()=>preview.value=false);
async function invite(){await run(async()=>{
  const r=await post<{token:string}>('/api/services/collaboration/access',{siteId:Number(siteId.value),email:email.value,role:role.value,days:Number(days.value),...(partnerId.value?{partnerId:Number(partnerId.value)}:{})});
  inviteLink.value=`${location.origin}/collaboration#invite=${r.token}`;await load();
});}
async function accept(){await run(async()=>{await post('/api/collaboration/accept',{token:token.value.trim()});token.value='';try{sessionStorage.removeItem('rp-collaboration-invite');}catch{}mode.value='mine';await load();notice.value=l('已接受授权。站点方共享事项后，会出现在此处。','Access accepted. Assigned cases will appear here.');});}
async function share(){await run(async()=>{await post('/api/services/collaboration/assignments',{accessId:Number(accessId.value),workId:Number(workId.value),title:title.value,brief:brief.value});title.value='';brief.value='';preview.value=false;await load();notice.value=l('事项已共享','Case shared');});}
async function open(item:Assignment){const targetBase=base.value,current=epoch;const r=await get<{item:Assignment;messages:Message[];hasMore:boolean;active:boolean}>(`${targetBase}/assignments/${item.id}`);if(current!==epoch)return;selected.value=r.item;messages.value=r.messages;moreMessages.value=r.hasMore;active.value=r.active;body.value='';status.value=r.item.status;}
async function send(){if(!selected.value)return;await run(async()=>{await post(`${base.value}/assignments/${selected.value!.id}/messages`,{version:selected.value!.version,status:status.value,body:body.value});const id=selected.value!.id;await load();await open({...selected.value!,id});});}
async function older(){await run(async()=>{const r=await get<{items:Assignment[];hasMore:boolean}>(`${base.value}/assignments`,{query:{...(mode.value==='manage'?{siteId:Number(siteId.value)}:{}),beforeId:items.value.at(-1)?.id}});items.value.push(...r.items);hasMore.value=r.hasMore;});}
async function olderMessages(){if(!selected.value)return;await run(async()=>{const r=await get<{messages:Message[];hasMore:boolean}>(`${base.value}/assignments/${selected.value!.id}`,{query:{beforeId:messages.value.at(-1)?.id}});messages.value.push(...r.messages);moreMessages.value=r.hasMore;});}
async function olderWorks(){await run(async()=>{const r=await get<{items:Work[];hasMore:boolean}>('/api/services/work',{query:{siteId:Number(siteId.value),beforeId:works.value.at(-1)?.id}});works.value.push(...r.items);moreWorks.value=r.hasMore;});}
async function revokeAccess(a:Access){await run(async()=>{await del(`/api/services/collaboration/access/${a.id}`);selected.value=null;inviteLink.value='';await load();});}
async function unshare(){if(!selected.value)return;await run(async()=>{await del(`/api/services/collaboration/assignments/${selected.value!.id}`);selected.value=null;await load();});}
</script>

<template><div class="rp-page space-y-5">
  <h1 class="text-xl font-semibold">{{l('协作工作台','Collaboration')}}</h1>
  <p class="text-sm text-muted">{{l('按事项邀请供应商、代理、运维、客服和财务协作。协作者仅查看明确共享的内容，提交结果后由站点方复核。','Invite suppliers, resellers, operations, support and finance to specific cases. Collaborators see explicitly shared content and submit results for owner review.')}}</p>
  <div class="flex flex-wrap gap-2"><Button :variant="mode==='mine'?'primary':'outline'" :disabled="busy" @click="mode='mine'">{{l('分配给我的事项','Assigned to me')}}</Button><Button v-if="canManage" :variant="mode==='manage'?'primary':'outline'" :disabled="busy" @click="mode='manage'">{{l('管理协作授权','Manage collaboration')}}</Button><Button :disabled="busy||loading" @click="run(load)">{{l('刷新','Refresh')}}</Button></div>
  <p v-if="error" role="alert" class="text-sm text-red">{{error}}</p><p v-if="notice" role="status" class="text-sm text-accent">{{notice}}</p>
  <template v-if="mode==='mine'">
    <Card v-if="session.state.user?.role==='operator'"><template #title>{{l('接受协作邀请','Accept an invitation')}}</template><p class="mb-3 text-xs text-muted">{{l('使用受邀邮箱的普通账号登录，并先在账号安全中完成邮箱验证。邀请不包含注册资格；尚无账号时请先注册或联系平台管理员。','Sign in with a regular account using the invited, verified email. This invitation does not create an account; register first or contact the platform administrator.')}}</p><form class="flex flex-wrap gap-3" @submit.prevent="accept"><Field :label="l('邀请代码','Invitation code')" class="min-w-0 flex-1"><Input v-model="token" required autocomplete="off" maxlength="64" /></Field><Button type="submit" :loading="busy">{{l('接受授权','Accept access')}}</Button></form><RouterLink to="/settings" class="mt-2 block text-xs text-accent">{{l('前往账号安全','Account security')}} →</RouterLink></Card>
  </template>
  <template v-if="mode==='manage'">
    <Field :label="l('当前站点','Current site')"><Select v-model="siteId" :disabled="busy" :options="sites.map(s=>({value:s.id,label:s.label}))" /></Field>
    <template v-if="siteId">
      <Card><template #title>{{l('邀请协作者','Invite a collaborator')}}</template><form class="grid gap-3 sm:grid-cols-2" @submit.prevent="invite">
        <Field :label="l('受邀邮箱','Invited email')"><Input v-model="email" type="email" maxlength="254" required /></Field>
        <Field :label="l('协作身份','Collaboration role')"><Select v-model="role" :options="Object.keys(roles).map(value=>({value,label:label(value)}))" /></Field>
        <Field v-if="['supplier','reseller','operations'].includes(String(role))" :label="l('关联合作伙伴','Linked partner')"><Select v-model="partnerId" :options="[{value:'',label:l('请选择','Select')},...availablePartners.map(p=>({value:p.id,label:p.name}))]" /></Field>
        <Field :label="l('授权有效天数（1–90）','Access duration (1–90 days)')"><Input v-model="days" type="number" min="1" max="90" required /></Field>
        <p class="text-xs text-muted sm:col-span-2">{{l('可分配事项类型：','Allowed case types: ')}}{{(roles[String(role)]??[]).map(label).join('、')}}。{{l('供应商、代理必须关联对应伙伴。仅所有者和平台管理员可以授权。','Suppliers and resellers require a matching partner. Only owners and platform administrators can grant access.')}}</p>
        <Button type="submit" :loading="busy">{{l('生成邀请链接','Create invitation link')}}</Button>
      </form><div v-if="inviteLink" class="mt-3 rounded bg-panel-2 p-3 text-xs"><p>{{l('链接仅本次显示，请自行发送给受邀者；不会自动发送邮件。邀请最长7天有效，使用后失效。','Copy and send this one-time link to the invitee. No email is sent automatically. It expires within 7 days.')}}</p><p class="mt-2 break-all select-all">{{inviteLink}}</p></div></Card>
      <Card><template #title>{{l('协作授权','Access grants')}}</template><p v-if="accessLimited" class="text-xs text-muted">{{l('仅显示最近500条授权。','Latest 500 grants shown.')}}</p><div v-for="a in access" :key="a.id" class="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 text-sm"><div class="min-w-0 break-words"><p>{{a.email}} · {{label(a.role)}}</p><p class="text-xs text-muted">{{a.revokedAt?l('已撤销','Revoked'):!valid(a)?l('已到期','Expired'):a.acceptedAt?l('已接受','Accepted'):Date.parse(a.inviteExpiresAt+'Z')<=Date.now()?l('邀请已到期','Invitation expired'):l('等待接受','Awaiting acceptance')}} · {{l('授权截止','Access until')}} {{a.expiresAt}} UTC</p></div><Button v-if="!a.revokedAt" :disabled="busy" size="sm" @click="revokeAccess(a)">{{l('撤销授权','Revoke access')}}</Button></div><EmptyState v-if="!access.length" :title="l('暂无授权','No grants yet')" /></Card>
      <Card><template #title>{{l('共享处理事项','Share a case')}}</template><p class="mb-3 text-xs text-muted">{{l('只共享下面重新编写的标题、说明和之后的协作回复。内部事项的描述、请求证据、成本、回执和历史备注不会自动共享。','Only the title and brief below, plus future collaboration replies, are shared. Internal descriptions, request evidence, costs, receipts and history remain private.')}}</p><div class="grid gap-3 sm:grid-cols-2">
        <Field :label="l('选择协作者','Collaborator')"><Select v-model="accessId" :options="[{value:'',label:l('请选择','Select')},...access.filter(valid).map(a=>({value:a.id,label:a.email+' · '+label(a.role)}))]" /></Field>
        <Field :label="l('关联内部事项','Internal case')"><Select v-model="workId" :options="[{value:'',label:l('请选择','Select')},...availableWorks.map(w=>({value:w.id,label:'#'+w.id+' '+w.title}))]" /></Field>
        <Button v-if="moreWorks" :disabled="busy" size="sm" @click="olderWorks">{{l('加载更早的内部事项','Load earlier internal cases')}}</Button>
        <Field :label="l('共享标题','Shared title')" class="sm:col-span-2"><Input v-model="title" maxlength="160" /></Field>
        <Field :label="l('共享说明与交付要求','Shared brief and deliverables')" class="sm:col-span-2"><textarea v-model="brief" class="editor" rows="4" maxlength="4000" /></Field>
      </div><div class="mt-3 flex flex-wrap gap-3"><Button :disabled="!accessId||!workId||title.trim().length<3||brief.trim().length<5" @click="preview=!preview">{{l('预览协作者可见内容','Preview shared content')}}</Button><RouterLink :to="`/services`" class="text-sm text-accent">{{l('前往服务中心创建内部事项或伙伴','Create an internal case or partner in the service center')}} →</RouterLink></div>
      <div v-if="preview" class="mt-3 space-y-3 rounded border border-border p-4"><h2 class="font-semibold break-words">{{title}}</h2><p class="whitespace-pre-wrap break-words text-sm">{{brief}}</p><Button variant="primary" :loading="busy" @click="share">{{l('确认共享以上内容','Share this content')}}</Button></div></Card>
    </template><EmptyState v-else :title="l('暂无可管理站点','No sites to manage')" />
  </template>
  <p v-if="loading" class="text-sm text-muted">{{l('正在加载…','Loading…')}}</p>
  <div class="grid gap-4 lg:grid-cols-2">
    <Card><template #title>{{mode==='manage'?l('已分配事项','Assigned cases'):l('我的协作事项','My assignments')}}</template><button v-for="item in items" :key="item.id" class="block w-full rounded border border-border p-3 mb-2 text-left text-sm hover:bg-panel-2" :disabled="busy||loading" @click="run(()=>open(item))"><span class="block break-words font-medium">{{item.title}}</span><span class="text-xs text-muted">{{label(item.status)}} · {{label(item.role)}}<template v-if="item.email"> · {{item.email}}</template><template v-if="item.revokedAt"> · {{l('已撤回','Unshared')}}</template></span></button><EmptyState v-if="!items.length&&!loading" :title="l('暂无共享事项','No shared cases')" /><Button v-if="hasMore" :disabled="busy" @click="older">{{l('加载更早事项','Load earlier cases')}}</Button></Card>
    <Card v-if="selected"><template #title>{{selected.title}}</template><div class="space-y-4"><p class="text-xs text-muted">{{label(selected.kind??'')}} · {{label(selected.status)}} · {{label(selected.role)}}</p><p class="whitespace-pre-wrap break-words text-sm">{{selected.brief}}</p>
      <p class="text-xs text-muted">{{l('这里的提交和复核仅记录协作结果，不自动关闭内部事项、不执行付款或服务器操作。','Submission and review record collaboration results. They do not close internal cases, transfer money or execute server operations.')}}</p>
      <form v-if="active&&nextStatuses.length" class="space-y-3" @submit.prevent="send"><Field :label="l('协作状态','Collaboration status')"><Select v-model="status" :options="nextStatuses" /></Field><Field :label="l('共享回复与处理结果','Shared reply and results')"><textarea v-model="body" class="editor" rows="4" required minlength="5" maxlength="4000" /></Field><Button type="submit" :loading="busy">{{l('发送回复并记录状态','Send reply and status')}}</Button></form>
      <p v-else class="text-xs text-muted">{{l('此事项当前不可回复。','Replies are not currently available.')}}</p>
      <Button v-if="mode==='manage'&&active" :disabled="busy" variant="outline" @click="unshare">{{l('撤回此事项的共享','Revoke this case sharing')}}</Button>
      <div v-for="m in messages" :key="m.id" class="border-l-2 border-border pl-3 text-sm"><p class="text-xs text-muted">{{m.staff?l('站点方','Site owner'):l('协作者','Collaborator')}} · {{label(m.status)}} · {{m.createdAt}} UTC</p><p class="mt-1 whitespace-pre-wrap break-words">{{m.body}}</p></div><Button v-if="moreMessages" :disabled="busy" @click="olderMessages">{{l('加载更早回复','Load earlier replies')}}</Button>
    </div></Card>
  </div>
</div></template>
<style scoped>
.editor{width:100%;border:1px solid var(--glass-border);border-radius:8px;background:transparent;padding:10px;font-size:13px}
</style>
