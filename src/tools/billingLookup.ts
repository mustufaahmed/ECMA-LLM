import { prisma } from '../db/prisma';
import { parseTheLookOrderId, resolveTheLookUserId } from './orderLookup';

export interface BillingFact {
  userId: string;
  orderId: string | null;
  lastChargeAmount: string;
  chargeDate: string;
  duplicateDetected: boolean;
  refundRef: string | null;
  refundEta: string | null;
  refundStatus: string | null;
}

function toFact(b: {
  userId: string;
  orderId: number | null;
  lastChargeAmount: { toString(): string };
  chargeDate: Date;
  duplicateDetected: boolean;
  refundRef: string | null;
  refundEta: string | null;
  refundStatus: string | null;
}): BillingFact {
  return {
    userId: b.userId,
    orderId: b.orderId !== null ? String(b.orderId) : null,
    lastChargeAmount: `$${b.lastChargeAmount.toString()}`,
    chargeDate: b.chargeDate.toISOString().slice(0, 10),
    duplicateDetected: b.duplicateDetected,
    refundRef: b.refundRef,
    refundEta: b.refundEta,
    refundStatus: b.refundStatus,
  };
}

export async function latestBillingForUser(userId: string): Promise<BillingFact | null> {
  const uid = String(resolveTheLookUserId(userId));
  const b = await prisma.billingRecord.findFirst({
    where: { userId: uid },
    orderBy: { createdAt: 'desc' },
  });
  if (!b) return null;
  return toFact(b);
}

export async function billingForOrder(orderIdRaw: string): Promise<BillingFact | null> {
  const orderId = parseTheLookOrderId(orderIdRaw);
  if (orderId === null) return null;

  const b = await prisma.billingRecord.findFirst({
    where: { orderId },
    orderBy: { createdAt: 'desc' },
  });
  if (!b) return null;
  return toFact(b);
}
