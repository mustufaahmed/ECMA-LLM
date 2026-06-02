/**
 * Load TheLook eCommerce CSVs from ./dataset into MySQL (Prisma schema).
 *
 * Usage:
 *   npx tsx prisma/importThelookDataset.ts
 *   npx tsx prisma/importThelookDataset.ts --events   # also load shop_events (large, slow)
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { parse as parseCsvStream } from 'csv-parse';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const DATASET_DIR = path.join(__dirname, '..', 'dataset');
const BATCH = 2500;

const FILES = {
  centers: 'thelook_ecommerce.distribution_centers.csv',
  users: 'thelook_ecommerce.users.csv',
  products: 'thelook_ecommerce.products.csv',
  orders: 'thelook_ecommerce.orders.csv',
  orderItems: 'thelook_ecommerce.order_items.csv',
  inventory: 'thelook_ecommerce.inventory_items.csv',
  events: 'thelook_ecommerce.events.csv',
} as const;

function requireFile(name: keyof typeof FILES): string {
  const f = path.join(DATASET_DIR, FILES[name]);
  if (!fs.existsSync(f)) {
    throw new Error(`Missing dataset file: ${f}`);
  }
  return f;
}

function parseUtcDate(raw: string | undefined): Date | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const s = String(raw).trim().replace(' UTC', 'Z');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dec(raw: string | undefined, fallback = '0'): Prisma.Decimal {
  const s = raw === undefined || raw === '' ? fallback : String(raw).trim();
  return new Prisma.Decimal(s);
}

function int(raw: string | undefined): number {
  return parseInt(String(raw ?? '').trim(), 10);
}

function loadCsvRecords(filePath: string): Record<string, string>[] {
  const buf = fs.readFileSync(filePath, 'utf-8');
  return parse(buf, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];
}

async function flushBatches<T extends Record<string, unknown>>(
  rows: T[],
  batchSize: number,
  fn: (chunk: T[]) => Promise<void>
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    await fn(chunk);
  }
}

async function importFromStreamingCsv(
  filePath: string,
  batchSize: number,
  onBatch: (rows: Record<string, string>[]) => Promise<void>
): Promise<void> {
  const parser = fs.createReadStream(filePath).pipe(
    parseCsvStream({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    })
  );

  let batch: Record<string, string>[] = [];
  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    batch.push(row);
    if (batch.length >= batchSize) {
      await onBatch(batch);
      batch = [];
      process.stdout.write('.');
    }
  }
  if (batch.length) await onBatch(batch);
  process.stdout.write('\n');
}

async function main() {
  const withEvents = process.argv.includes('--events');

  console.log('Clearing TheLook tables (persona / conversations preserved)...');
  await prisma.$transaction([
    prisma.orderItem.deleteMany(),
    prisma.billingRecord.deleteMany(),
    prisma.order.deleteMany(),
    prisma.inventoryItem.deleteMany(),
    prisma.product.deleteMany(),
    prisma.user.deleteMany(),
    prisma.distributionCenter.deleteMany(),
    prisma.shopEvent.deleteMany(),
  ]);

  console.log('Distribution centers...');
  const dcRows = loadCsvRecords(requireFile('centers'));
  await prisma.distributionCenter.createMany({
    data: dcRows.map((r) => ({
      id: int(r.id),
      name: r.name ?? '',
      latitude: r.latitude ? dec(r.latitude) : null,
      longitude: r.longitude ? dec(r.longitude) : null,
    })),
  });

  console.log(`Users (${loadCsvRecords(requireFile('users')).length} rows)...`);
  const userRows = loadCsvRecords(requireFile('users'));
  await flushBatches(userRows, BATCH, async (chunk) => {
    await prisma.user.createMany({
      data: chunk.map((r) => ({
        id: int(r.id),
        firstName: r.first_name ?? '',
        lastName: r.last_name ?? '',
        email: r.email ?? '',
        age: r.age ? int(r.age) : null,
        gender: r.gender || null,
        state: r.state || null,
        streetAddress: r.street_address || null,
        postalCode: r.postal_code || null,
        city: r.city || null,
        country: r.country || null,
        latitude: r.latitude ? dec(r.latitude) : null,
        longitude: r.longitude ? dec(r.longitude) : null,
        trafficSource: r.traffic_source || null,
        createdAt: parseUtcDate(r.created_at) ?? new Date(0),
      })),
    });
  });

  console.log(`Products (${loadCsvRecords(requireFile('products')).length} rows)...`);
  const productRows = loadCsvRecords(requireFile('products'));
  await flushBatches(productRows, BATCH, async (chunk) => {
    await prisma.product.createMany({
      data: chunk.map((r) => {
        const name = r.name ?? '';
        const brand = r.brand ?? '';
        const category = r.category ?? '';
        const department = r.department ?? '';
        return {
          id: int(r.id),
          cost: dec(r.cost),
          category,
          name,
          brand,
          retailPrice: dec(r.retail_price),
          department,
          sku: (r.sku ?? '').slice(0, 64),
          distributionCenterId: r.distribution_center_id ? int(r.distribution_center_id) : null,
          inStock: true,
          stockLabel: 'In stock',
          rating: null,
          specs: { department, category, brand } as Prisma.InputJsonValue,
          description: [brand, category, name].filter(Boolean).join(' · ').slice(0, 2000),
          currency: 'USD',
        };
      }),
    });
  });

  console.log(`Orders (${loadCsvRecords(requireFile('orders')).length} rows)...`);
  const orderRows = loadCsvRecords(requireFile('orders'));
  await flushBatches(orderRows, BATCH, async (chunk) => {
    await prisma.order.createMany({
      data: chunk.map((r) => ({
        orderId: int(r.order_id),
        userId: int(r.user_id),
        status: r.status ?? 'Unknown',
        gender: r.gender || null,
        createdAt: parseUtcDate(r.created_at) ?? new Date(0),
        returnedAt: parseUtcDate(r.returned_at),
        shippedAt: parseUtcDate(r.shipped_at),
        deliveredAt: parseUtcDate(r.delivered_at),
        numOfItem: int(r.num_of_item),
      })),
    });
  });

  console.log('Order items (streaming)...');
  const oiPath = requireFile('orderItems');
  let oiCount = 0;
  await importFromStreamingCsv(oiPath, BATCH, async (chunk) => {
    await prisma.orderItem.createMany({
      data: chunk.map((r) => ({
        id: int(r.id),
        orderId: int(r.order_id),
        userId: int(r.user_id),
        productId: int(r.product_id),
        inventoryItemId: r.inventory_item_id ? int(r.inventory_item_id) : null,
        status: r.status ?? 'Unknown',
        createdAt: parseUtcDate(r.created_at) ?? new Date(0),
        shippedAt: parseUtcDate(r.shipped_at),
        deliveredAt: parseUtcDate(r.delivered_at),
        returnedAt: parseUtcDate(r.returned_at),
        salePrice: dec(r.sale_price),
      })),
    });
    oiCount += chunk.length;
  });
  console.log(`  inserted ${oiCount} order_items`);

  console.log('Inventory items (streaming)...');
  const invPath = requireFile('inventory');
  let invCount = 0;
  await importFromStreamingCsv(invPath, BATCH, async (chunk) => {
    await prisma.inventoryItem.createMany({
      data: chunk.map((r) => ({
        id: int(r.id),
        productId: int(r.product_id),
        createdAt: parseUtcDate(r.created_at) ?? new Date(0),
        soldAt: parseUtcDate(r.sold_at),
        cost: dec(r.cost),
        productCategory: r.product_category ?? '',
        productName: r.product_name ?? '',
        productBrand: r.product_brand ?? '',
        productRetailPrice: dec(r.product_retail_price),
        productDepartment: r.product_department ?? '',
        productSku: (r.product_sku ?? '').slice(0, 64),
        productDistributionCenterId: int(r.product_distribution_center_id),
      })),
    });
    invCount += chunk.length;
  });
  console.log(`  inserted ${invCount} inventory_items`);

  console.log('Synthesizing billing_records from orders + line totals...');
  const [orders, sums] = await Promise.all([
    prisma.order.findMany({
      select: { orderId: true, userId: true, createdAt: true, status: true },
    }),
    prisma.orderItem.groupBy({
      by: ['orderId'],
      _sum: { salePrice: true },
    }),
  ]);
  const sumByOrder = new Map<number, Prisma.Decimal>();
  for (const s of sums) {
    sumByOrder.set(s.orderId, s._sum.salePrice ?? new Prisma.Decimal(0));
  }

  const billRows = orders.map((o) => ({
    userId: String(o.userId),
    orderId: o.orderId,
    lastChargeAmount: sumByOrder.get(o.orderId) ?? new Prisma.Decimal(0),
    chargeDate: o.createdAt,
    duplicateDetected: false,
    refundRef: null,
    refundEta: o.status === 'Returned' ? 'Per return policy' : null,
    refundStatus: o.status === 'Returned' ? 'returned' : null,
  }));

  await flushBatches(billRows, BATCH, async (chunk) => {
    await prisma.billingRecord.createMany({ data: chunk });
  });

  if (withEvents) {
    console.log('Shop events (streaming, large)...');
    const evPath = requireFile('events');
    let evCount = 0;
    await importFromStreamingCsv(evPath, BATCH, async (chunk) => {
      await prisma.shopEvent.createMany({
        data: chunk.map((r) => ({
          id: int(r.id),
          userId: int(r.user_id),
          sequenceNumber: int(r.sequence_number),
          sessionId: (r.session_id ?? '').slice(0, 64),
          createdAt: parseUtcDate(r.created_at) ?? new Date(0),
          ipAddress: r.ip_address || null,
          city: r.city || null,
          state: r.state || null,
          postalCode: r.postal_code || null,
          browser: r.browser || null,
          trafficSource: r.traffic_source || null,
          uri: r.uri ? r.uri.slice(0, 512) : null,
          eventType: r.event_type ?? 'unknown',
        })),
      });
      evCount += chunk.length;
    });
    console.log(`  inserted ${evCount} shop_events`);
  } else {
    console.log('Skipping shop_events (pass --events to import).');
  }

  console.log('TheLook dataset import complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
