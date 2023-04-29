import WebSocket from "ws";
import ethers from "ethers";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";

dotenv.config();

// Globals
const PRICE_FEEDS = {};
const BALANCES = {};
const CHAINLINK_PROVIDERS = {};
const UNISWAP_V3_PROVIDERS = {};
const TOKEN_INFO = {};
let EXCHANGE_INFO = {};
let EXCHANGE_CONTRACT = null;
const filledOrderHashes = [];

const DEFAULT_EXPIRY = 15
const MIN_EXPIRY = 15

let uniswap_error_counter = 0;
let chainlink_error_counter = 0;

const ERC20ABI = JSON.parse(fs.readFileSync("ABIs/ERC20.abi"));
const VAULTABI = JSON.parse(fs.readFileSync("ABIs/ZigZagVault.abi"));
const EXCHANGEABI = JSON.parse(fs.readFileSync("ABIs/ZigZagExchange.abi"));

// Load MM config
let MM_CONFIG;
if (process.env.MM_CONFIG) {
  MM_CONFIG = JSON.parse(process.env.MM_CONFIG);
} else {
  const mmConfigFile = fs.readFileSync("config.json", "utf8");
  MM_CONFIG = JSON.parse(mmConfigFile);
}

const CHAIN_ID = parseInt(MM_CONFIG.zigzagChainId);
if (![42161, 421613].includes(CHAIN_ID)) {
  throw new Error(`You can not run this bot on chainId: ${CHAIN_ID}!`)
}

const VAULT_TOKEN_ADDRESS = MM_CONFIG.vault && MM_CONFIG.vault.address;
const VAULT_DEPOSIT_TOKENS = VAULT_TOKEN_ADDRESS ? Object.keys(MM_CONFIG.vault.depositTokens) : [];
const VAULT_DEPOSIT_FEE = VAULT_TOKEN_ADDRESS ? MM_CONFIG.vault.depositFee : 0.01; // default != 0 to prevent arb
const VAULT_WITHDRAW_FEE = VAULT_TOKEN_ADDRESS ? MM_CONFIG.vault.withdrawFee : 0.01; // default != 0 to prevent arb
const VAULT_INITIAL_PRICE = VAULT_TOKEN_ADDRESS ? MM_CONFIG.vault.initialPrice : 1;
if (VAULT_TOKEN_ADDRESS && !VAULT_DEPOSIT_TOKENS) {
  throw new Error('vault need deposit token list')
}

let activePairs = [];
for (let marketId in MM_CONFIG.pairs) {
  const pair = MM_CONFIG.pairs[marketId];
  if (pair.active) {
    activePairs.push(marketId);
  }
}
if (VAULT_TOKEN_ADDRESS) {
  for (let tokenAddress in MM_CONFIG.vault.depositTokens) {
    activePairs.push(VAULT_TOKEN_ADDRESS + "-" + tokenAddress);
  }
}
console.log("ACTIVE PAIRS", activePairs);

// setup L1 provider
const infuraID = MM_CONFIG.infura || process.env.INFURA;
const ethereumRPC = MM_CONFIG.ethereumRPC || process.env.ETHEREUM_RPC;
let ethersProvider
if (infuraID) {
  ethersProvider = new ethers.providers.InfuraProvider("mainnet", infuraID);
} else if (ethereumRPC) {
  ethersProvider = new ethers.providers.JsonRpcProvider(ethereumRPC);
} else {
  throw new Error(`
    You did not provider an rpc url with "ethereumRPC" inside your config
    or with ETHEREUM_RPC in the environment variables.
    Please add a custom one. There are some providers with free plans.`
  )
}
const resProvider = await Promise.race([
  ethersProvider.ready,
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Request timed out')), 10_000)
  })
])

// check if provider is working
if (Number(resProvider.chainId) !== 1) {
  throw new Error(`Cant connect provider, use "infura" in the config to add an infura id`)
}

// setup rollup provider
const arbitrumRPC = MM_CONFIG.arbitrumRPC || process.env.ARBITRUM_RPC;
let rollupProvider
if (arbitrumRPC) {
  rollupProvider = new ethers.providers.JsonRpcProvider(arbitrumRPC);
} else {
  console.warn(`
    You did not provider an rpc url with "arbitrumRPC" inside your config
    or with ARBITRUM_RPC in the environment variables.
    Using a public RPC for now, this might cause the bot to be slow filling trades
    or crash occasionally. 
    Please add a custom RPC. There are some providers with free plans.`
  )

  if (CHAIN_ID === 42161) {
    rollupProvider = new ethers.providers.JsonRpcProvider(
      "https://arb1.arbitrum.io/rpc"
    );
  } else if (CHAIN_ID === 421613) {
    rollupProvider = new ethers.providers.JsonRpcProvider(
      "https://goerli-rollup.arbitrum.io/rpc"
    );
  }
}
const resRollupProvider = await Promise.race([
  rollupProvider.ready,
  new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Request timed out')), 10_000)
  })
])

// check if provider is working
if (Number(resRollupProvider.chainId) !== CHAIN_ID) {
  throw new Error(`Cant connect rollup provider`)
}

// setup wallet
const pKey = MM_CONFIG.ethPrivKey || process.env.ETH_PRIVKEY || process.env.PRIVATE_KEY;
if (!pKey) throw new Error('Missing private key!')
const WALLET = new ethers.Wallet(pKey, rollupProvider).connect(rollupProvider);
const VAULT_CONTRACT = VAULT_TOKEN_ADDRESS && new ethers.Contract(VAULT_TOKEN_ADDRESS, VAULTABI, WALLET);
const [VAULT_DECIMALS] = VAULT_TOKEN_ADDRESS ? await Promise.all([
  VAULT_CONTRACT.decimals()
]) : [0, 0];


// Start price feeds
await setupPriceFeeds();
await getTokenInfo(activePairs);
await getExchangeInfo();
await getBalances();

// Update account state loop
setInterval(getBalances, 5000);

const sendOrdersVaultInterval = 30000
if (VAULT_TOKEN_ADDRESS) {
  sendOrdersVault();
  setInterval(sendOrdersVault, sendOrdersVaultInterval);
}

for (const marketId in MM_CONFIG.pairs) {
  const pairConfig = MM_CONFIG.pairs[marketId];
  const expires = Math.max(pairConfig.expirationTimeSeconds || DEFAULT_EXPIRY, MIN_EXPIRY)

  // the FE uses a 10 sec min to fetch new orders
  const interval = expires - 12.25;
  if (pairConfig.active) {
    sendOrders(marketId)
    setInterval(sendOrders, interval * 1000, marketId);

    // only try to fill order if minimumProfit is set
    const minProfit = Number(pairConfig.minimumProfit)
    if (minProfit) {
      checkOrders(marketId)
      setInterval(checkOrders, 10000, marketId);
    }
  }
}

setInterval(getExchangeInfo, 1 * 60 * 1000);

async function getExchangeInfo() {
  try {
    const response = await fetch(MM_CONFIG.zigzagHttps + "/v1/info");
    if (response.status !== 200) return;
    const result = await response.json();

    EXCHANGE_INFO = result.exchange;
    EXCHANGE_CONTRACT = new ethers.Contract(EXCHANGE_INFO.exchangeAddress, EXCHANGEABI, WALLET)
  } catch (e) {
    console.error(`Failed to getExchangeInfo, because: ${e.message}`)
    throw new Error(e)
  }
}

async function getTokenInfo(activePairs) {
  for (let i = 0; i < activePairs.length; i++) {
    const pair = activePairs[i];
    const tokens = pair.split('-');
    for (let j = 0; j < 2; j++) {
      const tokenAddress = tokens[j];
      if (TOKEN_INFO[tokenAddress.toLowerCase()]) continue
      try {
        if (tokenAddress.length !== 42) {
          console.error(`Token address does not match expected length.\nMake sure the the pairs inside the config are declared using their full address.
          `)
        }
        const contract = new ethers.Contract(tokenAddress, ERC20ABI, rollupProvider);
        const [decimalsRes, nameRes, symbolRes] = await Promise.all([
          contract.decimals(),
          contract.name(),
          contract.symbol()
        ]);
        TOKEN_INFO[tokenAddress.toLowerCase()] = {
          address: tokenAddress,
          decimals: decimalsRes,
          name: nameRes,
          symbol: symbolRes
        }
      } catch (e) {
        console.error(`Failed to getTokenInfo for ${pair}, ${tokens}, because: ${e.message}`)
        throw new Error(e)
      }
    }
  }
}

function validatePriceFeedMarket(marketId) {
  return _validatePriceFeed(MM_CONFIG.pairs[marketId]);
}

function getValidatedPriceDepositToken(token) {
  return _validatePriceFeed(MM_CONFIG.vault.depositTokens[token]);
}

function _validatePriceFeed(config) {
  const { priceFeedPrimary, priceFeedSecondary } = config;

  // Constant mode checks
  const [mode, price] = priceFeedPrimary.split(":");
  if (mode === "constant") {
    if (price > 0) return price;
    else throw new Error("No initPrice available");
  }

  // Check if primary price exists
  const primaryPrice = PRICE_FEEDS[priceFeedPrimary];
  if (!primaryPrice) throw new Error("Primary price feed unavailable");

  // If there is no secondary price feed, the price auto-validates
  if (!priceFeedSecondary) return primaryPrice;

  // Check if secondary price exists
  const secondaryPrice = PRICE_FEEDS[priceFeedSecondary];
  if (!secondaryPrice) throw new Error("Secondary price feed unavailable");

  // If the secondary price feed varies from the primary price feed by more than 2%, assume something is broken
  const percentDiff = Math.abs(primaryPrice - secondaryPrice) / primaryPrice;
  if (percentDiff > 0.02) {
    console.error("Primary and secondary price feeds do not match!");
    throw new Error("Circuit breaker triggered");
  }

  return primaryPrice;
}

async function setupPriceFeeds() {
  const cryptowatch = [], chainlink = [], uniswapV3 = [];

  const _startFeed = (feed) => {
    if (!feed) {
      return;
    }
    const [provider, id] = feed.split(":");
    switch (provider) {
      case "cryptowatch":
        if (!cryptowatch.includes(id)) {
          cryptowatch.push(id);
        }
        break;
      case "chainlink":
        if (!chainlink.includes(id)) {
          chainlink.push(id);
        }
        break;
      case "uniswapv3":
        if (!uniswapV3.includes(id)) {
          uniswapV3.push(id);
        }
        break;
      case "constant":
        PRICE_FEEDS["constant:" + id] = parseFloat(id);
        break;
      default:
        throw new Error(
          "Price feed provider " + provider + " is not available."
        );
        break;
    }
  }

  for (let market in MM_CONFIG.pairs) {
    const pairConfig = MM_CONFIG.pairs[market];
    if (!pairConfig.active) {
      continue;
    }
    // This is needed to make the price feed backwards compatalbe with old constant mode:
    // "DYDX-USDC": {
    //      "mode": "constant",
    //      "initPrice": 20,
    if (pairConfig.mode == "constant") {
      const initPrice = pairConfig.initPrice;
      pairConfig["priceFeedPrimary"] = "constant:" + initPrice.toString();
    }

    // parse keys to lower case to match later PRICE_FEED keys
    if (pairConfig.priceFeedPrimary) {
      const feed = pairConfig.priceFeedPrimary.toLowerCase();
      _startFeed(feed);
      MM_CONFIG.pairs[market].priceFeedPrimary = feed;
    }
    if (pairConfig.priceFeedSecondary) {
      const feed = pairConfig.priceFeedSecondary.toLowerCase();
      _startFeed(feed);
      MM_CONFIG.pairs[market].priceFeedSecondary = feed;
    }
  }

  VAULT_DEPOSIT_TOKENS.forEach(depositToken => {
    const depositConfig = MM_CONFIG.vault.depositTokens[depositToken];

    // parse keys to lower case to match later PRICE_FEED keys
    if (depositConfig.priceFeedPrimary) {
      const feed = depositConfig.priceFeedPrimary.toLowerCase();
      _startFeed(feed);
      MM_CONFIG.vault.depositTokens[depositToken].priceFeedPrimary = feed;
    }
    if (depositConfig.priceFeedSecondary) {
      const feed = depositConfig.priceFeedSecondary.toLowerCase();
      _startFeed(feed);
      MM_CONFIG.vault.depositTokens[depositToken].priceFeedSecondary = feed;
    }
  })

  if (chainlink.length > 0) await chainlinkSetup(chainlink);
  if (cryptowatch.length > 0) await cryptowatchWsSetup(cryptowatch);
  if (uniswapV3.length > 0) await uniswapV3Setup(uniswapV3);

  console.log(PRICE_FEEDS);
}

async function cryptowatchWsSetup(cryptowatchMarketIds) {
  // Set initial prices
  const cryptowatchApiKey = process.env.CRYPTOWATCH_API_KEY || MM_CONFIG.cryptowatchApiKey || process.env.CRYPTOWATCH_KEY;
  const cryptowatchMarkets = await fetch(
    "https://api.cryptowat.ch/markets?apikey=" + cryptowatchApiKey
  ).then((r) => r.json());
  const cryptowatchMarketPrices = await fetch(
    "https://api.cryptowat.ch/markets/prices?apikey=" + cryptowatchApiKey
  ).then((r) => r.json());
  for (let i in cryptowatchMarketIds) {
    const cryptowatchMarketId = cryptowatchMarketIds[i];
    try {
      const cryptowatchMarket = cryptowatchMarkets.result.find(
        (row) => row.id == cryptowatchMarketId
      );
      const exchange = cryptowatchMarket.exchange;
      const pair = cryptowatchMarket.pair;
      const key = `market:${exchange}:${pair}`;
      PRICE_FEEDS["cryptowatch:" + cryptowatchMarketIds[i]] =
        cryptowatchMarketPrices.result[key];
    } catch (e) {
      console.error(e);
      console.error(
        "Could not set price feed for cryptowatch:" + cryptowatchMarketId
      );
    }
  }

  const subscriptionMsg = {
    subscribe: {
      subscriptions: [],
    },
  };
  for (let i in cryptowatchMarketIds) {
    const cryptowatchMarketId = cryptowatchMarketIds[i];

    // first get initial price info

    subscriptionMsg.subscribe.subscriptions.push({
      streamSubscription: {
        resource: `markets:${cryptowatchMarketId}:book:spread`,
      },
    });
  }
  let cryptowatch_ws = new WebSocket(
    "wss://stream.cryptowat.ch/connect?apikey=" + cryptowatchApiKey
  );
  cryptowatch_ws.on("open", onopen);
  cryptowatch_ws.on("message", onmessage);
  cryptowatch_ws.on("close", onclose);
  cryptowatch_ws.on("error", console.error);

  function onopen() {
    cryptowatch_ws.send(JSON.stringify(subscriptionMsg));
  }
  function onmessage(data) {
    const msg = JSON.parse(data);
    if (!msg.marketUpdate) return;

    const marketId = "cryptowatch:" + msg.marketUpdate.market.marketId;
    let ask = msg.marketUpdate.orderBookSpreadUpdate.ask.priceStr;
    let bid = msg.marketUpdate.orderBookSpreadUpdate.bid.priceStr;
    let price = ask / 2 + bid / 2;
    PRICE_FEEDS[marketId] = price;
  }
  function onclose() {
    setTimeout(cryptowatchWsSetup, 5000, cryptowatchMarketIds);
  }
}

async function chainlinkSetup(chainlinkMarketAddress) {
  const results = chainlinkMarketAddress.map(async (address) => {
    try {
      const aggregatorV3InterfaceABI = JSON.parse(
        fs.readFileSync("ABIs/chainlinkV3InterfaceABI.abi")
      );
      const provider = new ethers.Contract(
        address,
        aggregatorV3InterfaceABI,
        ethersProvider
      );
      const decimals = await provider.decimals();
      const key = "chainlink:" + address;
      CHAINLINK_PROVIDERS[key] = [provider, decimals];

      // get inital price
      const response = await provider.latestRoundData();
      PRICE_FEEDS[key] = parseFloat(response.answer) / 10 ** decimals;
    } catch (e) {
      throw new Error(
        "Error while setting up chainlink for " + address + ", Error: " + e
      );
    }
  });
  await Promise.all(results);
  setInterval(chainlinkUpdate, 30000);
}

async function chainlinkUpdate() {
  try {
    await Promise.all(
      Object.keys(CHAINLINK_PROVIDERS).map(async (key) => {
        const [provider, decimals] = CHAINLINK_PROVIDERS[key];
        const response = await provider.latestRoundData();
        PRICE_FEEDS[key] = parseFloat(response.answer) / 10 ** decimals;
      })
    );
    chainlink_error_counter = 0;
  } catch (err) {
    chainlink_error_counter += 1;
    console.log(`Failed to update chainlink, retry: ${err.message}`);
    if (chainlink_error_counter > 4) {
      throw new Error("Failed to update chainlink since 150 seconds!");
    }
  }
}

async function uniswapV3Setup(uniswapV3Address) {
  const results = uniswapV3Address.map(async (address) => {
    try {
      const IUniswapV3PoolABI = JSON.parse(
        fs.readFileSync("ABIs/IUniswapV3Pool.abi")
      );

      const provider = new ethers.Contract(
        address,
        IUniswapV3PoolABI,
        ethersProvider
      );

      let [slot0, addressToken0, addressToken1] = await Promise.all([
        provider.slot0(),
        provider.token0(),
        provider.token1(),
      ]);

      const tokenProvier0 = new ethers.Contract(
        addressToken0,
        ERC20ABI,
        ethersProvider
      );
      const tokenProvier1 = new ethers.Contract(
        addressToken1,
        ERC20ABI,
        ethersProvider
      );

      let [decimals0, decimals1] = await Promise.all([
        tokenProvier0.decimals(),
        tokenProvier1.decimals(),
      ]);

      const key = "uniswapv3:" + address;
      const decimalsRatio = 10 ** decimals0 / 10 ** decimals1;
      UNISWAP_V3_PROVIDERS[key] = [provider, decimalsRatio];

      // get inital price
      const price =
        (slot0.sqrtPriceX96 * slot0.sqrtPriceX96 * decimalsRatio) / 2 ** 192;
      PRICE_FEEDS[key] = price;
    } catch (e) {
      throw new Error(
        "Error while setting up uniswapV3 for " + address + ", Error: " + e
      );
    }
  });
  await Promise.all(results);
  setInterval(uniswapV3Update, 30000);
}

async function uniswapV3Update() {
  try {
    await Promise.all(
      Object.keys(UNISWAP_V3_PROVIDERS).map(async (key) => {
        const [provider, decimalsRatio] = UNISWAP_V3_PROVIDERS[key];
        const slot0 = await provider.slot0();
        PRICE_FEEDS[key] =
          (slot0.sqrtPriceX96 * slot0.sqrtPriceX96 * decimalsRatio) / 2 ** 192;
      })
    );
    // reset error counter if successful
    uniswap_error_counter = 0;
  } catch (err) {
    uniswap_error_counter += 1;
    console.log(`Failed to update uniswap, retry: ${err.message}`);
    console.log(err.message);
    if (uniswap_error_counter > 4) {
      throw new Error("Failed to update uniswap since 150 seconds!");
    }
  }
}

async function sendOrders(marketId) {
  const pairConfig = MM_CONFIG.pairs[marketId];
  if (!pairConfig || !pairConfig.active) {
    if (!pairConfig) {
      console.error(`Missing pairConfig for ${marketId}`);
    }
    return;
  }

  let price;
  try {
    price = validatePriceFeedMarket(marketId);
  } catch (e) {
    console.error(`Can not sendOrders for ${marketId} because: ${e.message}`);
    return;
  }

  const [baseTokenAddress, quoteTokenAddress] = marketId.split('-')
  const baseTokenInfo = TOKEN_INFO[baseTokenAddress.toLowerCase()]
  const quoteTokenInfo = TOKEN_INFO[quoteTokenAddress.toLowerCase()]
  if (!baseTokenInfo || !quoteTokenInfo) {
    console.error(`Missing baseTokenInfo or quoteTokenInfo for sendOrders ${marketId}`);
    return;
  }

  const midPrice = pairConfig.invert ? 1 / price : price;
  if (!midPrice) {
    console.error(`Missing midPrice for sendOrders ${marketId}`);
    return;
  }

  const side = pairConfig.side || "d";
  const expires = ((Date.now() / 1000) | 0) + Math.max(pairConfig.expirationTimeSeconds || DEFAULT_EXPIRY, MIN_EXPIRY);
  const maxBaseBalance = BALANCES[baseTokenAddress].value;
  const maxQuoteBalance = BALANCES[quoteTokenAddress].value;
  const baseBalance = maxBaseBalance / 10 ** baseTokenInfo.decimals;
  const quoteBalance = maxQuoteBalance / 10 ** quoteTokenInfo.decimals;
  const maxSellSize = Math.min(baseBalance, pairConfig.maxSize);
  const maxBuySize = Math.min(quoteBalance / midPrice, pairConfig.maxSize);

  // dont do splits if under 1000 USD
  const usdBaseBalance = baseBalance * baseTokenInfo.usdPrice;
  const usdQuoteBalance = quoteBalance * quoteTokenInfo.usdPrice;
  let buySplits =
    usdQuoteBalance && usdQuoteBalance < 1000
      ? 1
      : pairConfig.numOrdersIndicated || 1;
  let sellSplits =
    usdBaseBalance && usdBaseBalance < 1000
      ? 1
      : pairConfig.numOrdersIndicated || 1;

  if (usdQuoteBalance && usdQuoteBalance < 10 * buySplits)
    buySplits = Math.floor(usdQuoteBalance / 10);
  if (usdBaseBalance && usdBaseBalance < 10 * sellSplits)
    sellSplits = Math.floor(usdBaseBalance / 10);

  for (let i = 1; i <= buySplits; i++) {
    const buyPrice =
      midPrice *
      (1 -
        pairConfig.minSpread -
        (pairConfig.slippageRate * maxBuySize * i) / buySplits);
    if (["b", "d"].includes(side)) {
      signAndSendOrder(
        marketId,
        "b",
        buyPrice,
        maxBuySize / buySplits,
        expires
      );
    }
  }
  for (let i = 1; i <= sellSplits; i++) {
    const sellPrice =
      midPrice *
      (1 +
        pairConfig.minSpread +
        (pairConfig.slippageRate * maxSellSize * i) / sellSplits);
    if (["s", "d"].includes(side)) {
      signAndSendOrder(
        marketId,
        "s",
        sellPrice,
        maxSellSize / sellSplits,
        expires
      );
    }
  }
}

async function sendOrdersVault() {
  if (!VAULT_TOKEN_ADDRESS) return

  try {
    const expires = ((Date.now() + sendOrdersVaultInterval * 2) / 1000) | 0;
    const usdHoldings = await _getHoldingsInUSD();
    const LPTokenDistributedBN = await VAULT_CONTRACT.circulatingSupply();
    const LPTokenDistributed = Number(ethers.utils.formatUnits(LPTokenDistributedBN, VAULT_DECIMALS));
    const trueLPTokenValue = LPTokenDistributed ? usdHoldings / LPTokenDistributed : VAULT_INITIAL_PRICE;

    // generate LP orders for each valid token
    const result = VAULT_DEPOSIT_TOKENS.map(async (tokenAddress) => {
      // only show orders for active pairs
      if (!MM_CONFIG.vault.depositTokens[tokenAddress].active) return;
      const priceFeedKey = MM_CONFIG.vault.depositTokens[tokenAddress].priceFeedPrimary;

      const market = `${VAULT_TOKEN_ADDRESS}-${tokenAddress}`;
      const tokenInfo = TOKEN_INFO[tokenAddress.toLowerCase()];
      if (!tokenInfo) return;

      // calculate the LP token price for this token
      const tokenPrice = getValidatedPriceDepositToken(tokenAddress)
      const LPPriceInKind = trueLPTokenValue / tokenPrice;

      const amountDeposit = ethers.utils.formatUnits(BALANCES[VAULT_TOKEN_ADDRESS].value, VAULT_DECIMALS);
      if (!amountDeposit) return;
      signAndSendOrder(
        market,
        's',
        LPPriceInKind * (1 + VAULT_DEPOSIT_FEE),
        amountDeposit,
        expires
      );

      const amountWithdraw = ethers.utils.formatUnits(BALANCES[tokenAddress].value, tokenInfo.decimals);
      if (!amountWithdraw) return;
      const withdrawPrice = LPPriceInKind * (1 - VAULT_WITHDRAW_FEE);
      signAndSendOrder(
        market,
        'b',
        withdrawPrice,
        amountWithdraw / withdrawPrice,
        expires
      );
    });
    await Promise.all(result);
  } catch (e) {
    console.log(`Could not send LP token offers: ${e.message}`);
    console.error(e);
  }
}

async function _getHoldingsInUSD() {
  const tokenAddresses = Object.keys(BALANCES);
  let usdHoldings = 0;
  for (let i = 0; i < tokenAddresses.length; i++) {
    const tokenAddress = tokenAddresses[i];

    // dont count the minted, but not distributed LP tokens
    if (tokenAddress === VAULT_TOKEN_ADDRESS) continue;

    const tokenInfo = TOKEN_INFO[tokenAddress.toLowerCase()];
    if (!tokenInfo) continue;

    const amount = ethers.utils.formatUnits(BALANCES[tokenAddress].value.toString(), tokenInfo.decimals);
    const tokenPrice = getValidatedPriceDepositToken(tokenAddress);
    usdHoldings += amount * tokenPrice;
  }

  return usdHoldings;
}

async function signAndSendOrder(
  marketId,
  side,
  price,
  size,
  expirationTimeSeconds
) {
  const [baseTokenAddress, quoteTokenAddress] = marketId.split('-')
  const baseTokenInfo = TOKEN_INFO[baseTokenAddress.toLowerCase()]
  const quoteTokenInfo = TOKEN_INFO[quoteTokenAddress.toLowerCase()]
  if (!baseTokenInfo || !quoteTokenInfo) return

  const baseAmount = size;
  const quoteAmount = size * price;

  const baseAmountBN = ethers.utils.parseUnits(
    Number(baseAmount).toFixed(baseTokenInfo.decimals),
    baseTokenInfo.decimals
  );
  const quoteAmountBN = ethers.utils.parseUnits(
    Number(quoteAmount).toFixed(quoteTokenInfo.decimals),
    quoteTokenInfo.decimals
  );

  let sellToken;
  let buyToken;
  let sellAmountBN;
  let buyAmountBN;
  let balanceBN = ethers.constants.Zero;
  if (side === "s") {
    sellToken = baseTokenInfo.address.toLowerCase();
    buyToken = quoteTokenInfo.address.toLowerCase();
    sellAmountBN = baseAmountBN;
    buyAmountBN = quoteAmountBN;
    balanceBN = BALANCES[baseTokenAddress].value;
  } else {
    sellToken = quoteTokenInfo.address.toLowerCase();
    buyToken = baseTokenInfo.address.toLowerCase();
    sellAmountBN = quoteAmountBN;
    buyAmountBN = baseAmountBN;
    balanceBN = BALANCES[quoteTokenAddress].value;
  }

  const userAccount = await getMMBotAccount();
  let domain, Order, types;

  if (balanceBN.lte(0)) return null;

  const delta = sellAmountBN.mul("100000").div(balanceBN).toNumber();
  // prevent dust issues
  if (delta > 99990) {
    // 99.9 %
    sellAmountBN = balanceBN;
    buyAmountBN = buyAmountBN.mul(100000).div(delta);
  }
  Order = {
    user: userAccount,
    sellToken,
    buyToken,
    sellAmount: sellAmountBN.toString(),
    buyAmount: buyAmountBN.toString(),
    expirationTimeSeconds: expirationTimeSeconds.toFixed(0),
  };

  const signature = await WALLET._signTypedData(EXCHANGE_INFO.domain, EXCHANGE_INFO.types, Order);

  try {
    if (VAULT_TOKEN_ADDRESS) {
      await fetch(MM_CONFIG.zigzagHttps + "/v1/order", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order: Order,
          signature: signature,
          signer: WALLET.address
        })
      })
    } else {
      await fetch(MM_CONFIG.zigzagHttps + "/v1/order", {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order: Order,
          signature: signature,
          user: userAccount
        })
      })
    }
  } catch (err) {
    console.warn('Failed to send orders')
  }
  const sellTokenInfo = TOKEN_INFO[sellToken.toLowerCase()]
  const buyTokenInfo = TOKEN_INFO[buyToken.toLowerCase()]
  const sellAmountReadable = Order.sellAmount / 10 ** sellTokenInfo.decimals;
  const buyAmountReadable = Order.buyAmount / 10 ** buyTokenInfo.decimals;
  console.log("Sell", sellAmountReadable, sellTokenInfo.symbol, ", Buy", buyAmountReadable, buyTokenInfo.symbol, ", Price", buyAmountReadable / sellAmountReadable, sellAmountReadable / buyAmountReadable);
}

async function checkOrders(marketId) {
  const pairConfig = MM_CONFIG.pairs[marketId];
  if (!pairConfig || !pairConfig.active || !pairConfig.minimumProfit) {
    if (!pairConfig) {
      console.error(`Missing pairConfig for ${marketId}`);
    }
    return;
  }

  if (!EXCHANGE_CONTRACT) {    
    console.error(`Missing exchange contract`);
    return;
  }

  let price;
  try {
    price = validatePriceFeedMarket(marketId);
  } catch (e) {
    console.error(`Can not sendOrders for ${marketId} because: ${e.message}`);
    return;
  }

  let [baseTokenAddress, quoteTokenAddress] = marketId.split('-');
  baseTokenAddress = baseTokenAddress.toLowerCase();
  quoteTokenAddress = quoteTokenAddress.toLowerCase();
  const baseTokenInfo = TOKEN_INFO[baseTokenAddress];
  const quoteTokenInfo = TOKEN_INFO[quoteTokenAddress];
  if (!baseTokenInfo || !quoteTokenInfo) {
    console.error(`Missing baseTokenInfo or quoteTokenInfo for sendOrders ${marketId}`);
    return;
  }

  const midPrice = pairConfig.invert ? 1 / price : price;
  if (!midPrice) {
    console.error(`Missing midPrice for sendOrders ${marketId}`);
    return;
  }

  let orders
  try {
    const response = await fetch(`${MM_CONFIG.zigzagHttps}/v1/orders?buyToken=${baseTokenAddress},${quoteTokenAddress}&sellToken=${baseTokenAddress},${quoteTokenAddress}`);
    if (response.status !== 200) return;

    const data = await response.json();
    orders = data.orders;
  } catch (err) {
    console.warn('Failed to send orders');
  }

  if (!orders) return;  
  const minProfitBase = Number(pairConfig.minimumProfit);
  const buyOrders = orders.filter(o => (o.order.buyToken === baseTokenAddress && o.order.sellToken === quoteTokenAddress));
  const sellOrders = orders.filter(o => (o.order.sellToken === baseTokenAddress && o.order.buyToken === quoteTokenAddress));

  const profitableOrders = []
  const buyOrderPromise = buyOrders.map(orderData => {
    const buyOrder = orderData.order;
    const baseAmount = ethers.utils.formatUnits(buyOrder.buyAmount, baseTokenInfo.decimals);
    const quoteAmount = ethers.utils.formatUnits(buyOrder.sellAmount, quoteTokenInfo.decimals);
    const orderPrice = quoteAmount / baseAmount;
    
    const fillAmountInBase = ethers.BigNumber.from(buyOrder.fillAmount).mul(buyOrder.buyAmount).div(buyOrder.sellAmount);
    const remainingBuyAmount = ethers.BigNumber.from(buyOrder.buyAmount).sub(fillAmountInBase);
    const remainingBaseAmount = ethers.utils.formatUnits(remainingBuyAmount, baseTokenInfo.decimals);

    const sellPrice = midPrice * (1 + pairConfig.minSpread + pairConfig.slippageRate * remainingBaseAmount);
    const balance = BALANCES[baseTokenAddress].value;
    
    const possibleProfit = remainingBaseAmount * (orderPrice - sellPrice);
    if (orderPrice > sellPrice && balance.gt(remainingBuyAmount) && possibleProfit > minProfitBase) {
      if (!filledOrderHashes.includes(orderData.hash)) {
        console.log("Found possible buy fill")
        profitableOrders.push({
          profit: possibleProfit,
          orderData: orderData
        })
      }
    }
  })
  const sellOrderPromise = sellOrders.map(orderData => {
    const sellOrder = orderData.order;
    const baseAmount = ethers.utils.formatUnits(sellOrder.sellAmount, baseTokenInfo.decimals);
    const quoteAmount = ethers.utils.formatUnits(sellOrder.buyAmount, quoteTokenInfo.decimals);
    const orderPrice = quoteAmount / baseAmount;

    const remainingBuyAmount = ethers.BigNumber.from(sellOrder.sellAmount).sub(sellOrder.fillAmount);
    const remainingBaseAmount = ethers.utils.formatUnits(remainingBuyAmount, baseTokenInfo.decimals);

    const buyPrice = midPrice * (1 - pairConfig.minSpread - pairConfig.slippageRate * remainingBaseAmount);
    const balance = BALANCES[baseTokenAddress].value;
    
    const possibleProfit = remainingBaseAmount * (buyPrice - orderPrice);
    if (orderPrice < buyPrice && balance.gt(remainingBuyAmount) && possibleProfit > minProfitBase) {
      if (!filledOrderHashes.includes(orderData.hash)) {
        console.log("Found possible sell fill")
        profitableOrders.push({
          profit: possibleProfit,
          orderData: orderData
        })
      }      
    }
  })

  await Promise.all([buyOrderPromise, sellOrderPromise]);

  profitableOrders.sort((a, b) => a.possibleProfit - b.possibleProfit);
  for (let i = 0; i < profitableOrders.length; i++) {
    try {
      console.log("starting to fill an order")
      const orderData = profitableOrders[i].orderData;
      filledOrderHashes.push(orderData.hash);

      const tx = await EXCHANGE_CONTRACT.fillOrderExactOutput([
          orderData.order.user,
          orderData.order.sellToken,
          orderData.order.buyToken,
          orderData.order.sellAmount,
          orderData.order.buyAmount,
          orderData.order.expirationTimeSeconds,
        ],
        orderData.signature,
        ethers.BigNumber.from(orderData.order.sellAmount).sub(orderData.order.fillAmount),
        false
      );
      const recipt = await tx.wait();
      if (recipt.status === 1) {
        console.log(`Filled a crossed order for a estimated profit of ${profitableOrders[i].possibleProfit} ${baseTokenInfo.symbol}`);
      } else {
        throw new Error('transaction failed!')
      }
    } catch(err) {
      console.warn(`Failed to send fill order, error: ${err.reason}`)
    }
  }
}

function getTokens() {
  const tokens = new Set();
  activePairs.forEach((pair) => {
    tokens.add(pair.split("-")[0]);
    tokens.add(pair.split("-")[1]);
  });

  if (VAULT_TOKEN_ADDRESS) {
    tokens.add(VAULT_TOKEN_ADDRESS);
    VAULT_DEPOSIT_TOKENS.forEach(depositToken => {
      tokens.add(depositToken);
    });
  }
  return [...tokens];
}

async function getBalances() {
  const tokens = getTokens();
  for (let i = 0; i < tokens.length; i++) {
    try {
      const tokenAddress = tokens[i];
      BALANCES[tokenAddress] = await getBalanceOfToken(tokenAddress, EXCHANGE_INFO.exchangeAddress);
    } catch (e) {
      console.error(`Failed to getBalances for ${tokenAddress}, because: ${e.message}`)
      throw new Error(e)
    }
  }
}

async function getBalanceOfToken(tokenAddress, contractAddress) {
  const account = await getMMBotAccount();
  let result = { value: 0, allowance: ethers.constants.Zero };
  if (!rollupProvider) return result;

  try {
    if (tokenAddress === ethers.constants.AddressZero) {
      result.value = await rollupProvider.getBalance(account);
      result.allowance = ethers.constants.MaxUint256;
      return result;
    }
    const tokenInfo = TOKEN_INFO[tokenAddress.toLowerCase()];

    if (!tokenInfo || !tokenInfo.address) return result;

    const contract = new ethers.Contract(
      tokenInfo.address,
      ERC20ABI,
      rollupProvider
    );
    result.value = await contract.balanceOf(account);
    if (contractAddress) {
      result.allowance = await contract.allowance(account, contractAddress);

      if (result.value.gte(result.allowance)) {
        console.log(`Sending approve for ${tokenInfo.name} - ${tokenInfo.address}`)
        if (VAULT_TOKEN_ADDRESS) {
          await VAULT_CONTRACT.approveToken(tokenInfo.address, contractAddress, ethers.constants.MaxUint256);
        } else {
          await contract.connect(WALLET).approve(contractAddress, ethers.constants.MaxUint256);
        }
      }
    } else {
      result.allowance = 0;
    }

    return result;
  } catch (e) {
    console.error(e);
    return result;
  }
}

async function getMMBotAccount() {
  return VAULT_TOKEN_ADDRESS ? VAULT_TOKEN_ADDRESS : WALLET.getAddress();
}
