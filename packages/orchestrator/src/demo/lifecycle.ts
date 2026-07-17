import type { EngineKind, EngineLifecycle, InstanceInfo, SiteSpec } from '@relay-panel/adapter-core';

/**
 * 演示模式生命周期（安全第一）：provision/upgrade/start/stop/destroy 全部**不碰 docker、
 * 不碰文件系统、不存任何真实凭据**。只返回合法的 InstanceInfo/版本，站点状态由
 * SitesService（handleProvision/handleLifecycleJob）按引擎无关流程写库——因此
 * “演示里开个站”经正常 provision 流程秒变 active，且 DemoAdapter 立即按 slug 供罐装数据。
 *
 * provision 时经 onStep 造几步假进度，让任务时间线在演示里好看。
 */

export type StepFn = (
  slug: string,
  step: string,
  status: 'start' | 'ok' | 'fail',
  detail?: string,
) => Promise<void>;

export interface NoopLifecycleOptions {
  engine: EngineKind;
  /** provision 步骤汇聚点（index.ts 接 lifecycleStepSink，运行期由当前 job 落库） */
  onStep?: StepFn;
}

/** 演示 provision 的假进度步骤（纯展示，无真实副作用） */
const DEMO_PROVISION_STEPS = ['Render config', 'Start containers', 'Health check', 'Init admin'] as const;

export class NoopLifecycle implements EngineLifecycle {
  readonly engine: EngineKind;
  private readonly onStep?: StepFn;

  constructor(opts: NoopLifecycleOptions) {
    this.engine = opts.engine;
    if (opts.onStep) this.onStep = opts.onStep;
  }

  private async step(slug: string, name: string): Promise<void> {
    await this.onStep?.(slug, name, 'start');
    // 演示：无真实工作，直接标成功
    await this.onStep?.(slug, name, 'ok');
  }

  async provision(spec: SiteSpec): Promise<InstanceInfo> {
    for (const s of DEMO_PROVISION_STEPS) await this.step(spec.slug, s);
    return {
      siteSlug: spec.slug,
      engine: this.engine,
      version: spec.version,
      baseUrl: `http://demo.invalid/${spec.slug}`,
      dataDir: '',
      composeProject: '',
      // 演示凭据引用：DemoAdapter 忽略凭据，绝不解析，故此处只是无害占位串
      credentialRef: `demo:${spec.slug}`,
    };
  }

  async upgrade(inst: InstanceInfo, toVersion: string): Promise<InstanceInfo> {
    if (toVersion === 'latest') throw new Error('version must be pinned');
    return { ...inst, version: toVersion };
  }

  async start(_inst: InstanceInfo): Promise<void> {
    // 无副作用：状态由 SitesService 写为 active
  }

  async stop(_inst: InstanceInfo): Promise<void> {
    // 无副作用：状态由 SitesService 写为 stopped
  }

  async destroy(_inst: InstanceInfo, _opts: { keepData: boolean }): Promise<void> {
    // 无副作用：状态由 SitesService 写为 destroyed
  }
}
