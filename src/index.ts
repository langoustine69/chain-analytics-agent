import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

// Types
interface Chain {
  name: string;
  tvl: number;
  tokenSymbol: string | null;
  gecko_id: string | null;
  chainId: number | null;
}

interface StablecoinChain {
  name: string;
  gecko_id: string | null;
  tokenSymbol: string | null;
  totalCirculatingUSD: { peggedUSD?: number };
}

interface Bridge {
  id: number;
  name: string;
  displayName: string;
  last24hVolume: number;
  weeklyVolume: number;
  monthlyVolume: number;
  chains: string[];
}

// Helper: Fetch real data from DeFiLlama APIs
async function fetchChains(): Promise<Chain[]> {
  const res = await fetch('https://api.llama.fi/v2/chains');
  if (!res.ok) throw new Error(`Chains API error: ${res.status}`);
  return res.json();
}

async function fetchStablecoins(): Promise<StablecoinChain[]> {
  const res = await fetch('https://stablecoins.llama.fi/stablecoinchains');
  if (!res.ok) throw new Error(`Stablecoins API error: ${res.status}`);
  return res.json();
}

async function fetchBridges(): Promise<{ bridges: Bridge[] }> {
  const res = await fetch('https://bridges.llama.fi/bridges');
  if (!res.ok) throw new Error(`Bridges API error: ${res.status}`);
  return res.json();
}

// Create agent
const agent = await createAgent({
  name: 'chain-analytics-agent',
  version: '1.0.0',
  description: 'Real-time blockchain analytics - TVL, stablecoins, bridges, L2 comparisons',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === FREE ENDPOINT: Market Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free market overview - total chains, TVL, and top 5 (LIVE DATA)',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const chains = await fetchChains();
    const sorted = chains.sort((a, b) => b.tvl - a.tvl);
    const totalTVL = chains.reduce((sum, c) => sum + c.tvl, 0);
    
    return {
      output: {
        fetchedAt: new Date().toISOString(),
        market: {
          totalChains: chains.length,
          totalTVL: `$${(totalTVL / 1e9).toFixed(1)}B`,
          totalTVLRaw: totalTVL,
        },
        top5: sorted.slice(0, 5).map((c, i) => ({
          rank: i + 1,
          name: c.name,
          tvl: `$${(c.tvl / 1e9).toFixed(2)}B`,
        })),
        dataSource: 'DeFiLlama (live)',
      },
    };
  },
});

// === PAID ENDPOINT 1: Chain Details ($0.001) ===
addEntrypoint({
  key: 'chain-details',
  description: 'Detailed TVL and metrics for a specific chain',
  input: z.object({
    chain: z.string().min(1).describe('Chain name (e.g., "Ethereum", "Base", "Arbitrum")'),
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const { chain } = ctx.input;
    const [chains, stables] = await Promise.all([fetchChains(), fetchStablecoins()]);
    
    const chainData = chains.find(
      c => c.name.toLowerCase() === chain.toLowerCase()
    );
    
    if (!chainData) {
      const available = chains.slice(0, 20).map(c => c.name);
      return { output: { error: 'Chain not found', availableChains: available } };
    }
    
    const stableData = stables.find(
      s => s.name.toLowerCase() === chain.toLowerCase()
    );
    
    const sorted = chains.sort((a, b) => b.tvl - a.tvl);
    const rank = sorted.findIndex(c => c.name === chainData.name) + 1;
    
    return {
      output: {
        fetchedAt: new Date().toISOString(),
        chain: {
          name: chainData.name,
          tvl: `$${(chainData.tvl / 1e9).toFixed(3)}B`,
          tvlRaw: chainData.tvl,
          rank,
          totalChains: chains.length,
          tokenSymbol: chainData.tokenSymbol,
          geckoId: chainData.gecko_id,
          chainId: chainData.chainId,
        },
        stablecoins: stableData ? {
          totalUSD: `$${((stableData.totalCirculatingUSD.peggedUSD || 0) / 1e6).toFixed(1)}M`,
          totalUSDRaw: stableData.totalCirculatingUSD.peggedUSD || 0,
        } : null,
      },
    };
  },
});

// === PAID ENDPOINT 2: Top Chains ($0.002) ===
addEntrypoint({
  key: 'top-chains',
  description: 'Top chains by TVL with filtering options',
  input: z.object({
    limit: z.number().min(1).max(50).default(20),
    minTvl: z.number().default(0).describe('Minimum TVL in USD'),
    category: z.enum(['all', 'l2', 'l1', 'alt-l1']).default('all'),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { limit, minTvl, category } = ctx.input;
    const chains = await fetchChains();
    
    // Known L2s
    const l2Names = ['Base', 'Arbitrum', 'OP Mainnet', 'Scroll', 'Linea', 'Blast', 
      'zkSync Era', 'Polygon zkEVM', 'Mantle', 'Mode', 'Starknet', 'Taiko', 'Manta'];
    const l1Names = ['Ethereum', 'BSC', 'Solana', 'Tron', 'Bitcoin'];
    
    let filtered = chains.filter(c => c.tvl >= minTvl);
    
    if (category === 'l2') {
      filtered = filtered.filter(c => l2Names.some(l2 => 
        c.name.toLowerCase().includes(l2.toLowerCase())
      ));
    } else if (category === 'l1') {
      filtered = filtered.filter(c => l1Names.some(l1 => 
        c.name.toLowerCase().includes(l1.toLowerCase())
      ));
    } else if (category === 'alt-l1') {
      filtered = filtered.filter(c => 
        !l2Names.some(l2 => c.name.toLowerCase().includes(l2.toLowerCase())) &&
        !l1Names.some(l1 => c.name.toLowerCase().includes(l1.toLowerCase()))
      );
    }
    
    const sorted = filtered.sort((a, b) => b.tvl - a.tvl).slice(0, limit);
    const totalTVL = sorted.reduce((sum, c) => sum + c.tvl, 0);
    
    return {
      output: {
        fetchedAt: new Date().toISOString(),
        filters: { limit, minTvl, category },
        count: sorted.length,
        totalTVL: `$${(totalTVL / 1e9).toFixed(2)}B`,
        chains: sorted.map((c, i) => ({
          rank: i + 1,
          name: c.name,
          tvl: `$${(c.tvl / 1e9).toFixed(3)}B`,
          tvlRaw: c.tvl,
          tokenSymbol: c.tokenSymbol,
        })),
      },
    };
  },
});

// === PAID ENDPOINT 3: Stablecoin Distribution ($0.002) ===
addEntrypoint({
  key: 'stablecoin-flows',
  description: 'Stablecoin distribution across chains',
  input: z.object({
    limit: z.number().min(1).max(50).default(20),
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const { limit } = ctx.input;
    const stables = await fetchStablecoins();
    
    const withUSD = stables
      .filter(s => s.totalCirculatingUSD.peggedUSD && s.totalCirculatingUSD.peggedUSD > 0)
      .map(s => ({
        name: s.name,
        stablecoinsUSD: s.totalCirculatingUSD.peggedUSD!,
        tokenSymbol: s.tokenSymbol,
      }))
      .sort((a, b) => b.stablecoinsUSD - a.stablecoinsUSD)
      .slice(0, limit);
    
    const totalStables = withUSD.reduce((sum, s) => sum + s.stablecoinsUSD, 0);
    
    return {
      output: {
        fetchedAt: new Date().toISOString(),
        totalStablecoins: `$${(totalStables / 1e9).toFixed(2)}B`,
        chainCount: withUSD.length,
        distribution: withUSD.map((s, i) => ({
          rank: i + 1,
          chain: s.name,
          stablecoins: `$${(s.stablecoinsUSD / 1e9).toFixed(3)}B`,
          stablecoinsRaw: s.stablecoinsUSD,
          share: `${((s.stablecoinsUSD / totalStables) * 100).toFixed(1)}%`,
        })),
      },
    };
  },
});

// === PAID ENDPOINT 4: Bridge Analytics ($0.003) ===
addEntrypoint({
  key: 'bridge-volume',
  description: 'Cross-chain bridge volumes and rankings',
  input: z.object({
    limit: z.number().min(1).max(20).default(10),
    period: z.enum(['24h', '7d', '30d']).default('24h'),
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const { limit, period } = ctx.input;
    const { bridges } = await fetchBridges();
    
    const volumeKey = period === '24h' ? 'last24hVolume' : 
                      period === '7d' ? 'weeklyVolume' : 'monthlyVolume';
    
    const sorted = bridges
      .filter(b => b[volumeKey] > 0)
      .sort((a, b) => b[volumeKey] - a[volumeKey])
      .slice(0, limit);
    
    const totalVolume = sorted.reduce((sum, b) => sum + b[volumeKey], 0);
    
    return {
      output: {
        fetchedAt: new Date().toISOString(),
        period,
        totalVolume: `$${(totalVolume / 1e9).toFixed(2)}B`,
        bridgeCount: sorted.length,
        bridges: sorted.map((b, i) => ({
          rank: i + 1,
          name: b.displayName,
          volume: `$${(b[volumeKey] / 1e6).toFixed(1)}M`,
          volumeRaw: b[volumeKey],
          share: `${((b[volumeKey] / totalVolume) * 100).toFixed(1)}%`,
          supportedChains: b.chains.length,
          chains: b.chains.slice(0, 5),
        })),
      },
    };
  },
});

// === PAID ENDPOINT 5: Chain Comparison ($0.005) ===
addEntrypoint({
  key: 'chain-compare',
  description: 'Compare multiple chains side-by-side',
  input: z.object({
    chains: z.array(z.string()).min(2).max(5).describe('Chain names to compare'),
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const { chains: chainNames } = ctx.input;
    const [allChains, stables, { bridges }] = await Promise.all([
      fetchChains(),
      fetchStablecoins(),
      fetchBridges(),
    ]);
    
    const sorted = allChains.sort((a, b) => b.tvl - a.tvl);
    
    const comparison = chainNames.map(name => {
      const chain = allChains.find(c => c.name.toLowerCase() === name.toLowerCase());
      const stable = stables.find(s => s.name.toLowerCase() === name.toLowerCase());
      const rank = chain ? sorted.findIndex(c => c.name === chain.name) + 1 : null;
      
      // Count bridges supporting this chain
      const bridgeCount = bridges.filter(b => 
        b.chains.some(c => c.toLowerCase() === name.toLowerCase())
      ).length;
      
      return {
        name: chain?.name || name,
        found: !!chain,
        tvl: chain ? `$${(chain.tvl / 1e9).toFixed(3)}B` : null,
        tvlRaw: chain?.tvl || 0,
        rank,
        tokenSymbol: chain?.tokenSymbol,
        stablecoins: stable?.totalCirculatingUSD.peggedUSD 
          ? `$${(stable.totalCirculatingUSD.peggedUSD / 1e6).toFixed(1)}M`
          : null,
        stablecoinsRaw: stable?.totalCirculatingUSD.peggedUSD || 0,
        bridgesSupported: bridgeCount,
      };
    });
    
    // Calculate winner in each category
    const tvlWinner = comparison.reduce((a, b) => a.tvlRaw > b.tvlRaw ? a : b).name;
    const stableWinner = comparison.reduce((a, b) => a.stablecoinsRaw > b.stablecoinsRaw ? a : b).name;
    
    return {
      output: {
        fetchedAt: new Date().toISOString(),
        chainsCompared: chainNames.length,
        comparison,
        winners: {
          highestTVL: tvlWinner,
          mostStablecoins: stableWinner,
        },
        summary: comparison.map(c => `${c.name}: ${c.tvl || 'N/A'}`).join(' | '),
      },
    };
  },
});

// Start server
const port = Number(process.env.PORT ?? 3000);
console.log(`🔗 Chain Analytics Agent running on port ${port}`);

export default { port, fetch: app.fetch };
