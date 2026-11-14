import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { verifyMessage } from 'near-api-js/nep413';
import { prismaQuery } from '../lib/prisma.ts';
import { nearProvider } from '../lib/fw/near.ts';
import { JWT_EXPIRES_IN, JWT_SECRET } from '../config/main-config.ts';
import { handleError } from '../utils/errorHandler.ts';
import { validateRequiredFields } from '../utils/validationUtils.ts';

// NEP-413 sign-in for protocol owners. The shared pattern lives in near/v2/14_stack_integration.md.
const RECIPIENT = 'fairwarning.app';
const MESSAGE = 'Sign in to Fair Warning';
const NONCE_TTL_MS = 5 * 60 * 1000;
const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export const authRoutes: FastifyPluginCallback = (app: FastifyInstance, _opts, done) => {
  app.post('/nonce', async (request: FastifyRequest<{ Body: { accountId: string } }>, reply: FastifyReply) => {
    const valid = await validateRequiredFields(request.body as Record<string, unknown>, ['accountId'], reply);
    if (valid !== true) return;
    if (!NEAR_ACCOUNT.test(request.body.accountId)) return handleError(reply, 400, 'Invalid NEAR account', 'INVALID_ACCOUNT');
    const nonce = randomBytes(32).toString('base64');
    const nonceIssuedAt = new Date();
    await prismaQuery.user.upsert({
      where: { walletAddress: request.body.accountId },
      create: { walletAddress: request.body.accountId, nonce, nonceIssuedAt },
      update: { nonce, nonceIssuedAt },
    });
    return reply.code(200).send({ success: true, error: null, data: { nonce, recipient: RECIPIENT, message: MESSAGE } });
  });

  app.post(
    '/verify',
    async (request: FastifyRequest<{ Body: { accountId: string; publicKey: string; signature: string } }>, reply: FastifyReply) => {
      const valid = await validateRequiredFields(request.body as Record<string, unknown>, ['accountId', 'publicKey', 'signature'], reply);
      if (valid !== true) return;
      const { accountId, publicKey, signature } = request.body;
      const user = await prismaQuery.user.findUnique({ where: { walletAddress: accountId } });
      if (!user?.nonce) return handleError(reply, 401, 'Request a nonce first', 'NONCE_MISSING');
      if (!user.nonceIssuedAt || Date.now() - user.nonceIssuedAt.getTime() > NONCE_TTL_MS) {
        await prismaQuery.user.update({ where: { id: user.id }, data: { nonce: null, nonceIssuedAt: null } });
        return handleError(reply, 401, 'Sign-in request expired, request a new nonce', 'NONCE_EXPIRED');
      }
      try {
        // checks the signature and that publicKey is a FullAccess key of accountId
        await verifyMessage({
          signerAccountId: accountId,
          signerPublicKey: publicKey,
          payload: { message: MESSAGE, recipient: RECIPIENT, nonce: Buffer.from(user.nonce, 'base64') },
          signature: Buffer.from(signature, 'base64'),
          provider: nearProvider,
        });
      } catch (error) {
        return handleError(reply, 401, 'Signature verification failed', 'BAD_SIGNATURE', error as Error);
      }
      await prismaQuery.user.update({ where: { id: user.id }, data: { nonce: null, nonceIssuedAt: null, lastSignIn: new Date() } });
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] });
      return reply.code(200).send({ success: true, error: null, data: { token, accountId } });
    },
  );

  done();
};
