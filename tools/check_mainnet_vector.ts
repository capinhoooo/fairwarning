import { createPublicClient, http } from 'viem'
import { base } from 'viem/chains'
import { expectedPayloadHash, toLogInput } from '../backend/src/lib/fw/mpcPayload.ts'

// v1.signer signed this payload_hash for log 5 of a real Base tx (NEAR receipt on mainnet, 2026-10-25)
const MPC_SAID = '0xfb8f25f6b7bad4ff91af67a7e43f06aaa6653923c8fa6e39d741f220418bbfc5'

const client = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') })
const r = await client.getTransactionReceipt({ hash: '0x702705ea9058b4a16a8907d06075de2ce65087da8061f93655e9a056e60a9301' })
const log = toLogInput(r.logs.find((l) => l.logIndex === 5)!)
const got = expectedPayloadHash(log, 'Base', 'Finalized', true)
console.log('computed:', got)
console.log('mpc_said:', MPC_SAID)
console.log('single-log Safe (what fw.report asks for):', expectedPayloadHash(log, 'Base', 'Safe'))
process.exit(got === MPC_SAID ? 0 : 1)
