/**
 * Centralized configuration for the application
 * All commonly used environment variables should be defined here
 */

// Validate required environment variables on startup
const requiredEnvVars: string[] = [
  'DATABASE_URL',
  'JWT_SECRET',
  'BASE_RPC_URL',
  'FW_CONTRACT_ID',
  'WATCHER_ACCOUNT_ID',
  'WATCHER_PRIVATE_KEY',
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`FATAL: Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// App Configuration
export const APP_PORT: number = Number(process.env.APP_PORT) || 3700;
export const NODE_ENV: string = process.env.NODE_ENV || 'development';
export const IS_DEV: boolean = NODE_ENV === 'development';
export const IS_PROD: boolean = NODE_ENV === 'production';

// Database
export const DATABASE_URL: string = process.env.DATABASE_URL as string;

// Authentication
export const JWT_SECRET: string = process.env.JWT_SECRET as string;
export const JWT_EXPIRES_IN: string = process.env.JWT_EXPIRES_IN || '7d';

// Error Log Configuration
export const ERROR_LOG_MAX_RECORDS: number = 10000;
export const ERROR_LOG_CLEANUP_INTERVAL: string = '0 * * * *'; // Every hour

// Fair Warning: Base side
export const BASE_RPC_URL: string = process.env.BASE_RPC_URL as string;
export const BASE_NETWORK: 'base' | 'baseSepolia' = process.env.BASE_NETWORK === 'baseSepolia' ? 'baseSepolia' : 'base';
// starting eth_getLogs span; the watcher halves it on provider range errors (sepolia.base.org caps at 200)
export const BASE_LOG_CHUNK: bigint = BigInt(process.env.BASE_LOG_CHUNK || 200);
// Other EVM chains v1.signer reads, as JSON {"Arbitrum":"https://..."}; testnets when BASE_NETWORK is baseSepolia
export const EVM_RPC_URLS: Record<string, string> = JSON.parse(process.env.EVM_RPC_URLS || '{}');
// deepest history a registration may make the shared watcher re-read, in blocks behind the safe head
export const MAX_BACKFILL_BLOCKS: bigint = BigInt(process.env.MAX_BACKFILL_BLOCKS || 1_000_000);

// Fair Warning: NEAR side (testnet v1.signer-prod.testnet reads Base Sepolia; mainnet v1.signer reads Base)
export const NEAR_NETWORK: 'mainnet' | 'testnet' = process.env.NEAR_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
export const NEAR_RPC_URL: string =
  process.env.NEAR_RPC_URL || (NEAR_NETWORK === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com');
export const NEARDATA_URL: string = process.env.NEARDATA_URL || `https://${NEAR_NETWORK}.neardata.xyz`;
export const FW_CONTRACT_ID: string = process.env.FW_CONTRACT_ID as string;
export const MPC_CONTRACT_ID: string =
  process.env.MPC_CONTRACT_ID || (NEAR_NETWORK === 'mainnet' ? 'v1.signer' : 'v1.signer-prod.testnet');
export const USDC_CONTRACT_ID: string =
  process.env.USDC_CONTRACT_ID || '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const WATCHER_ACCOUNT_ID: string = process.env.WATCHER_ACCOUNT_ID as string;
export const WATCHER_PRIVATE_KEY: string = process.env.WATCHER_PRIVATE_KEY as string;
export const REPORT_GAS_TGAS: bigint = 150n;
// off lets a human watcher be the first reporter (demo); defend and finalize still run
export const AUTO_REPORT: boolean = process.env.AUTO_REPORT !== 'false';
export const FASTNEAR_API_KEY: string = process.env.FASTNEAR_API_KEY || '';

// Event history (FastNEAR tx API). Live case state comes from get_case views, not from here.
export const NEAR_TX_API_URL: string = NEAR_NETWORK === 'mainnet' ? 'https://tx.main.fastnear.com' : 'https://tx.test.fastnear.com';
export const INDEXER_START_HEIGHT: number = Number(process.env.INDEXER_START_HEIGHT || 0); // fw deploy block
// covers the 200-block MPC yield so every receipt of a tx has executed before it is read
export const INDEXER_FINALITY_LAG: number = 250;
export const INDEXER_MAX_SPAN: number = 2000;

// HTTP
export const CORS_ORIGINS: string[] = (process.env.CORS_ORIGINS || 'http://localhost:3200').split(',');

// Fair Warning: payouts through NEAR Intents 1Click (mainnet only)
export const ONECLICK_API_URL: string = process.env.ONECLICK_API_URL || 'https://1click.chaindefuser.com';
export const ONECLICK_API_KEY: string = process.env.ONECLICK_API_KEY || '';
export const ONECLICK_REFUND_TO: string = process.env.ONECLICK_REFUND_TO || WATCHER_ACCOUNT_ID;
export const APP_FEE_BPS: number = Number(process.env.APP_FEE_BPS || 0);

// Export all as default object for convenience
export default {
  APP_PORT,
  NODE_ENV,
  IS_DEV,
  IS_PROD,
  DATABASE_URL,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  ERROR_LOG_MAX_RECORDS,
  ERROR_LOG_CLEANUP_INTERVAL,
};
