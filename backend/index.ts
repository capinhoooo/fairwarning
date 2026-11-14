import './dotenv.ts';

import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import FastifyCors from '@fastify/cors';
import FastifyRateLimit from '@fastify/rate-limit';
import { APP_PORT, CORS_ORIGINS, NEAR_NETWORK, ONECLICK_REFUND_TO } from './src/config/main-config.ts';
import { nearProvider } from './src/lib/fw/near.ts';

// Routes
import { exampletRoute } from './src/routes/exampleRoutes.ts';
import { fwRoutes } from './src/routes/fwRoutes.ts';
import { authRoutes } from './src/routes/authRoutes.ts';

// Workers
import { startErrorLogCleanupWorker } from './src/workers/errorLogCleanup.ts';
import { startBaseLogWatcher } from './src/workers/baseLogWatcher.ts';
import { startNearEventIndexer } from './src/workers/nearEventIndexer.ts';
import { startCaseDriver } from './src/workers/caseDriver.ts';
import { startPayoutRunner } from './src/workers/payoutRunner.ts';

console.log(
  '======================\n======================\nMY BACKEND SYSTEM STARTED!\n======================\n======================\n'
);

const fastify = Fastify({
  logger: false,
});

// set before any plugin so every route inherits it; clients get a code, never the error text
fastify.setErrorHandler((error: FastifyError, request, reply) => {
  const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
  const [code, message] =
    status === 500 ? ['INTERNAL_ERROR', 'Internal server error'] : status === 429 ? ['RATE_LIMITED', 'Too many requests'] : ['BAD_REQUEST', 'Bad request'];
  console.error(JSON.stringify({ event: 'unhandled_error', method: request.method, url: request.url, status, code: error.code, error: error.message, stack: status === 500 ? error.stack : undefined }));
  return reply.code(status).send({ success: false, error: { code, message }, data: null });
});

fastify.register(FastifyCors, {
  origin: CORS_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'token'],
});

// Every route here can trigger Base RPC, NEAR RPC or 1Click calls; cap per IP.
await fastify.register(FastifyRateLimit, { max: 120, timeWindow: '1 minute' });

// Health check endpoint
fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
  return reply.status(200).send({
    success: true,
    message: 'Hello there!',
    error: null,
    data: null,
  });
});

// Register routes with prefixes
// Example: fastify.register(adminRoutes, { prefix: '/admin' })
// Example: fastify.register(userRoutes, { prefix: '/user' })
fastify.register(exampletRoute, { prefix: '/example' });
fastify.register(fwRoutes, { prefix: '/fw' });
fastify.register(authRoutes, { prefix: '/auth' });

const start = async (): Promise<void> => {
  try {
    // 1Click rejects quotes whose refundTo account does not exist, with an opaque 400
    if (NEAR_NETWORK === 'mainnet') {
      await nearProvider.viewAccount({ accountId: ONECLICK_REFUND_TO }).catch(() => {
        throw new Error(`ONECLICK_REFUND_TO ${ONECLICK_REFUND_TO} does not exist on mainnet`);
      });
    }

    // Start workers
    startErrorLogCleanupWorker();
    startBaseLogWatcher();
    startNearEventIndexer();
    startCaseDriver();
    startPayoutRunner();

    await fastify.listen({
      port: APP_PORT,
      host: '0.0.0.0',
    });

    const address = fastify.server.address();
    const port = typeof address === 'object' && address ? address.port : APP_PORT;

    console.log(`Server started successfully on port ${port}`);
    console.log(`http://localhost:${port}`);
  } catch (error) {
    console.log('Error starting server: ', error);
    process.exit(1);
  }
};

start();
