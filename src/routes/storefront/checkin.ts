/**
 * Daily check-in storefront routes (P1 #15).
 *
 * All routes require an authed end_user session. Mounted under
 * /storefront — see storefront/index.ts.
 *
 *   GET  /storefront/checkin/status   — what reward will I get today?
 *   POST /storefront/checkin           — claim today's reward
 *   GET  /storefront/checkin/history   — last 30 days
 */
import { Router, Request, Response } from 'express';
import { authCustomer } from '../../middleware/auth-customer';
import {
  doCheckIn,
  previewToday,
  listRecentCheckins,
} from '../../services/checkin';
import { logger } from '../../services/logger';

export const storefrontCheckinRouter = Router();

storefrontCheckinRouter.get('/checkin/status', authCustomer, async (req: Request, res: Response) => {
  const u = req.endUser!;
  try {
    const out = await previewToday(u.tenantId, u.id);
    res.json({
      enabled: out.config.enabled,
      already_checked_in: out.already_checked_in,
      current_streak: out.current_streak,
      next_reward_tokens: out.next_reward,
      next_is_bonus: out.next_is_bonus,
      config: {
        reward_tokens_per_day: out.config.reward_tokens_per_day,
        streak_bonus_tokens: out.config.streak_bonus_tokens,
        bonus_every_n_days: out.config.bonus_every_n_days,
      },
    });
  } catch (err: any) {
    logger.error({ err: err.message, endUserId: u.id }, 'checkin:status:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

storefrontCheckinRouter.post('/checkin', authCustomer, async (req: Request, res: Response) => {
  const u = req.endUser!;
  try {
    const out = await doCheckIn({ tenantId: u.tenantId, endUserId: u.id });
    if (out.kind === 'disabled') {
      res.status(403).json({
        error: {
          type: 'feature_disabled',
          message: 'Check-in is disabled for this storefront.',
        },
      });
      return;
    }
    if (out.kind === 'no_subscription') {
      res.status(402).json({
        error: {
          type: 'no_active_subscription',
          message: 'Please purchase a plan to claim check-in rewards.',
        },
      });
      return;
    }
    if (out.kind === 'already_checked_in') {
      res.status(409).json({
        error: {
          type: 'already_checked_in',
          message: 'You have already checked in today. Come back tomorrow.',
        },
        streak_days: out.streak_days,
      });
      return;
    }
    res.status(200).json({
      ok: true,
      reward_tokens: out.reward_tokens,
      streak_days: out.streak_days,
      is_bonus_day: out.is_bonus_day,
      subscription_id: out.subscription_id,
      remaining_tokens: out.remaining_tokens,
    });
  } catch (err: any) {
    logger.error({ err: err.message, endUserId: u.id }, 'checkin:post:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});

storefrontCheckinRouter.get('/checkin/history', authCustomer, async (req: Request, res: Response) => {
  const u = req.endUser!;
  try {
    const rows = await listRecentCheckins(u.id);
    res.json({ data: rows });
  } catch (err: any) {
    logger.error({ err: err.message, endUserId: u.id }, 'checkin:history:error');
    res.status(500).json({ error: { type: 'internal_error', message: 'Internal error' } });
  }
});
