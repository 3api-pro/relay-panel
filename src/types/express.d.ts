import 'express';

declare module 'express-serve-static-core' {
  interface Request {
    /** Multi-tenant: resolved from subdomain. Single-tenant: always 1. */
    tenantId?: number;

    /** Reseller admin (panel owner) — set by auth-admin middleware */
    resellerAdmin?: {
      id: number;
      tenantId: number;
      email: string;
      displayName: string | null;
    };

    /** End-user (reseller's customer) — set by auth-customer middleware */
    endUser?: {
      id: number;
      tenantId: number;
      email: string;
      groupName: string;
      quotaCents: number;
      usedQuotaCents: number;
    };

    /** End-user API token — set by auth-token middleware */
    endToken?: {
      id: number;
      tenantId: number;
      endUserId: number;
      remainQuotaCents: number;
      unlimitedQuota: boolean;
      allowedModels: string[] | null;
    };
  }
}
