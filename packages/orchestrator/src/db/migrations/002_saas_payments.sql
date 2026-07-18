-- 002: SaaS 收款 + 自助接管存量站
--  - sites.readonly: 每站只读开关（true 时面板拒绝一切引擎写操作，生产站 dogfood 保险丝）
--  - payment_providers: 收款渠道实例（config 密文存 credentials 表，此处只存引用）
--  - payment_orders: 订阅购买订单（状态机 pending -> paid -> completed；终态 expired/failed/cancelled）

ALTER TABLE sites ADD COLUMN IF NOT EXISTS readonly boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS payment_providers (
  id serial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  payment_mode text NOT NULL DEFAULT '',
  config_ref text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_orders (
  id serial PRIMARY KEY,
  order_no text NOT NULL UNIQUE,
  operator_id integer NOT NULL REFERENCES operators(id),
  plan_key text NOT NULL,
  months integer NOT NULL,
  amount numeric(10,2) NOT NULL,
  provider_key text NOT NULL,
  provider_trade_no text,
  status text NOT NULL DEFAULT 'pending',
  pay_url text,
  qr_code text,
  expires_at timestamp,
  paid_at timestamp,
  completed_at timestamp,
  detail jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_orders_operator_idx ON payment_orders (operator_id);
CREATE INDEX IF NOT EXISTS payment_orders_status_idx ON payment_orders (status);
