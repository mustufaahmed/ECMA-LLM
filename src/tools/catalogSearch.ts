import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';

export interface CatalogHit {
  sku: string;
  name: string;
  category: string;
  price: string;
  rating: number | null;
  stockLabel: string | null;
  specs: Record<string, unknown> | null;
  description: string | null;
}

interface CatalogQuery {
  category?: string;
  maxPrice?: number;
  minPrice?: number;
  keyword?: string;
  limit?: number;
}

export async function searchCatalog(q: CatalogQuery): Promise<CatalogHit[]> {
  const andParts: Prisma.ProductWhereInput[] = [{ inStock: true }];

  if (q.category) {
    andParts.push({
      OR: [
        { category: { contains: q.category } },
        { department: { contains: q.category } },
      ],
    });
  }

  if (q.maxPrice !== undefined || q.minPrice !== undefined) {
    const price: Prisma.DecimalFilter = {};
    if (q.maxPrice !== undefined) price.lte = q.maxPrice;
    if (q.minPrice !== undefined) price.gte = q.minPrice;
    andParts.push({ retailPrice: price });
  }

  if (q.keyword) {
    andParts.push({
      OR: [
        { name: { contains: q.keyword } },
        { description: { contains: q.keyword } },
        { brand: { contains: q.keyword } },
        { sku: { contains: q.keyword } },
      ],
    });
  }

  const rows = await prisma.product.findMany({
    where: { AND: andParts },
    take: q.limit ?? 5,
    orderBy: [{ rating: 'desc' }, { retailPrice: 'asc' }],
  });

  return rows.map((r) => ({
    sku: r.sku,
    name: r.name,
    category: r.category,
    price: `${r.currency} ${r.retailPrice.toString()}`,
    rating: r.rating,
    stockLabel: r.stockLabel,
    specs: (r.specs as Record<string, unknown>) || null,
    description: r.description,
  }));
}
