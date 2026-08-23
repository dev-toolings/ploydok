// SPDX-License-Identifier: AGPL-3.0-only
/** Atomic Redis reader/writer lease for deploys (readers) and cleanup (writer). */
export interface GateRedis { eval(script: string, keys: number, ...args: string[]): Promise<unknown> }
const KEY = "ploydok:build-cleanup:gate"
const TTL = 60_000
export async function acquireGate(redis: GateRedis, mode: "reader" | "writer", token: string = crypto.randomUUID(), opts: { key?: string; ttlMs?: number } = {}): Promise<{ token: string; renew: () => Promise<boolean>; release: () => Promise<void> } | null> {
  const key = opts.key ?? KEY
  const ttl = opts.ttlMs ?? TTL
  const acquire = "local k=KEYS[1]; local now=tonumber(ARGV[1]); local ttl=tonumber(ARGV[2]); local mode=ARGV[3]; local tok=ARGV[4]; local w=redis.call('hget',k,'w'); local ws=tonumber(redis.call('hget',k,'wu') or '0'); if w and ws<=now then redis.call('hdel',k,'w','wu'); w=nil end; for _,f in ipairs(redis.call('hkeys',k)) do if string.sub(f,1,2)=='r:' and tonumber(redis.call('hget',k,f))<=now then redis.call('hdel',k,f) end end; if mode=='writer' then if redis.call('hget',k,'w') or #redis.call('hkeys',k)>0 then return 0 end; redis.call('hmset',k,'w',tok,'wu',now+ttl); return 1 end; if redis.call('hget',k,'w') then return 0 end; redis.call('hset',k,'r:'..tok,now+ttl); return 1"
  const ok = Number(await redis.eval(acquire, 1, key, String(Date.now()), String(ttl), mode, token)) === 1
  if (!ok) return null
  const renew = async () => Number(await redis.eval("local f=ARGV[1]=='writer' and 'wu' or 'r:'..ARGV[2]; if ARGV[1]=='writer' and redis.call('hget',KEYS[1],'w')~=ARGV[2] then return 0 end; local expiresAt=tonumber(redis.call('hget',KEYS[1],f) or '0'); if expiresAt<=tonumber(ARGV[3]) then return 0 end; redis.call('hset',KEYS[1],f,tonumber(ARGV[3])+tonumber(ARGV[4])); return 1",1,key,mode,token,String(Date.now()),String(ttl)))===1
  const release = async () => { await redis.eval("if ARGV[1]=='writer' and redis.call('hget',KEYS[1],'w')==ARGV[2] then redis.call('hdel',KEYS[1],'w','wu') else redis.call('hdel',KEYS[1],'r:'..ARGV[2]) end",1,key,mode,token) }
  return { token, renew, release }
}
