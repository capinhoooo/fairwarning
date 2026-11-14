// NEP-413 nonce lifecycle: account validation and the 5-minute expiry, checked before any signature work.
import { afterAll, describe, expect, setSystemTime, test } from 'bun:test';
import Fastify from 'fastify';

const { prismaQuery } = await import('../src/lib/prisma.ts');
const { authRoutes } = await import('../src/routes/authRoutes.ts');

const app = Fastify();
app.register(authRoutes, { prefix: '/auth' });
const ACCOUNT = 'nonce-ttl.test.near';

afterAll(async () => {
  setSystemTime();
  await prismaQuery.user.deleteMany({ where: { walletAddress: ACCOUNT } });
  await app.close();
});

describe('auth nonce', () => {
  test('rejects a malformed account id', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { accountId: 'Not A Near Account!' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ACCOUNT');
  });

  test('a nonce older than 5 minutes is refused and cleared', async () => {
    const t0 = new Date('2026-11-12T00:00:00Z');
    setSystemTime(t0);
    const issued = await app.inject({ method: 'POST', url: '/auth/nonce', payload: { accountId: ACCOUNT } });
    expect(issued.statusCode).toBe(200);

    setSystemTime(new Date(t0.getTime() + 5 * 60 * 1000 + 1));
    const late = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { accountId: ACCOUNT, publicKey: 'ed25519:11111111111111111111111111111111', signature: 'AA==' }
    });
    expect(late.statusCode).toBe(401);
    expect(late.json().error.code).toBe('NONCE_EXPIRED');
    const user = await prismaQuery.user.findUnique({ where: { walletAddress: ACCOUNT } });
    expect(user?.nonce).toBeNull();
  });
});
