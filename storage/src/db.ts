import { PrismaClient } from '@prisma/client';

// STORAGE_LOG_BYTES also turns on Prisma query logging — the pair is what makes
// an egress regression visible: one line per statement, one line per response size.
export const prisma = new PrismaClient({
  log: process.env.STORAGE_LOG_BYTES ? ['query'] : [],
});
