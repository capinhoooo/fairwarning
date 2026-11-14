// Integration tests delete rows; refuse any database that isn't a dedicated *_test one.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const db = new URL(process.env.DATABASE_URL ?? 'postgres://none/none').pathname.slice(1);
if (!db.endsWith('_test')) {
  throw new Error(`Tests wipe tables; set TEST_DATABASE_URL to a *_test database (got "${db}")`);
}
// the testnet .env must not leak into tests that pin mainnet ids
process.env.NEAR_NETWORK = '';
process.env.BASE_NETWORK = '';
