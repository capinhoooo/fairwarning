interface AppConfig {
  appName: string
  appDescription: string
  links: {
    twitter: string
    github: string
    telegram: string
    discord: string
    docs: string
    buy: string
  }
  contracts: {
    main: string
    token: string
  }
  features: {
    darkMode: boolean
    smoothScroll: boolean
  }
  fw: {
    apiUrl: string
    nearNetwork: 'mainnet' | 'testnet'
    contractId: string
    mpcContractId: string
    nearExplorer: string
    intentsExplorer: string
    usdcContractId: string
    announcerAddress: string
  }
}

export const config: AppConfig = {
  appName: 'Fair Warning',
  appDescription:
    'Admin keys give notice or pay. Bonds on NEAR, checked against Base by the NEAR MPC network.',

  // Social links
  links: {
    twitter: '',
    github: import.meta.env.VITE_GITHUB_URL ?? '',
    telegram: '',
    discord: '',
    docs: '',
    buy: '',
  },

  // Contract/wallet related (if needed)
  contracts: {
    main: '',
    token: '',
  },

  // Feature flags
  features: {
    darkMode: true,
    smoothScroll: true,
  },

  // Fair Warning
  fw: {
    apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:3700',
    nearNetwork:
      import.meta.env.VITE_NEAR_NETWORK === 'testnet' ? 'testnet' : 'mainnet',
    contractId: import.meta.env.VITE_FW_CONTRACT_ID ?? 'fw.fairwarning.near',
    mpcContractId:
      import.meta.env.VITE_NEAR_NETWORK === 'testnet'
        ? 'v1.signer-prod.testnet'
        : 'v1.signer',
    nearExplorer:
      import.meta.env.VITE_NEAR_NETWORK === 'testnet'
        ? 'https://testnet.nearblocks.io'
        : 'https://nearblocks.io',
    intentsExplorer: 'https://explorer.near-intents.org',
    // native USDC on NEAR mainnet; testnet deployments set their own
    usdcContractId:
      import.meta.env.VITE_USDC_CONTRACT_ID ??
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    // the shared Announcer on Base that owners announce through; owners may deploy their own
    announcerAddress: import.meta.env.VITE_ANNOUNCER_ADDRESS ?? '',
  },
}

export type Config = AppConfig
