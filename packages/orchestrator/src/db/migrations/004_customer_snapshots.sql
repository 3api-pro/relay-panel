-- 004: 客户 CRM 每日快照（F4 客户 CRM + 流失预警）
--  - customer_snapshots: 逐日为每站每客户落一行资产快照，相邻日 period_cost 之差=当日消耗，
--    用于消费骤降/流失侦测（引擎无直供骤降信号，故本表自建历史）。
--  - period_cost 语义 = 该快照时点【累计净消耗代理】= total_recharged - balance - frozen_balance；
--    受退款/管理员调额/赠额影响非精确，仅作近似骤降信号（UI 标『估算』）。
--  - 去重键 UNIQUE(site_slug,user_id,captured_date)：每站每人每北京日历日一行；一天多次 tick 幂等只更今日行。
--  - balance/frozen_balance = 客户预付余额（对客负债），与上游 channel 账户余额严格区分。
-- 🔴 全部 IF NOT EXISTS 幂等；只写文件，由受控重启时 runMigrations 自动应用，绝不手动对生产库执行。

CREATE TABLE IF NOT EXISTS customer_snapshots (
  id serial PRIMARY KEY,
  site_slug text NOT NULL,
  user_id integer NOT NULL,
  email text,
  balance numeric(14,6) NOT NULL DEFAULT 0,
  frozen_balance numeric(14,6) NOT NULL DEFAULT 0,
  total_recharged numeric(14,6) NOT NULL DEFAULT 0,
  period_cost numeric(14,6) NOT NULL DEFAULT 0,
  status text,
  captured_date date NOT NULL,
  captured_at timestamp NOT NULL DEFAULT now()
);

-- 每站每人每北京日历日唯一（ON CONFLICT 去重锚点；一天内多次快照只 upsert 今日行）
CREATE UNIQUE INDEX IF NOT EXISTS customer_snapshots_site_user_date_uk
  ON customer_snapshots (site_slug, user_id, captured_date);

-- 按 (站,人,日期倒序) 拉历史算相邻差值
CREATE INDEX IF NOT EXISTS customer_snapshots_site_user_date_idx
  ON customer_snapshots (site_slug, user_id, captured_date DESC);
