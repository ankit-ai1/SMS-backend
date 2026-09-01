import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { feeSetupRouter } from './feeSetup';
import { allocationsRouter } from './allocations';
import { paymentsRouter } from './payments';

/** Public Finance router — base doc §5.4 (categories, structures, discounts,
 * allocations, payments, refunds). Finance exposes no /internal endpoints. */
export function financeRouter(pools: TenantPoolManager): Router {
  const r = Router();
  r.use(feeSetupRouter(pools));
  r.use(allocationsRouter(pools));
  r.use(paymentsRouter(pools));
  return r;
}
