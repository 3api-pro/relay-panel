import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface ComposeRef {
  project: string;
  file: string;
  envFile: string;
}

/**
 * 生产（Linux）直接用宿主 docker。
 * Windows 开发机上宿主 Docker 是 Windows 容器模式，设 RP_DOCKER_VIA_WSL=1
 * 走 WSL 内的 docker（`wsl -e docker ...`），Windows 路径自动翻译为 /mnt/<drive>/。
 */
const viaWsl = process.env.RP_DOCKER_VIA_WSL === '1';

function toDockerPath(p: string): string {
  if (!viaWsl) return p;
  const m = p.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!m) return p;
  return `/mnt/${m[1]!.toLowerCase()}/${m[2]!.replaceAll('\\', '/')}`;
}

async function compose(ref: ComposeRef, args: string[]): Promise<string> {
  const composeArgs = [
    'compose',
    '-p',
    ref.project,
    '-f',
    toDockerPath(ref.file),
    '--env-file',
    toDockerPath(ref.envFile),
    ...args,
  ];
  const [cmd, argv] = viaWsl
    ? (['wsl', ['-e', 'docker', ...composeArgs]] as const)
    : (['docker', composeArgs] as const);
  const { stdout } = await exec(cmd, [...argv], { maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

export const dockerCompose = {
  up: (ref: ComposeRef) => compose(ref, ['up', '-d', '--wait', '--wait-timeout', '300']),
  down: (ref: ComposeRef, opts: { removeVolumes: boolean }) =>
    compose(ref, ['down', ...(opts.removeVolumes ? ['-v'] : [])]),
  stop: (ref: ComposeRef) => compose(ref, ['stop']),
  start: (ref: ComposeRef) => compose(ref, ['start']),
  ps: (ref: ComposeRef) => compose(ref, ['ps', '--format', 'json']),
  pull: (ref: ComposeRef) => compose(ref, ['pull']),
};
