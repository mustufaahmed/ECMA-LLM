/**
 * Seeds persona + app defaults. Structured commerce data comes from
 * `npm run import:dataset` (TheLook CSVs in /dataset).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding persona...');
  await prisma.personaSpec.upsert({
    where: { personaId: 'shopmax-default' },
    update: {},
    create: {
      personaId: 'shopmax-default',
      brand: 'ShopMax',
      role: 'Customer Support Assistant',
      tone: 'Warm, professional, never robotic. Direct empathy, no corporate jargon.',
      rules: {
        maxSentencesPerPoint: 3,
        forbiddenPhrases: ['I apologize for any inconvenience'],
        mustUseRetrievedFactsOnly: true,
      },
      closingLine: 'Is there anything else I can help you with?',
    },
  });

  console.log('Seed complete (use npm run import:dataset to load TheLook CSVs).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
