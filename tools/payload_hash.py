# Independent borsh encoder for ForeignTxSignPayload::V1 (EVM), checked against a real MPC payload_hash.
import hashlib, struct
u8=lambda v: struct.pack('<B',v); u32=lambda v: struct.pack('<I',v); u64=lambda v: struct.pack('<Q',v)
b=lambda h: bytes.fromhex(h[2:] if h.startswith('0x') else h)
CHAIN={'Abstract':0,'Ethereum':1,'Solana':2,'Bitcoin':3,'Starknet':4,'Bnb':5,'Base':6,'Arbitrum':7,'Polygon':8,'HyperEvm':9}
FIN={'Latest':0,'Safe':1,'Finalized':2}
def extractor(e): return u8(0) if e=='BlockHash' else u8(1)+u64(e)
def log(l):
    data=l['data'].encode()
    return (u8(1 if l['removed'] else 0)+u64(int(l['logIndex'],16))+u64(int(l['transactionIndex'],16))
        +b(l['transactionHash'])+b(l['blockHash'])+u64(int(l['blockNumber'],16))+b(l['address'])
        +u32(len(data))+data+u32(len(l['topics']))+b''.join(b(t) for t in l['topics']))
def payload(chain,tx,fin,extractors,values):
    req=u8(CHAIN[chain])+b(tx)+u32(len(extractors))+b''.join(extractor(e) for e in extractors)+u8(FIN[fin])
    vals=b''
    for kind,v in values:
        vals+=u8(1)+(u8(0)+b(v) if kind=='BlockHash' else u8(1)+log(v))  # ExtractedValue::Evm=1
    return u8(0)+req+u32(len(values))+vals  # ForeignTxSignPayload::V1=0
if __name__=='__main__':
    import json, sys, urllib.request
    TX='0x702705ea9058b4a16a8907d06075de2ce65087da8061f93655e9a056e60a9301'
    MPC_SAID='fb8f25f6b7bad4ff91af67a7e43f06aaa6653923c8fa6e39d741f220418bbfc5'
    req=urllib.request.Request('https://mainnet.base.org', headers={'Content-Type':'application/json','User-Agent':'fair-warning-tools'},  # default UA gets 403
        data=json.dumps({'jsonrpc':'2.0','id':1,'method':'eth_getTransactionReceipt','params':[TX]}).encode())
    r=json.load(urllib.request.urlopen(req, timeout=20))['result']; l=[x for x in r['logs'] if int(x['logIndex'],16)==5][0]
    p=payload('Base',r['transactionHash'],'Finalized',['BlockHash',5],[('BlockHash',r['blockHash']),('Log',l)])
    got=hashlib.sha256(p).hexdigest()
    print('computed', got); print('mpc_said', MPC_SAID)
    sys.exit(0 if got==MPC_SAID else 1)
