import { PrismaClient } from '../../prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

// short messages: no query or schema detail if an error text ever reaches a client
export const prismaQuery = new PrismaClient({ adapter, errorFormat: 'minimal' });
