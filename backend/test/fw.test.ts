import { describe, expect, test } from 'bun:test';
import { concatHex, encodeAbiParameters, keccak256, pad, type Hex } from 'viem';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { expectedPayloadHash, type LogInput } from '../src/lib/fw/mpcPayload.ts';

// Real mainnet vector: v1.signer signed this payload_hash for a Base log (tx AkeQab... on NEAR, 2026-10-25).
const MAINNET_LOG: LogInput = {
  tx_hash: '0x702705ea9058b4a16a8907d06075de2ce65087da8061f93655e9a056e60a9301',
  log_index: 5,
  transaction_index: 3,
  block_hash: '0x39da995c033b9920f074f5f8a17a160382274787e454bf1b8ed8d8b707576549',
  block_number: 53056155,
  address: '0xe844701934d9c6085b292e428f41b911cc0b3872',
  data: '0x',
  topics: [
    '0x29e088dffd7bf6815d088137a59f364d6747163baa7ff4bc47f316a1ad1b9586',
    '0x8dfdc825dd0453e7c80b1c1d32ae910e35d6efe9000000000000000021050200',
  ],
};

describe('MPC payload hash', () => {
  test('matches the hash v1.signer signed on mainnet', () => {
    expect(expectedPayloadHash(MAINNET_LOG, 'Base', 'Finalized', true)).toBe(
      '0xfb8f25f6b7bad4ff91af67a7e43f06aaa6653923c8fa6e39d741f220418bbfc5',
    );
  });
  test('single-log Safe request matches near-mpc-sdk builder (rev d0fc87b)', () => {
    expect(expectedPayloadHash(MAINNET_LOG, 'Base', 'Safe')).toBe(
      '0x7a48b522c192d3ec4845c58aed1d9a8afc50bfbdf0511329aaa6cc3eaa7745b7',
    );
  });
  test('every EVM chain matches near-mpc-sdk builder (tools/hashcheck)', () => {
    const sdk = {
      Base: '7a48b522c192d3ec4845c58aed1d9a8afc50bfbdf0511329aaa6cc3eaa7745b7',
      Arbitrum: '43abbfc425906779a235037e96222d47733033ee839c280e952cbd0d8f1ecb5c',
      Bnb: '8eb56790a92258f176e3577d79f170193e3bc7b885711c5f2e19d334847e324d',
      Polygon: 'e70e930b79d0f9a2e4f15663637d4897705bc35f37683c428a3044af49c715c9',
      Avalanche: '6372b8e40c2f78f19576b295caa6c21082e271ef32a893e31d16814a88786484',
      HyperEvm: '4c91c42996d54837d74932a2a6b80b0c37b2b7c4378fc59b574a0525c08db68d',
      Abstract: 'afa5758965c9b2ec84fe1d29e2d95c8c47a116d7c668f08e72e39baf7ef8ace0',
    } as const;
    for (const [chain, hash] of Object.entries(sdk)) {
      expect(expectedPayloadHash(MAINNET_LOG, chain as keyof typeof sdk, 'Safe')).toBe(`0x${hash}`);
    }
  });
  test('any changed field changes the hash', () => {
    const tampered = { ...MAINNET_LOG, block_number: MAINNET_LOG.block_number + 1 };
    expect(expectedPayloadHash(tampered, 'Base', 'Safe')).not.toBe(expectedPayloadHash(MAINNET_LOG, 'Base', 'Safe'));
  });
});

describe('fingerprint and merkle compatibility', () => {
  test('upgrade fingerprint equals Announcer.upgradeLog hash', () => {
    const proxy = '0x1111111111111111111111111111111111111111' as Hex;
    const impl = '0x3333333333333333333333333333333333333333' as Hex;
    const upgraded = keccak256(new TextEncoder().encode('Upgraded(address)'));
    // fw fixture action hash from the sandbox test
    expect(keccak256(concatHex([proxy, upgraded, pad(impl)]))).toBe('0x8fdb2015af6379fab59c762429cdc451c74cadeb6cccb4d7b7b9c0bb04ad3f14');
  });
  test('Announce topic equals the contract ANNOUNCE_TOPIC constant', () => {
    expect(keccak256(new TextEncoder().encode('Announce(bytes32,address,bytes)'))).toBe(
      '0xca1cdcd38b74c0372e7cd907ed543eb3e47f868a4f1f89ad553627c2b104601e',
    );
  });
  test('OZ StandardMerkleTree leaf equals fw leaf_hash formula', () => {
    const addr = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
    const tree = StandardMerkleTree.of([[addr, '60']], ['address', 'uint256']);
    const leaf = keccak256(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, 60n])));
    expect(tree.root).toBe(leaf);
  });
});
