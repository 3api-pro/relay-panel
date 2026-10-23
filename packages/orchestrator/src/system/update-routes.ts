import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, requireRoot } from '../auth/rbac.js';
import { updaterFromChannel } from './update-channel.js';
import type { PanelUpdater } from './update-types.js';

export interface UpdateMaintenance { active: boolean; allowStatus?: boolean; requests: Set<string> }
const inputSchema = z.object({ target: z.string().regex(/^\d+\.\d+\.\d+$/).max(64), confirmed: z.literal(true) }).strict();
export function registerUpdateRoutes(app: FastifyInstance, updater: PanelUpdater = updaterFromChannel(null)): void {
  app.get('/api/system/update', async req => {
    if (!req.ctx) throw new ApiError(401, '请先登录');
    requireRoot(req.ctx);
    return updater.status();
  });
  app.post('/api/system/update', async (req, reply) => {
    if (!req.ctx) throw new ApiError(401, '请先登录');
    requireRoot(req.ctx);
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, '请确认目标稳定版本与更新操作');
    const result = await updater.start(parsed.data.target, req.ctx.email);
    return reply.code(202).send(result);
  });
}
