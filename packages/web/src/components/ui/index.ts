/**
 * UI 组件库统一出口（H2 起冻结只用）。
 * 视图层建议从这里导入，减少相对路径散落。
 */
export { default as Button } from './Button.vue';
export { default as Card } from './Card.vue';
export { default as StatCard } from './StatCard.vue';
export { default as Badge } from './Badge.vue';
export { default as StatusDot } from './StatusDot.vue';
export { default as Table } from './Table.vue';
export type { TableColumn } from './Table.vue';
export { default as Modal } from './Modal.vue';
export { default as ConfirmDanger } from './ConfirmDanger.vue';
export { default as Drawer } from './Drawer.vue';
export { default as Tabs } from './Tabs.vue';
export type { TabItem } from './Tabs.vue';
export { default as Field } from './Field.vue';
export { default as Input } from './Input.vue';
export { default as Select } from './Select.vue';
export type { SelectOption } from './Select.vue';
export { default as Toast } from './Toast.vue';
export { toast, useToast } from './toast';
export type { ToastItem, ToastTone } from './toast';
export { default as EmptyState } from './EmptyState.vue';
export { default as Skeleton } from './Skeleton.vue';
export { default as AreaChart } from './AreaChart.vue';
export type { AreaPoint } from './AreaChart.vue';
export { default as Sparkline } from './Sparkline.vue';
