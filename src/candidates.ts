import fetchRetry from 'fetch-retry';
import { Hono } from 'hono';
import { deflate, inflate } from 'pako';
import * as z from 'zod';

const fetch = fetchRetry(globalThis.fetch, {
  retries: 5,
  retryOn: [429],
  retryDelay: function (attempt) {
    return Math.pow(2, attempt) * 250;
  }
});

export interface Candidate {
  nominee: string;
  house: string;
  timestamp: string;
  voters: string[];
  amount: string;
  created: number;
  txCount: number;
  fts: {
    contractId: string;
    amount: string;
  }[];
  nfts: {
    contractId: string;
    quantity: number;
  }[];
  ethAddresses: string[];
}

export interface FtMetadata {
  contractId: string;
  name: string;
  symbol: string;
  decimals: number;
  price?: number;
}

export interface NftMetadata {
  contractId: string;
  name: string;
  symbol: string;
}

const pagodaNft = z.object({
  contract_account_id: z.string(),
  nft_count: z.number(),
  contract_metadata: z.object({
    name: z.string(),
    symbol: z.string()
  })
});
type PagodaNft = z.infer<typeof pagodaNft>;

export const candidates = new Hono<{ Bindings: Env }>().get('/', async c => {
  const addr = c.env.CANDIDATES.idFromName('');
  const obj = c.env.CANDIDATES.get(addr);
  const res = await obj.fetch(`${new URL(c.req.url).origin}/candidates`);
  const candidates = await res.json<Candidate[]>();
  return c.jsonT(candidates);
});

export const ftMetas = new Hono<{ Bindings: Env }>().get('/', async c => {
  const addr = c.env.CANDIDATES.idFromName('');
  const obj = c.env.CANDIDATES.get(addr);
  const res = await obj.fetch(`${new URL(c.req.url).origin}/ftmetas`);
  const metadatas = await res.json<FtMetadata[]>();
  return c.jsonT(metadatas);
});

export const nftMetas = new Hono<{ Bindings: Env }>().get('/', async c => {
  const addr = c.env.CANDIDATES.idFromName('');
  const obj = c.env.CANDIDATES.get(addr);
  const res = await obj.fetch(`${new URL(c.req.url).origin}/nftmetas`);
  const metadatas = await res.json<NftMetadata[]>();
  return c.jsonT(metadatas);
});

export class Candidates {
  private state: DurableObjectState;
  private app: Hono<{ Bindings: Env }>;
  private index: number;
  private subRequests: number;
  private candidates?: Record<string, Partial<Candidate>>;
  private ftMetas: Record<string, FtMetadata>;
  private nftMetas: Record<string, NftMetadata>;
  private ftPrices?: Record<string, number>;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.index = 0;
    this.subRequests = 0;
    this.candidates = {};
    this.ftMetas = {};
    this.nftMetas = {};
    this.state.blockConcurrencyWhile(async () => {
      this.index = (await this.state.storage.get('index')) ?? 0;
      const candidates = await this.state.storage.get<Uint8Array>('candidates');
      const decoder = new TextDecoder();
      this.candidates = candidates
        ? JSON.parse(decoder.decode(inflate(candidates)))
        : undefined;
      this.ftMetas =
        (await this.state.storage.get<typeof this.ftMetas>('ftMetas')) ?? {};
      this.nftMetas =
        (await this.state.storage.get<typeof this.nftMetas>('nftMetas')) ?? {};
    });

    this.app = new Hono();
    this.app.get('/candidates', () => {
      if (!this.candidates) {
        return new Response('', { status: 500 });
      }
      return new Response(JSON.stringify(Object.values(this.candidates)));
    });
    this.app.get('/ftmetas', () => {
      return new Response(JSON.stringify(Object.values(this.ftMetas)));
    });
    this.app.get('/nftmetas', () => {
      return new Response(JSON.stringify(Object.values(this.nftMetas)));
    });
    this.app.post('*', async c => {
      if (this.candidates == null) {
        this.candidates = {};

        try {
          let offset = 0;
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const candidates = await this.getFetchResponse(
              `https://api.pikespeak.ai/nominations/candidates?contract=nominations.ndc-gwg.near&offset=${offset}`,
              z.array(
                z.object({
                  nominee: z.string(),
                  house: z.string(),
                  timestamp: z.string()
                })
              ),
              {
                headers: {
                  'x-api-key': c.req.header('PIKESPEAK_API_KEY') ?? '',
                  Origin: 'https://near.social'
                }
              }
            );
            if (candidates.length === 0) break;
            for (const candidate of candidates) {
              this.candidates[candidate.nominee] = {
                nominee: candidate.nominee,
                house: candidate.house,
                timestamp: candidate.timestamp
              };
            }
            offset += 50;
          }
          const encoder = new TextEncoder();
          await this.state.storage.put(
            'candidates',
            deflate(encoder.encode(JSON.stringify(this.candidates)))
          );
        } catch (err) {
          console.error(`Initialization threw exception: ${err}`);
          this.candidates = undefined;
          return new Response('', { status: 400 });
        }
      }

      try {
        const candidates = Object.keys(this.candidates);
        for (
          let i = 0;
          i < 3 && this.subRequests < 40;
          i++, this.index++, this.index %= candidates.length
        ) {
          const candidate = candidates[this.index];
          console.info(`fetching information about ${candidate}`);

          const pikespeakVotersRes = await this.getFetchResponse(
            `https://api.pikespeak.ai/election/votes-by-candidate?contract=elections.ndc-gwg.near&candidate=${candidate}`,
            z.array(
              z.object({
                voter: z.string()
              })
            ),
            {
              headers: {
                'x-api-key': c.req.header('PIKESPEAK_API_KEY') ?? '',
                Origin: 'https://near.social'
              }
            }
          );
          this.candidates[candidate].voters = pikespeakVotersRes.map(
            ({ voter }) => voter
          );

          const nearblocksAccountRes = await this.getFetchResponse(
            `https://api.nearblocks.io/v1/account/${candidate}`,
            z.object({
              account: z.array(
                z.object({
                  amount: z.string(),
                  created: z.object({ block_timestamp: z.number() })
                })
              )
            })
          );
          this.candidates[candidate].amount =
            nearblocksAccountRes.account[0].amount;
          this.candidates[candidate].created =
            nearblocksAccountRes.account[0].created.block_timestamp;

          const pagodaNftRes = await this.getFetchResponse(
            `https://near-mainnet.api.pagoda.co/eapi/v1/accounts/${candidate}/NFT`,
            z.object({
              nft_counts: z.array(
                z.object({
                  contract_account_id: z.string(),
                  nft_count: z.number(),
                  contract_metadata: z.object({
                    name: z.string(),
                    symbol: z.string()
                  })
                })
              )
            }),
            {
              headers: {
                'x-api-key': c.req.header('PAGODA_API_KEY') ?? '',
                'Content-Type': 'application/json'
              }
            }
          );
          await this.updateNftMetadata(pagodaNftRes.nft_counts);
          this.candidates[candidate].nfts = pagodaNftRes.nft_counts.map(
            ({ contract_account_id, nft_count }) => ({
              contractId: contract_account_id,
              quantity: nft_count
            })
          );

          const pikespeakTxcountRes = await this.getFetchResponse(
            `https://api.pikespeak.ai/account/tx-count/${candidate}`,
            z.number(),
            {
              headers: {
                'x-api-key': c.req.header('PIKESPEAK_API_KEY') ?? '',
                Origin: 'https://near.social'
              }
            }
          );
          this.candidates[candidate].txCount = pikespeakTxcountRes;

          const pikespeakBalanceRes = await this.getFetchResponse(
            `https://api.pikespeak.ai/account/balance/${candidate}`,
            z.array(
              z.object({
                contract: z.string(),
                amount: z.string(),
                symbol: z.string(),
                icon: z.string().optional()
              })
            ),
            {
              headers: {
                'x-api-key': c.req.header('PIKESPEAK_API_KEY') ?? '',
                Origin: 'https://near.social'
              }
            }
          );
          await this.updateFtMetadata(
            pikespeakBalanceRes
              .map(({ contract }) => contract)
              .filter(contract => contract !== 'Near')
          );
          this.candidates[candidate].fts = pikespeakBalanceRes
            .filter(({ contract }) => contract !== 'Near')
            .map(({ contract, amount }) => ({
              contractId: contract,
              amount
            }));

          const pikespeakEthAddressesRes = await this.getFetchResponse(
            `https://api.pikespeak.ai/bridge/probable-eth-addresses/${candidate}`,
            z.array(z.string()),
            {
              headers: {
                'x-api-key': c.req.header('PIKESPEAK_API_KEY') ?? '',
                Origin: 'https://near.social'
              }
            }
          );
          this.candidates[candidate].ethAddresses = pikespeakEthAddressesRes;
        }
      } catch (err) {
        console.error(err);
      }

      console.info(
        `new index: ${this.index} / ${Object.keys(this.candidates).length}`
      );
      await this.state.storage.put('index', this.index);
      try {
        const encoder = new TextEncoder();
        await this.state.storage.put(
          'candidates',
          deflate(encoder.encode(JSON.stringify(this.candidates)))
        );
      } catch (err) {
        console.error(`saving candidates threw exception: ${err}`);
      }

      return new Response('', { status: 204 });
    });
  }

  async fetch(request: Request): Promise<Response> {
    this.subRequests = 0;
    if (this.ftPrices == null) {
      const prices = await this.getFetchResponse(
        'https://raw.githubusercontent.com/Tarnadas/token-prices/main/ref-prices.json',
        z.record(
          z.object({
            price: z.string()
          })
        )
      );
      this.ftPrices = {};
      for (const [contract, { price }] of Object.entries(prices)) {
        this.ftPrices[contract] = Number(price);
        if (this.ftMetas[contract]) {
          this.ftMetas[contract].price = Number(price);
        }
      }
    }
    return this.app.fetch(request);
  }

  private async updateFtMetadata(contracts: string[]): Promise<void> {
    for (const contractId of contracts) {
      try {
        this.subRequests++;
        const res = await fetch('https://rpc.mainnet.near.org', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'dontcare',
            method: 'query',
            params: {
              request_type: 'call_function',
              finality: 'final',
              account_id: contractId,
              method_name: 'ft_metadata',
              args_base64: ''
            }
          })
        });
        if (!res.ok) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = await res.json();
        if (!json.result) continue;
        const result = new Uint8Array(json.result.result);
        const decoder = new TextDecoder();
        const ftMetadata = JSON.parse(decoder.decode(result)) as FtMetadata;
        this.ftMetas[contractId] = {
          contractId,
          name: ftMetadata.name,
          symbol: ftMetadata.symbol,
          decimals: ftMetadata.decimals
        };
        if (this.ftPrices && this.ftPrices[contractId] != null) {
          this.ftMetas[contractId].price = this.ftPrices[contractId];
        }
      } catch {
        // ignore
      }
    }
    await this.state.storage.put('ftMetas', this.ftMetas);
  }

  private async updateNftMetadata(nfts: PagodaNft[]): Promise<void> {
    for (const nft of nfts) {
      this.nftMetas[nft.contract_account_id] = {
        contractId: nft.contract_account_id,
        name: nft.contract_metadata.name,
        symbol: nft.contract_metadata.symbol
      };
    }
    await this.state.storage.put('nftMetas', this.nftMetas);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getFetchResponse<T extends z.ZodType<any, any, any>>(
    url: string,
    schema: T,
    options?: RequestInit<RequestInitCfProperties>
  ): Promise<z.infer<T>> {
    this.subRequests++;
    const res = await fetch(url, options);
    if (!res.ok) {
      throw new Error(
        `API call to ${url} returned error: [${res.status}] ${await res.text()}`
      );
    }
    return res.json<z.infer<typeof schema>>();
  }
}
