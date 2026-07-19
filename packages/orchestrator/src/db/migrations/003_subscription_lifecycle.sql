-- 003: 订阅生命周期
--  - subscriptions.reminders_sent: 到期提醒台账（各档已发时间戳的 jsonb map），
--    扫描循环据此保证「同档绝不重发」；续费顺延后被清空（重新计各档）。
--    幂等迁移：IF NOT EXISTS + NOT NULL DEFAULT '{}'，存量行自动补默认空对象。

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS reminders_sent jsonb NOT NULL DEFAULT '{}';
