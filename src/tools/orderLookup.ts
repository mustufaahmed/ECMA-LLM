import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { env } from '../config/env';

export interface OrderFact {
  orderId: string;
  status: string;
  item: string;
  carrier: string | null;
  trackingNumber: string | null;
  estimatedDelivery: string | null;
  amount: string;
}

/** Accepts "12345", "ORD-12345", "ord-12345". */
export function parseTheLookOrderId(raw: string): number | null {
  const s = raw.trim().replace(/^ORD-?/i, '');
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/** Maps legacy "demo-user" to a real TheLook user id (default first user). */
export function resolveTheLookUserId(raw: string): number {
  if (raw === 'demo-user') {
    const d = env.DEMO_USER_ID.trim() || '1';
    return parseInt(d, 10) || 1;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : parseInt(env.DEMO_USER_ID.trim() || '1', 10) || 1;
}

function formatWhen(d: Date | null): string | null {
  if (!d) return null;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export async function lookupOrderById(orderIdRaw: string): Promise<OrderFact | null> {
  const orderId = parseTheLookOrderId(orderIdRaw);
  if (orderId === null) return null;

  const [order, sum] = await Promise.all([
    prisma.order.findUnique({
      where: { orderId },
      include: {
        items: {
          take: 30,
          include: { product: true },
          orderBy: { id: 'asc' },
        },
      },
    }),
    prisma.orderItem.aggregate({
      where: { orderId },
      _sum: { salePrice: true },
    }),
  ]);
  if (!order) return null;

  const names = order.items.map((i) => i.product.name);
  const itemSummary =
    names.length > 0
      ? names.join('; ')
      : `${order.numOfItem} line item(s) — expand catalog linkage if empty`;

  const total = sum._sum.salePrice ?? new Prisma.Decimal(0);

  return {
    orderId: String(order.orderId),
    status: order.status,
    item: itemSummary.slice(0, 2000),
    carrier: null,
    trackingNumber: null,
    estimatedDelivery: formatWhen(order.deliveredAt ?? order.shippedAt ?? order.createdAt),
    amount: `USD ${total.toFixed(2)}`,
  };
}

export async function listUserOrders(userIdRaw: string, limit = 5): Promise<OrderFact[]> {
  const userId = resolveTheLookUserId(userIdRaw);

  const orders = await prisma.order.findMany({
    where: { userId },
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: {
      items: {
        take: 8,
        include: { product: true },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (orders.length === 0) return [];

  const ids = orders.map((o) => o.orderId);
  const sums = await prisma.orderItem.groupBy({
    by: ['orderId'],
    where: { orderId: { in: ids } },
    _sum: { salePrice: true },
  });
  const sumByOrder = new Map(
    sums.map((s) => [s.orderId, s._sum.salePrice ?? new Prisma.Decimal(0)])
  );

  return orders.map((o) => {
    const names = o.items.map((i) => i.product.name);
    const itemSummary =
      names.length > 0
        ? names.join('; ') + (o.numOfItem > o.items.length ? ` (+${o.numOfItem - o.items.length} more)` : '')
        : `${o.numOfItem} line item(s)`;
    const total = sumByOrder.get(o.orderId) ?? new Prisma.Decimal(0);
    return {
      orderId: String(o.orderId),
      status: o.status,
      item: itemSummary.slice(0, 500),
      carrier: null,
      trackingNumber: null,
      estimatedDelivery: formatWhen(o.deliveredAt ?? o.shippedAt ?? o.createdAt),
      amount: `USD ${total.toFixed(2)}`,
    };
  });
}
