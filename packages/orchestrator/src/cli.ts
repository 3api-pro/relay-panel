import { runSiteCommand } from './cli/siteCmds.js';
import { runAdminCommand } from './cli/adminCmds.js';
import { runBackupCommand } from './cli/backupCmds.js';

/**
 * CLI 薄分发器（规格 §10）：按子命令分发到 cli/ 各模块。
 *   站点生命周期: provision | verify | destroy          （cli/siteCmds.ts）
 *   管理:         create-admin | import-registry | import-templates（cli/adminCmds.ts）
 *   备份/接管:    backup | restore | adopt               （cli/backupCmds.ts）
 */

const SITE_CMDS = new Set(['provision', 'verify', 'destroy']);
const ADMIN_CMDS = new Set(['create-admin', 'import-registry', 'import-templates']);
const BACKUP_CMDS = new Set(['backup', 'restore', 'adopt']);

function usage(): void {
  console.log(
    [
      'usage: cli.ts <command> [...args]',
      '',
      '站点生命周期:',
      '  provision <slug> <version> <port> [--engine sub2api|newapi]',
      '  verify <slug> <port>',
      '  destroy <slug> <port> [--engine sub2api|newapi] [--keep-data]',
      '',
      '管理:',
      '  create-admin <email>            (密码取 env RP_NEW_PASSWORD，缺省生成并打印一次)',
      '  import-registry <path>          (registry.json → DB，幂等)',
      '  import-templates <path>         (渠道市场模板 JSON → DB，按 key 幂等)',
      '',
      '备份/接管:',
      '  backup [--out <dir>]',
      '  restore --db <dump>',
      '  adopt <slug> <baseUrl> --engine <e> --credential-ref <ref> [--label <label>] [--force]',
    ].join('\n'),
  );
}

const argv = process.argv.slice(2);
const cmd = argv[0];

let code = 1;
if (cmd !== undefined && SITE_CMDS.has(cmd)) {
  code = await runSiteCommand(argv);
} else if (cmd !== undefined && ADMIN_CMDS.has(cmd)) {
  code = await runAdminCommand(argv);
} else if (cmd !== undefined && BACKUP_CMDS.has(cmd)) {
  code = await runBackupCommand(argv);
} else {
  usage();
}
process.exit(code);
