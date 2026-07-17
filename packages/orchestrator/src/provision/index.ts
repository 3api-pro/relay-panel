import type { EngineKind, EngineLifecycle } from '@relay-panel/adapter-core';
import { Sub2apiLifecycle, type Sub2apiLifecycleOptions } from './sub2apiLifecycle.js';
import { NewapiLifecycle, type NewapiLifecycleOptions } from './newapiLifecycle.js';

export { Sub2apiLifecycle } from './sub2apiLifecycle.js';
export { NewapiLifecycle } from './newapiLifecycle.js';

/**
 * 按引擎选择生命周期后端。两个引擎的凭据形态不同（sub2api 有 jwt/pg 密钥，
 * new-api 只有 root 用户名+密码），故各自的 storeCredential 签名不同 —— 上层按 engine 分别提供。
 */
export interface LifecycleFactoryOptions {
  sub2api: Sub2apiLifecycleOptions;
  newapi: NewapiLifecycleOptions;
}

export function makeLifecycles(opts: LifecycleFactoryOptions): Record<EngineKind, EngineLifecycle> {
  return {
    sub2api: new Sub2apiLifecycle(opts.sub2api),
    newapi: new NewapiLifecycle(opts.newapi),
  };
}
