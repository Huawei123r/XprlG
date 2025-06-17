// --- Core Imports ---
require('dotenv').config();
const { ethers } = require('ethers');
const inquirer = require('inquirer');
const chalk = require('chalk');
const winston = require('winston');
const fs = require('fs'); // For persistent state management
// --- Configuration Constants ---
const RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.xrplevm.org/';
const EXPLORER_TX_URL = "https://explorer.testnet.xrplevm.org/tx/";

// --- Wallets (Loaded from .env later) ---
let wallets = [];

// --- Global Provider ---
const provider = new ethers.JsonRpcProvider(RPC_URL);

// --- DELAYS ---
const DELAY_BETWEEN_ACTIONS = 200; // ms (was DELAY_BETWEEN_SWAPS)
const DELAY_BETWEEN_WALLETS = 500; // ms
const DELAY_AFTER_CYCLE = 5000; // ms

// --- GAS LIMITS ---
const GAS_LIMIT_ERC20 = 65000;
const GAS_LIMIT_XRP = 21000;
const GAS_LIMIT_COMPLEX = 200000;
const GAS_LIMIT_CUSTOM_CONTRACT = 150000; // For arbitrary contract calls

// --- CONTRACT ADDRESSES ---
// IMPORTANT: These addresses are now updated with the ones you found on the XRPL EVM Testnet!
const ROUTER_ADDRESS = "0x25734cf60ca213e4396b27d31215b026601e96b7";

const TOKENS = {
  "XRP":    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", // Common address for native ETH/XRP
  "RIBBIT": "0x73ee7BC68d3f07CfcD68776512b7317FE57E1939",
  "RISE":   "0x0c28777DEebe4589e83EF2Dc7833354e6a0aFF85",
  "WXRP":   "0x81Be083099c2C65b062378E74Fa8469644347BB7"
  // Add more tokens as needed
};

// --- Pairs for Swapping and Liquidity ---
const ALL_PAIRS = [
  ["XRP","RIBBIT"],
  ["XRP","RISE"],
  ["XRP","WXRP"],
  ["RIBBIT","RISE"],
  ["RISE","WXRP"],
  ["WXRP","RIBBIT"]
];

// --- Slippage Control ---
const SLIPPAGE_TOLERANCE_PERCENT = 0.5; // 0.5% slippage for swaps

// --- Token Amount Configuration for Smart Calculation ---
const TOKEN_AMOUNT_CONFIG = {
  DEFAULT: { type: "percentage", min: 0.005, max: 0.05 }, // Use 0.5% to 5% of the token's balance
  XRP:    { type: "range", min: 0.0001, max: 0.005 }, // For XRP, use a small fixed range
  RIBBIT: { type: "percentage", min: 0.01, max: 0.1 },  // For RIBBIT (200k+), use 1% to 10% of its balance
  RISE:   { type: "percentage", min: 0.01, max: 0.1 },  // Similar for RISE
  WXRP:   { type: "range", min: 0.0001, max: 0.005 }, // For WXRP, treat it like XRP for ranges
};

// --- Rebalancing Thresholds ---
const REBALANCE_THRESHOLDS = {
    XRP:    0.05,  // If XRP balance drops below 0.05, try to get more
    RIBBIT: 100,   // If RIBBIT balance drops below 100, try to get more
    RISE:   50,    // If RISE balance drops below 50, try to get more
    WXRP:   0.01,  // If WXRP balance drops below 0.01, try to get more
};

// --- Dynamic Action Weights ---
const ACTION_WEIGHTS = {
  swap: 40,
  send: 20,
  addLiquidity: 20,
  customContractCall: 20, // Keep this, but ensure you replace the placeholder address or comment it out if not using
};

// --- Telegram Alert Configuration ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- Persistent State Configuration ---
const STATE_FILE = 'bot_state.json';


// --- ABI Definitions ---
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) returns (uint[] memory)",
  "function swapExactETHForTokens(uint amountOutMin,address[] calldata path,address to,uint deadline) external payable returns (uint[] memory)",
  "function swapExactTokensForETH(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external returns (uint[] memory)",
  "function addLiquidityETH(address token,uint amountTokenDesired,uint amountTokenMin,uint amountETHMin,address to,uint deadline) external payable returns (uint amountToken,uint amountETH,uint liquidity)",
  "function getAmountsOut(uint256 amountIn, address[] memory path) view returns (uint256[] memory amounts)",
];

// --- NEW: Placeholder for Custom Contract Interactions ---
const CUSTOM_CONTRACTS_TO_INTERACT_WITH = [
    {
        name: "TestNFTContract",
        address: "0xYourTestNFTContractAddressHere", // <<< IMPORTANT: Replace with actual deployed NFT contract address, or comment out/remove this entry if not using.
        abi: [
            "function mint(address to, uint256 tokenId) public",
            "function tokenURI(uint256 tokenId) view returns (string)",
        ],
        functions: [
            { name: "mint", args: (wallet) => [wallet.address, Math.floor(Math.random() * 1000000)] },
        ]
    },
];

const ERC721_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function ownerOf(uint256 tokenId) view returns (address)",
    "function safeTransferFrom(address from, address to, uint256 tokenId) public",
    "function approve(address to, uint256 tokenId) public",
    "function getApproved(uint256 tokenId) view returns (address)",
    "function setApprovalForAll(address operator, bool approved) public",
    "function isApprovedForAll(address owner, address operator) view returns (bool)"
];


// --- Winston Logger Setup ---
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `${info.timestamp} [${info.level.toUpperCase()}] ${info.message}`)
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(info => `${info.timestamp} [${info.level.toUpperCase()}] ${info.message}`)
      ),
      level: 'info'
    }),
    new winston.transports.File({ filename: 'bot_activity.log', level: 'info' }),
    new winston.transports.File({ filename: 'bot_errors.log', level: 'error' }),
  ],
});


// --- Global Activity Stats & Persistent State ---
let activityStats = {
  swaps: 0,
  sends: 0,
  liquidityAdds: 0,
  liquidityRemovals: 0,
  rebalances: 0,
  customContractCalls: 0,
  successfulActions: 0,
  failedActions: 0,
  totalTransactions: 0,
  startTime: Date.now()
};

// --- NEW: Load Persistent State ---
function loadState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const rawData = fs.readFileSync(STATE_FILE);
            const loadedState = JSON.parse(rawData);
            Object.assign(activityStats, loadedState);
            logger.info(chalk.magenta(`Loaded previous bot state from ${STATE_FILE}.`));
            activityStats.startTime = loadedState.startTime || Date.now();
        } catch (error) {
            logger.error(chalk.red(`Error loading state from ${STATE_FILE}: ${error.message}. Starting fresh.`));
            activityStats = { swaps: 0, sends: 0, liquidityAdds: 0, liquidityRemovals: 0, rebalances: 0, customContractCalls: 0, successfulActions: 0, failedActions: 0, totalTransactions: 0, startTime: Date.now() };
        }
    } else {
        logger.info(chalk.magenta(`No previous state found. Starting fresh.`));
    }
}

// --- NEW: Save Persistent State ---
function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(activityStats, null, 2));
        logger.info(chalk.magenta(`Bot state saved to ${STATE_FILE}.`));
    } catch (error) {
        logger.error(chalk.red(`Error saving state to ${STATE_FILE}: ${error.message}`));
    }
}


// --- Utility Functions ---

function displayBanner() {
  console.log(chalk.hex("#8A2BE2").bold("███████████████████████████████████████"));
  console.log(chalk.hex("#8A2BE2").bold("█                                       █"));
  console.log(chalk.hex("#8A2BE2").bold("█         XRPL EVM BOT                █"));
  console.log(chalk.hex("#8A2BE2").bold("█          ( ﾟヮﾟ)                     █"));
  console.log(chalk.hex("#8A2BE2").bold("█                                       █"));
  console.log(chalk.hex("#8A2BE2").bold("███████████████████████████████████████"));
  console.log(chalk.hex("#D8BFD8")("         Automated DEX Interaction      "));
  console.log(chalk.hex("#D8BFD8")("         Built by Gemini AI             \n"));
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getGasPrice(retryAttempt = 0) {
    const feeData = await provider.getFeeData();
    // Significantly increased buffer for highly aggressive gas pricing on testnet
    let buffer = 5.0 + (retryAttempt * 1.0); // Initial 5x, then 6x, 7x, etc.

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        const maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * BigInt(Math.round(buffer * 100))) / BigInt(100);
        const baseFee = feeData.lastBaseFeePerGas || ethers.parseUnits("1", "gwei");
        const maxFeePerGas = ((baseFee * BigInt(Math.round(buffer * 100))) / BigInt(100)) + maxPriorityFeePerGas;

        logger.info(chalk.gray(`  Using EIP-1559 gas (Attempt ${retryAttempt + 1}): Max Priority Fee: ${ethers.formatUnits(maxPriorityFeePerGas, 'gwei')} Gwei, Max Fee: ${ethers.formatUnits(maxFeePerGas, 'gwei')} Gwei`));
        return { maxFeePerGas, maxPriorityFeePerGas };
    } else {
        const gasPrice = (feeData.gasPrice || ethers.parseUnits("20", "gwei"));
        const bufferedGasPrice = (gasPrice * BigInt(Math.round(buffer * 100))) / BigInt(100);
        logger.info(chalk.gray(`  Using legacy gas price (Attempt ${retryAttempt + 1}): ${ethers.formatUnits(bufferedGasPrice, 'gwei')} Gwei`));
        return { gasPrice: bufferedGasPrice };
    }
}

async function withRetry(func, maxRetries = 3, initialDelayMs = 1000, confirmationTimeoutMs = 60000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const gasOptions = await getGasPrice(i); // Fetch gas options here for each retry
            const tx = await func(gasOptions); // Pass gasOptions to the wrapped function
            logger.info(chalk.cyan(`Transaction sent: ${EXPLORER_TX_URL}${tx.hash}`));
            activityStats.totalTransactions++;

            const receipt = await Promise.race([
                tx.wait(),
                new Promise((resolve, reject) => setTimeout(() => reject(new Error("Transaction confirmation timed out.")), confirmationTimeoutMs))
            ]);

            if (receipt && receipt.status === 1) {
                logger.info(chalk.green(`✔ Transaction confirmed: Block ${receipt.blockNumber}`));
                return receipt;
            } else if (receipt && receipt.status === 0) {
                throw new Error(`Transaction failed on-chain (status 0): ${tx.hash}`);
            } else {
                throw new Error(`Transaction did not confirm or timed out: ${tx.hash}`);
            }
        } catch (error) {
            logger.warn(chalk.yellow(`Attempt ${i + 1}/${maxRetries} failed. Error: ${error.message}`));
            if (i < maxRetries - 1) {
                await delay(initialDelayMs * (i + 1));
            } else {
                throw error;
            }
        }
    }
}

async function getWalletTokenBalance(wallet, tokenSymbol) {
    if (tokenSymbol === "XRP") {
        const balance = await provider.getBalance(wallet.address);
        return ethers.formatEther(balance);
    } else {
        const tokenAddress = TOKENS[tokenSymbol];
        if (!tokenAddress) throw new Error(`Token address not found for symbol: ${tokenSymbol}`);
        const c = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const decs = await c.decimals();
        const bal = await c.balanceOf(wallet.address);
        return ethers.formatUnits(bal, decs);
    }
}

async function getWalletBalances(wallet) {
    const balances = {};
    for (const tokenSymbol in TOKENS) {
        try {
            balances[tokenSymbol] = await getWalletTokenBalance(wallet, tokenSymbol);
        } catch (error) {
            logger.warn(chalk.yellow(`Could not fetch balance for ${tokenSymbol} for wallet ${wallet.address}: ${error.message}`));
            balances[tokenSymbol] = "0";
        }
    }
    return balances;
}

// --- Core Interaction Functions ---

async function performSwap(wallet, pair, amount, direction, gasOptions) {
  const [A, B] = pair;
  const [inTok, outTok] = direction === "AtoB" ? [A, B] : [B, A];

  logger.info(chalk.blue(`SWAP: ${amount} ${inTok} → ${outTok}`));

  const currentInTokBalance = parseFloat(await getWalletTokenBalance(wallet, inTok));
  if (parseFloat(amount) > currentInTokBalance) {
    logger.warn(chalk.yellow(`Swap skipped for ${wallet.address}: Insufficient ${inTok} balance. Needed ${amount}, have ${currentInTokBalance}.`));
    throw new Error(`Insufficient ${inTok} balance.`);
  }

  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const providerRouter = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

  const path = [
    inTok === "XRP" ? TOKENS.WXRP : TOKENS[inTok],
    outTok === "XRP" ? TOKENS.WXRP : TOKENS[outTok]
  ];
  const deadline = Math.floor(Date.now() / 1e3) + 600;

  let amountInRaw;
  let amountOutMin = BigInt(0);

  if (inTok === "XRP") {
    amountInRaw = ethers.parseEther(amount);
  } else {
    const inTokenContract = new ethers.Contract(TOKENS[inTok], ERC20_ABI, provider);
    const inTokenDecimals = await inTokenContract.decimals();
    amountInRaw = ethers.parseUnits(amount, inTokenDecimals);
  }

  try {
    const amounts = await providerRouter.getAmountsOut(amountInRaw, path);
    const expectedAmountOutRaw = amounts[1];
    amountOutMin = expectedAmountOutRaw - (expectedAmountOutRaw * BigInt(Math.round(SLIPPAGE_TOLERANCE_PERCENT * 100))) / BigInt(10000);

    const outTokenDecimals = outTok === "XRP" ? 18 : await (new ethers.Contract(TOKENS[outTok], ERC20_ABI, provider)).decimals();
    logger.info(chalk.gray(`  Expected output: ${ethers.formatUnits(expectedAmountOutRaw, outTokenDecimals)} ${outTok}`));
    logger.info(chalk.gray(`  Min output (${SLIPPAGE_TOLERANCE_PERCENT}% slippage): ${ethers.formatUnits(amountOutMin, outTokenDecimals)} ${outTok}`));

  } catch (err) {
    logger.error(chalk.red(`  Failed to estimate swap output for slippage: ${err.message}. Proceeding with 0 min output.`));
    amountOutMin = BigInt(0); // Ensure amountOutMin is a BigInt
  }

  if (inTok === "XRP") {
    const currentXRPBalance = parseFloat(await getWalletTokenBalance(wallet, "XRP"));
    const estimatedGasCost = parseFloat(ethers.formatUnits(gasOptions.maxFeePerGas ? gasOptions.maxFeePerGas * BigInt(GAS_LIMIT_COMPLEX) : gasOptions.gasPrice * BigInt(GAS_LIMIT_COMPLEX), 'ether'));
    if (parseFloat(amount) + estimatedGasCost > currentXRPBalance) {
        logger.warn(chalk.yellow(`Swap skipped for ${wallet.address}: Insufficient XRP for transaction value + gas. Needed est. ${parseFloat(amount) + estimatedGasCost}, have ${currentXRPBalance}.`));
        throw new Error("Insufficient XRP for value + gas.");
    }

    await router.swapExactETHForTokens(amountOutMin, path, wallet.address, deadline, { value: amountInRaw, gasLimit: GAS_LIMIT_COMPLEX, ...gasOptions });
  } else {
    const tokenC = new ethers.Contract(TOKENS[inTok], ERC20_ABI, wallet);

    const currentAllowance = await tokenC.allowance(wallet.address, ROUTER_ADDRESS);
    if (currentAllowance < amountInRaw) {
        logger.info(chalk.blue(`Approving router for ${amount} ${inTok}...`));
        await tokenC.approve(ROUTER_ADDRESS, amountInRaw, { gasLimit: GAS_LIMIT_ERC20, ...gasOptions });
    } else {
       logger.info(chalk.gray(`Already approved enough ${inTok} for router.`));
    }

    const swapFn = outTok === "XRP"
      ? () => router.swapExactTokensForETH(amountInRaw, amountOutMin, path, wallet.address, deadline, { gasLimit: GAS_LIMIT_COMPLEX, ...gasOptions })
      : () => router.swapExactTokensForTokens(amountInRaw, amountOutMin, path, wallet.address, deadline, { gasLimit: GAS_LIMIT_COMPLEX, ...gasOptions });

    await swapFn();
  }
}

async function performSendAndReceive(wallet, cfg, gasOptions) {
  logger.info(chalk.blue(`SEND & RECEIVE: ${cfg.sendAmount} ${cfg.sendTokenName} to ${cfg.sendAddressCount} random addresses (funding new ones)...`));

  const amount = parseFloat(cfg.sendAmount);
  const token = TOKENS[cfg.sendTokenName];
  if (!token) throw new Error(`Token ${cfg.sendTokenName} not found.`);

  const currentTokenBalance = parseFloat(await getWalletTokenBalance(wallet, cfg.sendTokenName));
  const totalAmountNeeded = amount * cfg.sendAddressCount;
  if (totalAmountNeeded > currentTokenBalance) {
    logger.warn(chalk.yellow(`Send skipped for ${wallet.address}: Insufficient ${cfg.sendTokenName} balance. Needed ${totalAmountNeeded}, have ${currentTokenBalance}.`));
    throw new Error(`Insufficient ${cfg.sendTokenName} balance.`);
  }

  const tokenC = new ethers.Contract(token, ERC20_ABI, wallet);
  const decimals = await tokenC.decimals();
  const sendAmountRaw = ethers.parseUnits(cfg.sendAmount, decimals);

  for (let i = 0; i < cfg.sendAddressCount; i++) {
    const newWallet = ethers.Wallet.createRandom().connect(provider);
    const newAddress = newWallet.address;

    logger.info(chalk.gray(`  Funding new address ${newAddress} with 0.001 XRP...`));
    await wallet.sendTransaction({
        to: newAddress,
        value: ethers.parseEther("0.001"),
        gasLimit: GAS_LIMIT_XRP,
        ...gasOptions
      });

    logger.info(chalk.gray(`  Sending ${cfg.sendAmount} ${cfg.sendTokenName} to ${newAddress}...`));
    await tokenC.transfer(newAddress, sendAmountRaw, { gasLimit: GAS_LIMIT_ERC20, ...gasOptions });

    logger.info(chalk.gray(`  Sending back token from ${newAddress} to main wallet...`));
    const newWalletSigner = new ethers.Wallet(newWallet.privateKey, provider);
    const newTokenC = new ethers.Contract(token, ERC20_ABI, newWalletSigner);
    await newTokenC.transfer(wallet.address, sendAmountRaw, { gasLimit: GAS_LIMIT_ERC20, ...gasOptions });
  }
}

async function performRandomSend(wallet, cfg, gasOptions) {
  logger.info(chalk.blue(`RANDOM SEND: ${cfg.sendAmount} ${cfg.sendTokenName} to ${cfg.sendAddressCount} random addresses (no funding)...`));

  const amount = parseFloat(cfg.sendAmount);
  const token = TOKENS[cfg.sendTokenName];
  if (!token) throw new Error(`Token ${cfg.sendTokenName} not found.`);

  const currentTokenBalance = parseFloat(await getWalletTokenBalance(wallet, cfg.sendTokenName));
  const totalAmountNeeded = amount * cfg.sendAddressCount;
  if (totalAmountNeeded > currentTokenBalance) {
    logger.warn(chalk.yellow(`Send skipped for ${wallet.address}: Insufficient ${cfg.sendTokenName} balance. Needed ${totalAmountNeeded}, have ${currentTokenBalance}.`));
    throw new Error(`Insufficient ${cfg.sendTokenName} balance.`);
  }

  const tokenC = new ethers.Contract(token, ERC20_ABI, wallet);
  const decimals = await tokenC.decimals();
  const sendAmountRaw = ethers.parseUnits(cfg.sendAmount, decimals);

  for (let i = 0; i < cfg.sendAddressCount; i++) {
    const randomWallet = ethers.Wallet.createRandom();
    logger.info(chalk.gray(`  Sending ${cfg.sendAmount} ${cfg.sendTokenName} to ${randomWallet.address}...`));
    await tokenC.transfer(randomWallet.address, sendAmountRaw, { gasLimit: GAS_LIMIT_ERC20, ...gasOptions });
  }
}

async function performAddLiquidity(wallet, cfg, gasOptions) {
  logger.info(chalk.blue(`ADD LIQUIDITY: ${cfg.lpBaseAmount} XRP + ${cfg.lpTokenAmount} ${cfg.lpTokenName}`));

  const tokenAddress = TOKENS[cfg.lpTokenName];
  if (!tokenAddress) throw new Error(`Token address not found for symbol: ${cfg.lpTokenName}`);

  const currentXRPBalance = parseFloat(await getWalletTokenBalance(wallet, "XRP"));
  const currentTokenBalance = parseFloat(await getWalletTokenBalance(wallet, cfg.lpTokenName));
  const estimatedGasCost = parseFloat(ethers.formatUnits(gasOptions.maxFeePerGas ? gasOptions.maxFeePerGas * BigInt(GAS_LIMIT_COMPLEX) : gasOptions.gasPrice * BigInt(GAS_LIMIT_COMPLEX), 'ether'));

  if (parseFloat(cfg.lpBaseAmount) + estimatedGasCost > currentXRPBalance) {
    logger.warn(chalk.yellow(`Add LP skipped for ${wallet.address}: Insufficient XRP for base amount + gas. Needed est. ${parseFloat(cfg.lpBaseAmount) + estimatedGasCost}, have ${currentXRPBalance}.`));
    throw new Error(`Insufficient XRP for base amount + gas.`);
  }
  if (parseFloat(cfg.lpTokenAmount) > currentTokenBalance) {
    logger.warn(chalk.yellow(`Add LP skipped for ${wallet.address}: Insufficient ${cfg.lpTokenAmount} balance. Needed ${cfg.lpTokenAmount}, have ${currentTokenBalance}.`));
    throw new Error(`Insufficient ${cfg.lpTokenName} balance.`);
  }

  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const tokenC = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

  const decimals = await tokenC.decimals();
  const lpTokenAmountRaw = ethers.parseUnits(cfg.lpTokenAmount, decimals);
  const lpBaseAmountRaw = ethers.parseEther(cfg.lpBaseAmount);

  const deadline = Math.floor(Date.now() / 1e3) + 600;

  const currentAllowance = await tokenC.allowance(wallet.address, ROUTER_ADDRESS);
    if (currentAllowance < lpTokenAmountRaw) {
        logger.info(chalk.blue(`Approving router for ${cfg.lpTokenAmount} ${cfg.lpTokenName}...`));
        await tokenC.approve(ROUTER_ADDRESS, lpTokenAmountRaw, { gasLimit: GAS_LIMIT_ERC20, ...gasOptions });
    } else {
       logger.info(chalk.gray(`Already approved enough ${cfg.lpTokenName} for router.`));
    }

  await router.addLiquidityETH(
      tokenAddress,
      lpTokenAmountRaw,
      0, // amountTokenMin
      0, // amountETHMin
      wallet.address,
      deadline,
      { value: lpBaseAmountRaw, gasLimit: GAS_LIMIT_COMPLEX, ...gasOptions }
    );
}


async function performCustomContractCall(wallet, gasOptions) {
    logger.info(chalk.blue(`CUSTOM CONTRACT CALL: Executing a random contract function...`));

    if (CUSTOM_CONTRACTS_TO_INTERACT_WITH.length === 0) {
        logger.warn(chalk.yellow("No custom contracts configured for interaction. Skipping."));
        throw new Error("No custom contracts configured.");
    }

    const selectedContractConfig = CUSTOM_CONTRACTS_TO_INTERACT_WITH[Math.floor(Math.random() * CUSTOM_CONTRACTS_TO_INTERACT_WITH.length)];
    const contract = new ethers.Contract(selectedContractConfig.address, selectedContractConfig.abi, wallet);

    if (selectedContractConfig.functions.length === 0) {
        logger.warn(chalk.yellow(`No functions configured for contract ${selectedContractConfig.name}. Skipping.`));
        throw new Error(`No functions configured for ${selectedContractConfig.name}.`);
    }

    const selectedFunctionConfig = selectedContractConfig.functions[Math.floor(Math.random() * selectedFunctionConfig.length)];
    const functionName = selectedFunctionConfig.name;
    let functionArgs = [];

    if (typeof selectedFunctionConfig.args === 'function') {
        functionArgs = selectedFunctionConfig.args(wallet);
    } else if (Array.isArray(selectedFunctionConfig.args)) {
        functionArgs = selectedFunctionConfig.args;
    }

    logger.info(chalk.gray(`  Calling ${functionName}(${functionArgs.join(', ')}) on ${selectedContractConfig.name} (${selectedContractConfig.address})...`));

    try {
        await contract[functionName](...functionArgs, { gasLimit: GAS_LIMIT_CUSTOM_CONTRACT, ...gasOptions });
        logger.info(chalk.green(`✔ Custom contract call to ${functionName} completed.`));
        activityStats.successfulActions++;
    } catch (error) {
        logger.error(chalk.red(`Failed to call ${functionName} on ${selectedContractConfig.name}: ${error.message}`));
        activityStats.failedActions++;
        throw error;
    }
}


async function getCalculatedAmount(wallet, tokenSymbol) {
  const tokenConfig = TOKEN_AMOUNT_CONFIG[tokenSymbol] || TOKEN_AMOUNT_CONFIG.DEFAULT;
  let amount = 0;
  let balanceFormatted;
  let decimals;

  try {
    if (tokenSymbol === "XRP") {
      const balance = await provider.getBalance(wallet.address);
      if (balance === BigInt(0)) { // Explicitly handle BigInt(0)
          logger.warn(chalk.yellow(`Wallet ${wallet.address} has zero XRP. Cannot calculate amount.`));
          return "0"; // Return "0" if balance is zero
      }
      balanceFormatted = parseFloat(ethers.formatEther(balance));
      decimals = 18; // XRP has 18 decimals
    } else {
      const tokenAddress = TOKENS[tokenSymbol];
      if (!tokenAddress) {
          logger.warn(chalk.yellow(`Token address not found for symbol: ${tokenSymbol}. Cannot calculate amount.`));
          return "0"; // Return "0" if token address is not configured
      }
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      decimals = await tokenContract.decimals();
      const balance = await tokenContract.balanceOf(wallet.address);
      if (balance === BigInt(0)) { // Explicitly handle BigInt(0)
          logger.warn(chalk.yellow(`Wallet ${wallet.address} has zero ${tokenSymbol}. Cannot calculate amount.`));
          return "0"; // Return "0" if balance is zero
      }
      balanceFormatted = parseFloat(ethers.formatUnits(balance, decimals));
    }

    // Ensure amount is calculated as a number first, then converted to string
    if (tokenConfig.type === "fixed") {
      amount = parseFloat(tokenConfig.value);
    } else if (tokenConfig.type === "percentage") {
      const randomPct = (Math.random() * (tokenConfig.max - tokenConfig.min)) + tokenConfig.min;
      amount = balanceFormatted * randomPct;
    } else if (tokenConfig.type === "range") {
      amount = (Math.random() * (tokenConfig.max - tokenConfig.min)) + tokenConfig.min;
    }

    amount = Math.min(amount, balanceFormatted); // Ensure we don't try to use more than available
    
    // If amount is still very small or effectively zero after calculation, return "0"
    if (amount <= 0 || isNaN(amount)) { // Also check for NaN just in case
        logger.warn(chalk.yellow(`Calculated amount for ${tokenSymbol} for wallet ${wallet.address} is too small or invalid: ${amount}. Returning "0".`));
        return "0";
    }

    // Return the amount formatted as a string with appropriate precision
    // Use Math.max to ensure precision is at least 4 to avoid overly short numbers like 0.0
    return amount.toFixed(Math.max(4, decimals));
  } catch (error) {
    logger.warn(chalk.yellow(`Warning: Could not calculate amount for ${tokenSymbol} for wallet ${wallet.address}. ${error.message}. Returning "0".`));
    return "0"; // Always return "0" as a string on error
  }
}

async function checkAndRebalance(wallet) {
    logger.info(chalk.yellow(`Checking balances for rebalancing for wallet: ${wallet.address}`));
    const walletBalances = await getWalletBalances(wallet);

    // Prioritize rebalancing XRP if critically low
    if (parseFloat(walletBalances.XRP) < REBALANCE_THRESHOLDS.XRP) {
        logger.warn(chalk.yellow(`XRP balance low (${walletBalances.XRP}). Attempting to acquire more XRP...`));
        try {
            // Try to swap other tokens for XRP (or WXRP then unwrap if needed)
            let rebalanced = false;
            for (const tokenSymbol of Object.keys(TOKENS)) {
                if (tokenSymbol === "XRP" || parseFloat(walletBalances[tokenSymbol]) < REBALANCE_THRESHOLDS[tokenSymbol] * 2) {
                    continue; // Skip XRP itself, or if the other token is also low
                }
                const amountToSwap = (parseFloat(walletBalances[tokenSymbol]) * 0.05).toFixed(4); // Swap 5% of the other token
                // Ensure amountToSwap is valid before attempting
                if (parseFloat(amountToSwap) <= 0) {
                     logger.info(chalk.gray(`Calculated swap amount for ${tokenSymbol} is zero. Skipping rebalance.`));
                     continue;
                }
                logger.info(chalk.blue(`Attempting to swap ${amountToSwap} ${tokenSymbol} for XRP to rebalance XRP...`));
                // Call withRetry wrapper
                await withRetry(async (gasOptions) => {
                    await performSwap(wallet, [tokenSymbol, "XRP"], amountToSwap, "AtoB", gasOptions);
                });
                activityStats.rebalances++;
                rebalanced = true;
                break; // Only rebalance XRP once per check
            }
            if (!rebalanced) {
                logger.info(chalk.gray(`No suitable token found or available in sufficient quantity to rebalance XRP for wallet ${wallet.address}.`));
            }
        } catch (error) {
            logger.error(chalk.red(`Failed to rebalance XRP for wallet ${wallet.address}: ${error.message}`));
        }
        return; // After attempting XRP rebalance, return to allow other actions in the loop
    }

    // Rebalance other tokens if low, by swapping from XRP
    for (const tokenSymbol of Object.keys(REBALANCE_THRESHOLDS)) {
        if (tokenSymbol === "XRP") continue; // Already handled XRP
        const threshold = REBALANCE_THRESHOLDS[tokenSymbol];
        const currentBalance = parseFloat(walletBalances[tokenSymbol]);

        if (currentBalance < threshold) {
            logger.warn(chalk.yellow(`${tokenSymbol} balance low (${currentBalance}). Attempting to acquire more...`));
            try {
                if (parseFloat(walletBalances.XRP) > REBALANCE_THRESHOLDS.XRP * 2) { // Ensure enough XRP to swap
                    const amountToSwapXRP = (parseFloat(walletBalances.XRP) * 0.01).toFixed(4); // Swap 1% of XRP
                    // Ensure amountToSwapXRP is valid before attempting
                    if (parseFloat(amountToSwapXRP) <= 0) {
                        logger.info(chalk.gray(`Calculated swap amount for XRP is zero. Skipping rebalance.`));
                        continue;
                    }
                    logger.info(chalk.blue(`Attempting to swap ${amountToSwapXRP} XRP for ${tokenSymbol} to rebalance...`));
                    // Call withRetry wrapper
                    await withRetry(async (gasOptions) => {
                        await performSwap(wallet, ["XRP", tokenSymbol], amountToSwapXRP, "AtoB", gasOptions);
                    });
                    activityStats.rebalances++;
                } else {
                    logger.info(chalk.gray(`Not enough XRP to rebalance ${tokenSymbol} for wallet ${wallet.address}.`));
                }
            } catch (error) {
                logger.error(chalk.red(`Failed to rebalance ${tokenSymbol} for wallet ${wallet.address}: ${error.message}`));
            }
            return; // After attempting one token rebalance, return
        }
    }
}

function selectWeightedAction(weights) {
  let totalWeight = 0;
  for (const action in weights) {
    totalWeight += weights[action];
  }

  let randomNum = Math.random() * totalWeight;

  for (const action in weights) {
    randomNum -= weights[action];
    if (randomNum <= 0) {
      return action;
    }
  }
  return null;
}

async function sendAlert(message, type = "info") {
    const fullMessage = `*XRPL EVM Bot Alert [${type.toUpperCase()}]:*\n${message}`;
    logger.log(type, chalk.magenta(`ALERT DISPATCH: ${message}`));

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        logger.warn(chalk.yellow("Telegram bot token or chat ID not configured in .env. Skipping external alert."));
        return;
    }

    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: fullMessage,
                parse_mode: 'Markdown'
            })
        });
        const data = await response.json();
        if (!data.ok) {
            logger.error(chalk.red(`Failed to send Telegram alert: ${data.description}`));
        }
    } catch (error) {
        logger.error(chalk.red(`Error sending Telegram alert: ${error.message}`));
    }
}


// --- Main 24-Hour Random Loop Function ---
async function startRandomLoop(wallets) {
  displayBanner();
  logger.info(chalk.hex("#D8BFD8").bold("--- Starting 24-Hour Random Loop ---"));
  console.log(chalk.yellow("Press Ctrl+C to stop the loop at any time. Logs are in bot_activity.log"));

  const twentyFourHours = 24 * 60 * 60 * 1000;

  await sendAlert("XRPL EVM Bot started its 24-hour random interaction loop.", "info");

  const logPeriodicSummary = () => {
    const elapsedMs = Date.now() - activityStats.startTime;
    const elapsedHours = (elapsedMs / (1000 * 60 * 60)).toFixed(2);
    const elapsedMinutes = (elapsedMs / (1000 * 60)).toFixed(0);

    logger.info(chalk.hex("#FFA500").bold(`\n=== Activity Summary (Elapsed: ${elapsedHours} hours / ${elapsedMinutes} mins) ===`));
    logger.info(chalk.hex("#FFA500")(`  Swaps: ${activityStats.swaps}`));
    logger.info(chalk.hex("#FFA500")(`  Sends (Random/S&R): ${activityStats.sends}`));
    logger.info(chalk.hex("#FFA500")(`  Liquidity Added: ${activityStats.liquidityAdds}`));
    logger.info(chalk.hex("#FFA500")(`  Rebalances: ${activityStats.rebalances}`));
    logger.info(chalk.hex("#FFA500")(`  Custom Calls: ${activityStats.customContractCalls || 0}`));
    logger.info(chalk.hex("#FFA500")(`  Total Successful Actions: ${activityStats.successfulActions}`));
    logger.info(chalk.hex("#FFA500")(`  Total Failed Actions: ${activityStats.failedActions}`));
    logger.info(chalk.hex("#FFA500")(`  Total On-Chain Transactions: ${activityStats.totalTransactions}`));
    logger.info(chalk.hex("#FFA500").bold(`======================================\n`));

    sendAlert(`*XRPL EVM Bot Progress:*\n` +
             `*Elapsed:* ${elapsedHours} hours / ${elapsedMinutes} mins\n` +
             `*Swaps:* ${activityStats.swaps}\n` +
             `*Sends:* ${activityStats.sends}\n` +
             `*LP Added:* ${activityStats.liquidityAdds}\n` +
             `*Custom Calls:* ${activityStats.customContractCalls || 0}\n` +
             `*Rebalances:* ${activityStats.rebalances}\n` +
             `*Successful Actions:* ${activityStats.successfulActions}\n` +
             `*Failed Actions:* ${activityStats.failedActions}\n` +
             `*Total On-Chain TXs:* ${activityStats.totalTransactions}`, 'info');

    saveState();
  };

  const summaryInterval = setInterval(logPeriodicSummary, 30 * 60 * 1000);

  process.on("SIGINT", () => {
    clearInterval(summaryInterval);
    logPeriodicSummary();
    sendAlert("XRPL EVM Bot interrupted and shutting down.", "warn");
    process.exit(0);
  });

  while (Date.now() - activityStats.startTime < twentyFourHours) {
    for (const wallet of wallets) {
      logger.info(chalk.yellow(`\nProcessing Wallet: ${wallet.address}`));

      try {
          await checkAndRebalance(wallet);
          await delay(DELAY_BETWEEN_ACTIONS);
      } catch (err) {
          logger.error(chalk.red(`Rebalance attempt failed for wallet ${wallet.address}: ${err.message}`));
          await sendAlert(`Rebalance for wallet ${wallet.address.slice(0,6)}... failed: ${err.message}`, 'error');
      }

      let success = false;
      let retries = 3;

      while (!success && retries > 0) {
        try {
          const chosenAction = selectWeightedAction(ACTION_WEIGHTS);
          logger.info(chalk.gray(`Selected action for wallet ${wallet.address.slice(0, 6)}...: ${chosenAction}`));

          switch (chosenAction) {
            case 'swap':
              const swapPair = ALL_PAIRS[Math.floor(Math.random() * ALL_PAIRS.length)];
              const swapDirection = Math.random() < 0.5 ? "AtoB" : "BtoA";
              const inTok = swapDirection === "AtoB" ? swapPair[0] : swapPair[1];

              const swapAmount = await getCalculatedAmount(wallet, inTok);
              if (swapAmount === "0") {
                  logger.warn(chalk.yellow(`Skipping swap due to insufficient or invalid calculated amount for ${inTok}.`));
                  success = true; // Mark as success to move to next wallet/action
                  continue;
              }
              // Corrected call: withRetry provides gasOptions
              await withRetry(async (gasOptions) => {
                await performSwap(wallet, swapPair, swapAmount, swapDirection, gasOptions);
              });
              activityStats.swaps++;
              activityStats.successfulActions++;
              break;

            case 'send':
              const sendType = Math.random() < 0.5 ? "randomSend" : "sendAndReceive";
              const availableTokensForSend = Object.keys(TOKENS).filter(t => t !== "XRP");
              if (availableTokensForSend.length === 0) {
                logger.warn(chalk.yellow("No ERC20 tokens configured to send. Skipping send action."));
                success = true;
                continue;
              }
              const sendTokenName = availableTokensForSend[Math.floor(Math.random() * availableTokensForSend.length)];

              const sendAmount = await getCalculatedAmount(wallet, sendTokenName);
              if (sendAmount === "0") {
                  logger.warn(chalk.yellow(`Skipping send due to insufficient or invalid calculated amount for ${sendTokenName}.`));
                  success = true; // Mark as success to move to next wallet/action
                  continue;
              }

              const sendCfg = { sendTokenName, sendAddressCount: 1, sendAmount };
              // Corrected calls: withRetry provides gasOptions
              if (sendType === "sendAndReceive") {
                await withRetry(async (gasOptions) => {
                  await performSendAndReceive(wallet, sendCfg, gasOptions);
                });
              } else {
                await withRetry(async (gasOptions) => {
                  await performRandomSend(wallet, sendCfg, gasOptions);
                });
              }
              activityStats.sends++;
              activityStats.successfulActions++;
              break;

            case 'addLiquidity':
              const availableLPTokens = Object.keys(TOKENS).filter(t => t !== "XRP");
              if (availableLPTokens.length === 0) {
                logger.warn(chalk.yellow("No ERC20 tokens configured for liquidity. Skipping add liquidity action."));
                success = true;
                continue;
              }
              const lpTokenName = availableLPTokens[Math.floor(Math.random() * availableLPTokens.length)];

              const lpBaseAmount = await getCalculatedAmount(wallet, "XRP");
              const lpTokenAmount = await getCalculatedAmount(wallet, lpTokenName);
              if (lpBaseAmount === "0" || lpTokenAmount === "0") {
                  logger.warn(chalk.yellow(`Skipping add liquidity due to insufficient or invalid calculated amounts.`));
                  success = true; // Mark as success to move to next wallet/action
                  continue;
              }

              const addLpCfg = { lpBaseAmount, lpTokenAmount, lpTokenName };
              // Corrected call: withRetry provides gasOptions
              await withRetry(async (gasOptions) => {
                await performAddLiquidity(wallet, addLpCfg, gasOptions);
              });
              activityStats.liquidityAdds++;
              activityStats.successfulActions++;
              break;

            case 'customContractCall':
                activityStats.customContractCalls = (activityStats.customContractCalls || 0); // Initialize if undefined
                // Corrected call: withRetry provides gasOptions
                await withRetry(async (gasOptions) => {
                    await performCustomContractCall(wallet, gasOptions);
                });
                activityStats.customContractCalls++;
                activityStats.successfulActions++;
                break;


            default:
              logger.warn(chalk.yellow(`Unknown action chosen: ${chosenAction}. Skipping.`));
              success = true;
              break;
          }
          success = true;
          await delay(DELAY_BETWEEN_ACTIONS);
        } catch (err) {
          logger.error(chalk.red(`Action failed for wallet ${wallet.address}: ${err.message}`), err);
          activityStats.failedActions++;
          retries--;
          if (retries > 0) {
            logger.warn(chalk.yellow(`Retrying action for wallet ${wallet.address} (${retries} retries left)...`));
            await delay(DELAY_BETWEEN_ACTIONS * 2);
          } else {
              await sendAlert(`Wallet ${wallet.address.slice(0,6)}... was skipped for a full cycle due to repeated transaction failures: ${err.message}`, 'error');
          }
        }
      }

      if (!success) {
        logger.error(chalk.red(`Skipping wallet ${wallet.address} for this cycle due to repeated failures.`));
        await sendAlert(`Wallet ${wallet.address.slice(0,6)}... was skipped for a full cycle due to repeated transaction failures.`, 'warn');
      }
      await delay(DELAY_BETWEEN_WALLETS);
    }
    logger.info(chalk.gray("\nAll wallets processed for this cycle. Waiting for next cycle..."));
    await delay(DELAY_AFTER_CYCLE);
  }

  clearInterval(summaryInterval);
  logPeriodicSummary();
  logger.info(chalk.green("\n24-hour random interaction loop finished!"));
  await sendAlert("XRPL EVM Bot completed its 24-hour random interaction loop. Final summary sent.", "info");

  console.log();
  await inquirer.prompt([{ name: "dummy", type: "input", message: "Press Enter to return to menu…" }]);
}


// --- Main Menu Function ---
async function runMenu(wallets) {
  while (true) {
    displayBanner();
    const { action } = await inquirer.prompt([{
      name: "action",
      type: "list",
      message: "Select action:",
      choices: [
        { name: "1) Check all balances",  value: "checkBalances" },
        { name: "2) Perform single swap", value: "singleSwap" },
        { name: "3) Perform single token send", value: "singleSend" },
        { name: "4) Perform single add liquidity", value: "singleAddLiquidity" },
        { name: "5) Start 24-Hour Random Loop", value: "randomLoop" },
        { name: "6) Exit",           value: "exit" },
      ]
    }]);

    switch (action) {
      case "checkBalances":
        logger.info(chalk.hex("#D8BFD8").bold("--- Checking All Balances ---"));
        for (const wallet of wallets) {
          logger.info(chalk.yellow(`\nWallet: ${wallet.address}`));
          const balances = await getWalletBalances(wallet);
          for (const tokenSymbol in balances) {
            logger.info(`  ${tokenSymbol}: ${balances[tokenSymbol]}`);
          }
        }
        console.log();
        await inquirer.prompt([{ name: "dummy", type: "input", message: "Press Enter to continue…" }]);
        break;

      case "singleSwap":
        logger.info(chalk.hex("#D8BFD8").bold("--- Performing Single Swap ---"));
        const swapQs = [
          {
            name: "walletIndex",
            type: "list",
            message: "Select wallet:",
            choices: wallets.map((w, i) => ({ name: `${w.address.slice(0, 10)}...`, value: i })),
          },
          {
            name: "pairIndex",
            type: "list",
            message: "Select swap pair (e.g., XRP/RIBBIT):",
            choices: ALL_PAIRS.map((p, i) => ({ name: `${p[0]}/${p[1]}`, value: i })),
          },
          { name: "amount", type: "input", message: "Amount to swap:", validate: input => !isNaN(parseFloat(input)) && parseFloat(input) > 0 ? true : "Please enter a valid positive number." },
          { name: "direction", type: "list", message: "Swap direction:", choices: ["AtoB", "BtoA"] },
        ];
        const swapCfg = await inquirer.prompt(swapQs);
        const selectedWalletSwap = wallets[swapCfg.walletIndex];
        const selectedPairSwap = ALL_PAIRS[swapCfg.pairIndex];

        try {
          await withRetry(async (gasOptions) => { // Make the inner function async and accept gasOptions
            await performSwap(selectedWalletSwap, selectedPairSwap, swapCfg.amount, swapCfg.direction, gasOptions);
          });
        } catch (err) {
          logger.error(chalk.red(`Swap failed: ${err.message}`));
        }
        console.log();
        await inquirer.prompt([{ name: "dummy", type: "input", message: "Press Enter to continue…" }]);
        break;

      case "singleSend":
        logger.info(chalk.hex("#D8BFD8").bold("--- Performing Single Token Send ---"));
        const sendQs = [
          {
            name: "walletIndex",
            type: "list",
            message: "Select wallet:",
            choices: wallets.map((w, i) => ({ name: `${w.address.slice(0, 10)}...`, value: i })),
          },
          {
            name: "sendTokenName",
            type: "list",
            message: "Select token to send:",
            choices: Object.keys(TOKENS).filter(t => t !== "XRP"),
          },
          {
            name: "sendAddressCount",
            type: "input",
            message: "Number of addresses to send to:",
            default: "1",
            validate: input => parseInt(input) > 0 ? true : "Enter a positive number."
          },
          { name: "sendAmount", type: "input", message: "Amount to send per address:", validate: input => !isNaN(parseFloat(input)) && parseFloat(input) > 0 ? true : "Please enter a valid positive number." },
          { name: "sendType", type: "list", message: "Send type:", choices: ["randomSend", "sendAndReceive"] },
        ];
        const sendCfg = await inquirer.prompt(sendQs);
        const selectedWalletSend = wallets[sendCfg.walletIndex];
        sendCfg.sendAddressCount = parseInt(sendCfg.sendAddressCount, 10);

        try {
          if (sendCfg.sendType === "sendAndReceive") {
            await withRetry(async (gasOptions) => { // Make the inner function async and accept gasOptions
              await performSendAndReceive(selectedWalletSend, sendCfg, gasOptions);
            });
          } else {
            await withRetry(async (gasOptions) => { // Make the inner function async and accept gasOptions
              await performRandomSend(selectedWalletSend, sendCfg, gasOptions);
            });
          }
        } catch (err) {
          logger.error(chalk.red(`Send failed: ${err.message}`));
        }
        console.log();
        await inquirer.prompt([{ name: "dummy", type: "input", message: "Press Enter to continue…" }]);
        break;

      case "singleAddLiquidity":
        logger.info(chalk.hex("#D8BFD8").bold("--- Performing Single Add Liquidity ---"));
        const addLpQs = [
          {
            name: "walletIndex",
            type: "list",
            message: "Select wallet:",
            choices: wallets.map((w, i) => ({ name: `${w.address.slice(0, 10)}...`, value: i })),
          },
          {
            name: "lpTokenName",
            type: "list",
            message: "Select ERC20 token for LP (paired with XRP):",
            choices: Object.keys(TOKENS).filter(t => t !== "XRP"),
          },
          { name: "lpBaseAmount", type: "input", message: "Amount of XRP for LP:", validate: input => !isNaN(parseFloat(input)) && parseFloat(input) > 0 ? true : "Please enter a valid positive number." },
          { name: "lpTokenAmount", type: "input", message: "Amount of token for LP:", validate: input => !isNaN(parseFloat(input)) && parseFloat(input) > 0 ? true : "Please enter a valid positive number." },
        ];
        const addLpCfg = await inquirer.prompt(addLpQs);
        const selectedWalletAddLp = wallets[addLpCfg.walletIndex];

        try {
          await withRetry(async (gasOptions) => { // Make the inner function async and accept gasOptions
            await performAddLiquidity(selectedWalletAddLp, addLpCfg, gasOptions);
          });
        } catch (err) {
          logger.error(chalk.red(`Add Liquidity failed: ${err.message}`));
        }
        console.log();
        await inquirer.prompt([{ name: "dummy", type: "input", message: "Press Enter to continue…" }]);
        break;

      case "randomLoop":
        await startRandomLoop(wallets);
        break;

      case "exit":
        logger.info(chalk.hex("#D8BFD8").bold("Exiting bot. Goodbye!"));
        await sendAlert("XRPL EVM Bot is manually shutting down.", "info");
        return;
    }
  }
}

// --- Main Execution ---
async function main() {
  displayBanner();
  logger.info(chalk.hex("#D8BFD8").bold("Initializing XRPL EVM Bot…"));

  try {
    await testRpc();
  } catch (error) {
    logger.error(chalk.red(`Failed to connect to RPC URL ${RPC_URL}: ${error.message}`));
    process.exit(1);
  }

  const keys = Object.entries(process.env)
    .filter(([k]) => k.startsWith("PRIVATE_KEY_"))
    .map(([,v]) => v);

  if (keys.length === 0) {
    logger.error(chalk.red("No PRIVATE_KEY_N found in .env. Please add at least one private key."));
    process.exit(1);
  }

  wallets = keys.map(key => new ethers.Wallet(key, provider));
  logger.info(chalk.green(`Loaded ${wallets.length} wallet(s).`));

  loadState();

  await runMenu(wallets);
}

async function testRpc() {
  try {
    const network = await provider.getNetwork();
    logger.info(chalk.green(`Connected to network: ${network.name} (Chain ID: ${network.chainId})`));
  } catch (error) {
    throw new Error(`RPC connection failed: ${error.message}`);
  }
}

main().catch(error => {
  logger.error(chalk.red(`Fatal error in main execution: ${error.message}`), error);
  sendAlert(`Fatal error: ${error.message}`, 'error');
  process.exit(1);
});
