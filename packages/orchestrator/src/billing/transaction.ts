import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { operators } from '../db/schema.js';
import { ApiError } from '../auth/rbac.js';

/** Database lock, shared by payments and manual changes; works across processes and restarts. */
export async function withBillingTransaction<T>(db: Db, operatorId: number, run: (tx: Db) => Promise<T>): Promise<T> {
  return db.orm.transaction(async orm => {
    const owner = await orm.select({ id: operators.id }).from(operators)
      .where(eq(operators.id, operatorId)).for('update');
    if (!owner.length) throw new ApiError(404, '操作员不存在');
    // Callers use the transactional ORM only, never Db.query/exec (which use a separate connection).
    const tx: Db = { ...db, orm,
      async query() { throw new Error('Use the transactional ORM'); },
      async exec() { throw new Error('Use the transactional ORM'); },
      async close() { throw new Error('Transaction does not own the connection'); },
    };
    return run(tx);
  });
}
