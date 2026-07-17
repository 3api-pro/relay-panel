import type { EngineAdapter, EngineKind, EngineLifecycle } from '@relay-panel/adapter-core';
import type { Notifier } from '../server.js';
import { DemoAdapter } from './adapter.js';
import { NoopLifecycle, type StepFn } from './lifecycle.js';

export { DemoAdapter } from './adapter.js';
export { NoopLifecycle } from './lifecycle.js';
export { registerDemoRoutes } from './routes.js';
export { seedDemo, DEMO_EMAIL, DEMO_PASSWORD, DEMO_NOTE } from './seed.js';

/**
 * 演示装配（index.ts 与 test/demo.test.ts 共用，保证测的就是线上跑的那套接线）：
 * 两引擎都用 DemoAdapter（罐装数据）+ NoopLifecycle（不碰 docker），gateway=null、notifier=noop。
 */

export function makeDemoAdapters(): Record<EngineKind, EngineAdapter> {
  return {
    sub2api: new DemoAdapter('sub2api'),
    newapi: new DemoAdapter('newapi'),
  };
}

export function makeDemoLifecycles(onStep?: StepFn): Record<EngineKind, EngineLifecycle> {
  return {
    sub2api: new NoopLifecycle({ engine: 'sub2api', ...(onStep ? { onStep } : {}) }),
    newapi: new NoopLifecycle({ engine: 'newapi', ...(onStep ? { onStep } : {}) }),
  };
}

/** 演示通知器：吞掉一切事件（不外发 webhook） */
export const demoNotifier: Notifier = {
  async fire() {
    /* noop：演示环境不外发通知 */
  },
};
