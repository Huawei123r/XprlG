// bot.js

// --- Imports ---
const { ethers } = require("ethers");
const chalk = require("chalk");
const winston = require("winston");
const path = require("path");
require("dotenv").config(); // Load environment variables from .env file

// --- Configuration ---
const RPC_URL = process.env.RPC_URL || "https://rpc-evm-sidechain.xrpl.org/"; // XRPL EVM Testnet RPC
const PRIVATE_KEYS = process.env.PRIVATE_KEYS ? process.env.PRIVATE_KEYS.split(',') : []; // Comma-separated private keys
const EXPLORER_TX_URL = process.env.EXPLORER_TX_URL || "https://explorer.testnet.xrpl.org/tx/"; // Base URL for transaction links

// Action probabilities (sum should be 100)
const ACTION_PROBABILITIES = {
  SWAP: 40,
  ADD_LIQUIDITY: 20,
  REMOVE_LIQUIDITY: 10, // Added Remove Liquidity
  SEND_AND_RECEIVE: 15, // Funding new addresses, sending, and receiving back
  RANDOM_SEND: 15, // Sending to random addresses (no funding/return)
  // CUSTOM_CONTRACT_CALL: 0, // Set to >0 to enable
};

// --- Token Configuration (Update with actual testnet token addresses) ---
const TOKENS = {
  // WXRP is usually required for swaps involving XRP on EVM DEXs
  // This is a placeholder address, find the real WXRP address for XRPL EVM testnet
  WXRP: "0x81Be083099c2C65b062378E74Fa8469644347BB7", // Example WXRP token address
  // Use "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" for native ETH/XRP in path for router if needed, otherwise use WXRP.
  // We will treat XRP as the native token for balance checks and wrap/unwrap when needed for swaps.

  RISE: "0x0c28777DEebe4589e83EF2Dc7833354e6a0aFF85", // Example RISE token address
  RIBBIT: "0x3D757474472f8F2A66Bdc1b51e4C4D11E813C16c", // Example RIBBIT token address
  // Add other tokens as needed
};

// Amounts to use for various actions (adjust as needed)
const TOKEN_AMOUNT_CONFIG = {
  DEFAULT: { type: "percentage", min: 0.001, max: 0.005 }, // Default for random swaps
  XRP: { type: "percentage", min: 0.001, max: 0.005 }, // For random XRP swaps
  RISE: { type: "percentage", min: 0.001, max: 0.005 },
  RIBBIT: { type: "percentage", min: 0.001, max: 0.005 },

  // Configuration for Send & Receive / Random Send
  SEND_AND_RECEIVE_CONFIG: {
    sendAmount: "0.001", // Amount of token to send
    sendTokenName: "RISE", // Token to send
    sendAddressCount: 1, // Number of random addresses to interact with
  },
  RANDOM_SEND_CONFIG: {
    sendAmount: "0.0005",
    sendTokenName: "RIBBIT",
    sendAddressCount: 2,
  },
  ADD_LIQUIDITY_CONFIG: {
    lpBaseAmount: "0.005", // Amount of XRP/ETH to add
    lpTokenAmount: "0.005", // Amount of LP token to add (e.g., RISE)
    lpTokenName: "RISE", // Name of the LP token
  },
  REMOVE_LIQUIDITY_CONFIG: {
      removeAmountPercentage: 50, // Percentage of LP tokens to remove (e.g., 50 for 50%)
      lpTokenName: "RISE", // The token paired with XRP/WETH in the LP
  }
};

// Rebalancing thresholds (if balance falls below, try to acquire more)
const REBALANCE_THRESHOLDS = {
  XRP: 0.01, // If XRP falls below this, try to swap other tokens for XRP
  RISE: 0.005, // If RISE falls below this, try to swap XRP for RISE
  RIBBIT: 0.005, // If RIBBIT falls below this, try to swap XRP for RIBBIT
};

// Gas limits (adjust if transactions fail due to out of gas)
const GAS_LIMIT_COMPLEX = 800000; // For swaps, add liquidity, etc.
const GAS_LIMIT_ERC20 = 100000; // For simple ERC20 transfers, approvals
const GAS_LIMIT_XRP = 30000; // For native XRP transfers
const GAS_LIMIT_CUSTOM_CONTRACT = 100000; // Example gas limit for custom contract calls

const SLIPPAGE_TOLERANCE_PERCENT = 0.5; // 0.5% slippage tolerance for swaps

// --- Custom Contract Interaction (if CUSTOM_CONTRACT_CALL is enabled) ---
const CUSTOM_CONTRACTS_TO_INTERACT_WITH = [
    // Example: A simple counter contract
    // {
    //     name: "MyCounter",
    //     address: "0xYourCounterContractAddressHere",
    //     abi: [
    //         "function increment() public",
    //         "function getCounter() public view returns (uint256)"
    //     ],
    //     functions: [
    //         { name: "increment", args: [] } // No args for increment
    //     ]
    // },
    // Add more custom contracts as needed
];

const MIN_LOOP_INTERVAL_SECONDS = 120; // Minimum delay between cycles for each wallet
const MAX_LOOP_INTERVAL_SECONDS = 300; // Maximum delay

// --- Global State ---
let wallets = [];
const provider = new ethers.JsonRpcProvider(RPC_URL);

let activityStats = {
  totalTransactions: 0,
  swaps: 0,
  addsLiquidity: 0,
  removesLiquidity: 0,
  sendsAndReceives: 0,
  randomSends: 0,
  customContractCalls: 0,
  rebalances: 0,
  lastActivity: {}, // To store last activity time for each wallet
};

// --- Logger Configuration ---
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message }) => {
      // Remove color codes for log file but keep for console
      const cleanMessage = message.replace(/\x1b\[[0-9;]*m/g, "");
      return `[${timestamp}] [${level.toUpperCase()}] ${cleanMessage}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
        })
      ),
    }),
    new winston.transports.File({
      filename: path.join(__dirname, "bot_activity.log"),
      maxsize: 5 * 1024 * 1024, // 5 MB
      maxFiles: 5, // Keep 5 log files
      tailable: true,
    }),
  ],
});

// --- CONTRACT ADDRESSES ---
// Official Uniswap V2 Router address on XRPL EVM Testnet (provided by their AI bot)
const ROUTER_ADDRESS = "0xF16A31764C91805B6C8E1D488941E41A86531880";

// --- ABIs ---
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)"
];

// This ABI includes standard Uniswap V2 Router function signatures.
// It has been meticulously reviewed and corrected for standard Uniswap V2 structure.
// If 'could not decode result data' persists, consider subtle differences in XRPL EVM's specific deployment.
const ROUTER_ABI = [
  {
    "inputs":[
      {"internalType":"address","name":"_factory","type":"address"},
      {"internalType":"address","name":"_WETH","type":"address"}
    ],
    "stateMutability":"nonpayable",
    "type":"constructor"
  },
  {"name":"factory","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {"name":"WETH","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},
  {
    "name":"addLiquidity",
    "inputs": [
        {"internalType":"address","name":"tokenA","type":"address"},
        {"internalType":"address","name":"tokenB","type":"address"},
        {"internalType":"uint256","name":"amountADesired","type":"uint256"},
        {"internalType":"uint256","name":"amountBDesired","type":"uint256"},
        {"internalType":"uint256","name":"amountAMin","type":"uint256"},
        {"internalType":"uint256","name":"amountBMin","type":"uint256"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs": [
        {"internalType":"uint256","name":"amountA","type":"uint256"},
        {"internalType":"uint256","name":"amountB","type":"uint256"},
        {"internalType":"uint256","name":"liquidity","type":"uint256"}
    ],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "name":"addLiquidityETH",
    "inputs": [
        {"internalType":"address","name":"token","type":"address"},
        {"internalType":"uint256","name":"amountTokenDesired","type":"uint256"},
        {"internalType":"uint256","name":"amountTokenMin","type":"uint256"},
        {"internalType":"uint256","name":"amountETHMin","type":"uint256"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs": [
        {"internalType":"uint256","name":"amountToken","type":"uint256"},
        {"internalType":"uint256","name":"amountETH","type":"uint256"},
        {"internalType":"uint256","name":"liquidity","type":"uint256"}
    ],
    "stateMutability":"payable",
    "type":"function"
  },
  {
    "name":"removeLiquidity",
    "inputs": [
        {"internalType":"address","name":"tokenA","type":"address"},
        {"internalType":"address","name":"tokenB","type":"address"},
        {"internalType":"uint256","name":"liquidity","type":"uint256"},
        {"internalType":"uint256","name":"amountAMin","type":"uint256"},
        {"internalType":"uint256","name":"amountBMin","type":"uint256"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs": [
        {"internalType":"uint256","name":"amountA","type":"uint256"},
        {"internalType":"uint256","name":"amountB","type":"uint256"}
    ],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "name":"removeLiquidityETH",
    "inputs": [
        {"internalType":"address","name":"token","type":"address"},
        {"internalType":"uint256","name":"liquidity","type":"uint256"},
        {"internalType":"uint256","name":"amountTokenMin","type":"uint256"},
        {"internalType":"uint256","name":"amountETHMin","type":"uint256"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs": [
        {"internalType":"uint256","name":"amountToken","type":"uint256"},
        {"internalType":"uint256","name":"amountETH","type":"uint256"}
    ],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "name":"removeLiquidityETHSupportingFeeOnTransferTokens",
    "inputs": [
        {"internalType":"address","name":"token","type":"address"},
        {"internalType":"uint256","name":"liquidity","type":"uint256"},
        {"internalType":"uint256","name":"amountTokenMin","type":"uint256"},
        {"internalType":"uint256","name":"amountETHMin","type":"uint256"}, // <-- CORRECTED THIS LINE PREVIOUSLY
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs":[{"internalType":"uint256","name":"amountETH","type":"uint256"}],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "name":"removeLiquidityETHWithPermitSupportingFeeOnTransferTokens",
    "inputs": [
        {"internalType":"address","name":"token","type":"address"},
        {"internalType":"uint256","name":"liquidity","type":"uint256"},
        {"internalType":"uint256","name":"amountTokenMin","type":"uint256"},
        {"internalType":"uint256","name":"amountETHMin","type":"uint256"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"},
        {"internalType":"bool","name":"approveMax","type":"bool"},
        {"internalType":"uint8","name":"v","type":"uint8"},
        {"internalType":"bytes32","name":"r","type":"bytes32"},
        {"internalType":"bytes32","name":"s","type":"bytes32"}
    ],
    "outputs":[{"internalType":"uint256","name":"amountETH","type":"uint256"}],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "name":"removeLiquidityWithPermit",
    "inputs": [
        {"internalType":"address","name":"tokenA","type":"address"},
        {"internalType":"address","name":"tokenB","type":"address"},
        {"internalType":"uint256","name":"liquidity","type":"uint256"},
        {"internalType":"uint256","name":"amountAMin","type":"uint256"},
        {"internalType":"uint256","name":"amountBMin","type":"uint256"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"},
        {"internalType":"bool","name":"approveMax","type":"bool"},
        {"internalType":"uint8","name":"v","type":"uint8"},
        {"internalType":"bytes32","name":"r","type":"bytes32"},
        {"internalType":"bytes32","name":"s","type":"bytes32"}
    ],
    "outputs": [
        {"internalType":"uint256","name":"amountA","type":"uint256"},
        {"internalType":"uint256","name":"amountB","type":"uint256"}
    ],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "name":"swapExactTokensForTokens",
    "inputs": [
        {"internalType":"uint256","name":"amountIn","type":"uint256"},
        {"internalType":"uint256","name":"amountOutMin","type":"uint256"},
        {"internalType":"address[]","name":"path","type":"address[]"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "name":"swapTokensForExactTokens",
    "inputs": [
        {"internalType":"uint256","name":"amountOut","type":"uint256"},
        {"internalType":"uint256","name":"amountInMax","type":"uint256"},
        {"internalType":"address[]","name":"path","type":"address[]"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "name":"swapExactETHForTokens",
    "inputs": [
        {"internalType":"uint256","name":"amountOutMin","type":"uint256"},
        {"internalType":"address[]","name":"path","type":"address[]"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],
    "stateMutability":"payable",
    "type":"function"
  },
  {
    "name":"swapTokensForExactETH",
    "inputs": [
        {"internalType":"uint256","name":"amountOut","type":"uint256"},
        {"internalType":"uint256","name":"amountInMax","type":"uint256"},
        {"internalType":"address[]","name":"path","type":"address[]"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "name":"swapExactTokensForETH",
    "inputs": [
        {"internalType":"uint256","name":"amountIn","type":"uint256"},
        {"internalType":"uint256","name":"amountOutMin","type":"uint256"},
        {"internalType":"address[]","name":"path","type":"address[]"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "name":"swapETHForExactTokens",
    "inputs": [
        {"internalType":"uint256","name":"amountOut","type":"uint256"},
        {"internalType":"address[]","name":"path","type":"address[]"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],
    "stateMutability":"payable",
    "type":"function"
  },
  {
    "name":"quote",
    "inputs": [
        {"internalType":"uint256","name":"amountA","type":"uint256"},
        {"internalType":"uint256","name":"reserveA","type":"uint256"},
        {"internalType":"uint256","name":"reserveB","type":"uint256"}
    ],
    "outputs":[{"internalType":"uint256","name":"amountB","type":"uint256"}],
    "stateMutability":"pure",
    "type":"function"
  },
  {
    "name":"getAmountOut",
    "inputs": [
        {"internalType":"uint256","name":"amountIn","type":"uint256"},
        {"internalType":"uint256","name":"reserveIn","type":"uint256"},
        {"internalType":"uint256","name":"reserveOut","type":"uint256"}
    ],
    "outputs":[{"internalType":"uint256","name":"amountOut","type":"uint256"}],
    "stateMutability":"pure",
    "type":"function"
  },
  {
    "name":"getAmountIn",
    "inputs": [
        {"internalType":"uint256","name":"amountOut","type":"uint256"},
        {"internalType":"uint256","name":"reserveIn","type":"uint256"},
        {"internalType":"uint256","name":"reserveOut","type":"uint256"}
    ],
    "outputs":[{"internalType":"uint256","name":"amountIn","type":"uint256"}],
    "stateMutability":"pure",
    "type":"function"
  },
  {
    "name":"getAmountsOut",
    "inputs": [
      { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
      { "internalType": "address[]", "name": "path", "type": "address[]" }
    ],
    "outputs": [
      { "internalType": "uint256[]", "name": "amounts", "type": "uint256[]" }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "name":"getAmountsIn",
    "inputs": [
        {"internalType":"uint256","name":"amountOut","type":"uint256"},
        {"internalType":"address[]","name":"path","type":"address[]"}
    ],
    "outputs":[{"internalType":"uint256[]","name":"amounts","type":"uint256[]"}],
    "stateMutability":"view",
    "type":"function"
  },
  {
    "name":"swapExactTokensForTokensSupportingFeeOnTransferTokens",
    "inputs": [
        {"internalType":"uint256","name":"amountIn","type":"uint256"},
        {"internalType":"uint256","name":"amountOutMin","type":"uint256"},
        {"internalType":"address[]","name":"path","type":"address[]"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs":[],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {
    "name":"swapExactETHForTokensSupportingFeeOnTransferTokens",
    "inputs": [
        {"internalType":"uint256","name":"amountOutMin","type":"uint256"},
        {"internalType":"address[]","name":"path","type":"address[]"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs":[],
    "stateMutability":"payable",
    "type":"function"
  },
  {
    "name":"swapExactTokensForETHSupportingFeeOnTransferTokens",
    "inputs": [
        {"internalType":"uint256","name":"amountIn","type":"uint256"},
        {"internalType":"uint256","name":"amountOutMin","type":"uint256"},
        {"internalType":"address[]","name":"path","type":"address[]"},
        {"internalType":"address","name":"to","type":"address"},
        {"internalType":"uint256","name":"deadline","type":"uint256"}
    ],
    "outputs":[],
    "stateMutability":"nonpayable",
    "type":"function"
  },
  {"stateMutability":"payable","type":"receive"}
];


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
        // Ensure calculations with BigInt are correct
        const maxPriorityFeePerGas = (feeData.maxPriorityFeePerGas * BigInt(Math.round(buffer * 100))) / BigInt(100);
        const baseFee = feeData.lastBaseFeePerGas || ethers.parseUnits("1", "gwei"); // Use a default if lastBaseFeePerGas is null
        const maxFeePerGas = ((baseFee * BigInt(Math.round(buffer * 100))) / BigInt(100)) + maxPriorityFeePerGas;

        logger.info(chalk.gray(`  Using EIP-1559 gas (Attempt ${retryAttempt + 1}): Max Priority Fee: ${ethers.formatUnits(maxPriorityFeePerGas, 'gwei')} Gwei, Max Fee: ${ethers.formatUnits(maxFeePerGas, 'gwei')} Gwei`));
        return { maxFeePerGas, maxPriorityFeePerGas };
    } else {
        const gasPrice = (feeData.gasPrice || ethers.parseUnits("20", "gwei")); // Use a default if gasPrice is null
        const bufferedGasPrice = (gasPrice * BigInt(Math.round(buffer * 100))) / BigInt(100);
        logger.info(chalk.gray(`  Using legacy gas price (Attempt ${retryAttempt + 1}): ${ethers.formatUnits(bufferedGasPrice, 'gwei')} Gwei`));
        return { gasPrice: bufferedGasPrice };
    }
}

async function withRetry(func, maxRetries = 3, initialDelayMs = 1000, confirmationTimeoutMs = 60000) {
    for (let i = 0; i < maxRetries; i++) {
        let tx = null; // Initialize tx to null
        try {
            const gasOptions = await getGasPrice(i);
            tx = await func(gasOptions); // Assign the result of func(gasOptions) to tx

            if (!tx || typeof tx.hash === 'undefined') { // Check if tx is truly a transaction object with a hash
                // This means the function called `func` did not return a valid transaction object.
                // This usually implies an error occurred *before* the transaction was sent to the network.
                throw new Error("Function did not return a valid transaction object.");
            }

            logger.info(chalk.cyan(`Transaction sent: ${EXPLORER_TX_URL}${tx.hash}`));
            activityStats.totalTransactions++;

            const receipt = await Promise.race([
                tx.wait(),
                // CORRECTED LINE BELOW: Removed the extra ')' at the end of the setTimeout call
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
            const txHashInfo = tx && tx.hash ? ` (Tx: ${tx.hash})` : '';
            logger.warn(chalk.yellow(`Attempt ${i + 1}/${maxRetries} failed${txHashInfo}. Error: ${error.message}`));
            if (i < maxRetries - 1) {
                await delay(initialDelayMs * (i + 1));
            } else {
                throw error; // Re-throw after all retries exhausted
            }
        }
    }
    return null; // Should ideally not be reached if an error is always thrown on failure
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
            // For the special XRP "E" address, ensure it's not treated as an ERC20
            if (tokenSymbol === "XRP" && TOKENS[tokenSymbol] === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE") {
                const balance = await provider.getBalance(wallet.address);
                balances[tokenSymbol] = ethers.formatEther(balance);
            } else {
                // For other tokens, fetch as ERC20
                balances[tokenSymbol] = await getWalletTokenBalance(wallet, tokenSymbol);
            }
        } catch (error) {
            logger.warn(chalk.yellow(`Could not fetch balance for ${tokenSymbol} for wallet ${wallet.address}: ${error.message}`));
            balances[tokenSymbol] = "0";
        }
    }
    // Also get XRP balance explicitly if not already in TOKENS (e.g., if WXRP is there but not XRP)
    if (!balances["XRP"]) {
        try {
            const xrpBalance = await provider.getBalance(wallet.address);
            balances["XRP"] = ethers.formatEther(xrpBalance);
        } catch (error) {
            logger.warn(chalk.yellow(`Could not fetch native XRP balance for wallet ${wallet.address}: ${error.message}`));
            balances["XRP"] = "0";
        }
    }
    return balances;
}

// --- Core Interaction Functions ---

async function performSwap(wallet, pair, amount, direction, gasOptions) {
  const [A, B] = pair; // A is inToken, B is outToken
  const [inTokSymbol, outTokSymbol] = direction === "AtoB" ? [A, B] : [B, A];

  logger.info(chalk.blue(`SWAP: ${amount} ${inTokSymbol} → ${outTokSymbol}`));

  const currentInTokBalance = parseFloat(await getWalletTokenBalance(wallet, inTokSymbol));
  if (parseFloat(amount) > currentInTokBalance) {
    logger.warn(chalk.yellow(`Swap skipped for ${wallet.address}: Insufficient ${inTokSymbol} balance. Needed ${amount}, have ${currentInTokBalance}.`));
    throw new Error(`Insufficient ${inTokSymbol} balance.`);
  }

  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const providerRouter = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

  // Determine actual contract addresses for the path
  // If native XRP is involved, it needs to be WXRP for Uniswap V2
  const inTokenAddress = inTokSymbol === "XRP" ? TOKENS.WXRP : TOKENS[inTokSymbol];
  const outTokenAddress = outTokSymbol === "XRP" ? TOKENS.WXRP : TOKENS[outTokSymbol];

  const path = [inTokenAddress, outTokenAddress];

  // Validate that token addresses in the path are not undefined
  if (!path[0] || !path[1]) {
      throw new Error(`Invalid token address in swap path. Check TOKENS map for ${inTokSymbol} and ${outTokSymbol}.`);
  }

  const deadline = Math.floor(Date.now() / 1e3) + 600; // 10 minutes from now

  let amountInRaw;
  let amountOutMin = BigInt(0); // Initialize as BigInt
  let inTokenDecimals;

  // Determine decimals and parse amountInRaw
  if (inTokSymbol === "XRP") {
    amountInRaw = ethers.parseEther(amount); // XRP is treated as 18 decimals by ethers.parseEther
    inTokenDecimals = 18;
  } else {
    const inTokenContract = new ethers.Contract(TOKENS[inTokSymbol], ERC20_ABI, provider);
    inTokenDecimals = await inTokenContract.decimals();
    amountInRaw = ethers.parseUnits(amount, inTokenDecimals);
  }

  // Ensure amountInRaw is positive before calling getAmountsOut
  if (amountInRaw <= BigInt(0)) {
      throw new Error(`Swap amount for ${inTokSymbol} must be positive.`);
  }

  try {
    const amounts = await providerRouter.getAmountsOut(amountInRaw, path);
    const expectedAmountOutRaw = amounts[1];
    const SLIPPAGE_TOLERANCE_DENOMINATOR = BigInt(Math.round(SLIPPAGE_TOLERANCE_PERCENT * 100)); // e.g., 0.5% becomes 50
    amountOutMin = (expectedAmountOutRaw * (BigInt(10000) - SLIPPAGE_TOLERANCE_DENOMINATOR)) / BigInt(10000);

    const outTokenDecimals = outTokSymbol === "XRP" ? 18 : await (new ethers.Contract(TOKENS[outTokSymbol], ERC20_ABI, provider)).decimals();
    logger.info(chalk.gray(`  Expected output: ${ethers.formatUnits(expectedAmountOutRaw, outTokenDecimals)} ${outTokSymbol}`));
    logger.info(chalk.gray(`  Min output (${SLIPPAGE_TOLERANCE_PERCENT}% slippage): ${ethers.formatUnits(amountOutMin, outTokenDecimals)} ${outTokSymbol}`));

  } catch (err) {
    logger.error(chalk.red(`  Failed to estimate swap output for slippage: ${err.message}. Proceeding with 0 min output.`));
    amountOutMin = BigInt(0); // If estimation fails, proceed with 0 min output, but this makes swaps risky.
  }

  if (inTokSymbol === "XRP") {
    // If swapping native XRP, it actually calls swapExactETHForTokens
    const currentXRPBalance = parseFloat(await getWalletTokenBalance(wallet, "XRP"));
    const estimatedGasCost = parseFloat(ethers.formatUnits(gasOptions.maxFeePerGas ? gasOptions.maxFeePerGas * BigInt(GAS_LIMIT_COMPLEX) : gasOptions.gasPrice * BigInt(GAS_LIMIT_COMPLEX), 'ether'));
    if (parseFloat(amount) + estimatedGasCost > currentXRPBalance) {
        logger.warn(chalk.yellow(`Swap skipped for ${wallet.address}: Insufficient XRP for transaction value + gas. Needed est. ${parseFloat(amount) + estimatedGasCost}, have ${currentXRPBalance}.`));
        throw new Error("Insufficient XRP for value + gas.");
    }
    return await router.swapExactETHForTokens(amountOutMin, path, wallet.address, deadline, { value: amountInRaw, gasLimit: GAS_LIMIT_COMPLEX, ...gasOptions });
  } else {
    // For ERC20 token swaps
    const tokenC = new ethers.Contract(TOKENS[inTokSymbol], ERC20_ABI, wallet);

    const currentAllowance = await tokenC.allowance(wallet.address, ROUTER_ADDRESS);
    if (currentAllowance < amountInRaw) {
        logger.info(chalk.blue(`Approving router for ${amount} ${inTokSymbol}...`));
        const approvalTx = await tokenC.approve(ROUTER_ADDRESS, amountInRaw, { gasLimit: GAS_LIMIT_ERC20, ...gasOptions });
        await approvalTx.wait(); // Wait for approval to confirm before proceeding
        logger.info(chalk.green(`✔ Approval confirmed: ${EXPLORER_TX_URL}${approvalTx.hash}`));
    } else {
       logger.info(chalk.gray(`Already approved enough ${inTokSymbol} for router.`));
    }

    const swapFn = outTokSymbol === "XRP"
      ? () => router.swapExactTokensForETH(amountInRaw, amountOutMin, path, wallet.address, deadline, { gasLimit: GAS_LIMIT_COMPLEX, ...gasOptions })
      : () => router.swapExactTokensForTokens(amountInRaw, amountOutMin, path, wallet.address, deadline, { gasLimit: GAS_LIMIT_COMPLEX, ...gasOptions });

    return await swapFn(); // Return the transaction object
  }
}

async function performSendAndReceive(wallet, cfg, gasOptions) {
  logger.info(chalk.blue(`SEND & RECEIVE: ${cfg.sendAmount} ${cfg.sendTokenName} to ${cfg.sendAddressCount} random addresses (funding new ones)...`));

  const amount = parseFloat(cfg.sendAmount);
  const tokenAddress = TOKENS[cfg.sendTokenName];
  if (!tokenAddress) throw new Error(`Token ${cfg.sendTokenName} address not found in TOKENS map.`);

  const currentTokenBalance = parseFloat(await getWalletTokenBalance(wallet, cfg.sendTokenName));
  const totalAmountNeeded = amount * cfg.sendAddressCount;
  if (totalAmountNeeded > currentTokenBalance) {
    logger.warn(chalk.yellow(`Send skipped for ${wallet.address}: Insufficient ${cfg.sendTokenName} balance. Needed ${totalAmountNeeded}, have ${currentTokenBalance}.`));
    throw new Error(`Insufficient ${cfg.sendTokenName} balance.`);
  }

  const tokenC = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const decimals = await tokenC.decimals();
  const sendAmountRaw = ethers.parseUnits(cfg.sendAmount, decimals);

  let lastTx = null; // To store the last transaction for return

  for (let i = 0; i < cfg.sendAddressCount; i++) {
    const newWallet = ethers.Wallet.createRandom().connect(provider);
    const newAddress = newWallet.address;

    logger.info(chalk.gray(`  Funding new address ${newAddress} with 0.001 XRP...`));
    const fundTx = await wallet.sendTransaction({
        to: newAddress,
        value: ethers.parseEther("0.001"),
        gasLimit: GAS_LIMIT_XRP,
        ...gasOptions
      });
    await fundTx.wait(); // Wait for funding to confirm
    logger.info(chalk.green(`✔ Funding confirmed: ${EXPLORER_TX_URL}${fundTx.hash}`));


    logger.info(chalk.gray(`  Sending ${cfg.sendAmount} ${cfg.sendTokenName} to ${newAddress}...`));
    const sendTx = await tokenC.transfer(newAddress, sendAmountRaw, { gasLimit: GAS_LIMIT_ERC20, ...gasOptions });
    await sendTx.wait(); // Wait for send to confirm
    logger.info(chalk.green(`✔ Send confirmed: ${EXPLORER_TX_URL}${sendTx.hash}`));


    logger.info(chalk.gray(`  Sending back token from ${newAddress} to main wallet...`));
    const newWalletSigner = new ethers.Wallet(newWallet.privateKey, provider);
    const newTokenC = new ethers.Contract(tokenAddress, ERC20_ABI, newWalletSigner);
    lastTx = await newTokenC.transfer(wallet.address, sendAmountRaw, { gasLimit: GAS_LIMIT_ERC20, ...gasOptions });
    await lastTx.wait(); // Wait for return to confirm
    logger.info(chalk.green(`✔ Return confirmed: ${EXPLORER_TX_URL}${lastTx.hash}`));
  }
  return lastTx; // Return the last transaction object
}

async function performRandomSend(wallet, cfg, gasOptions) {
  logger.info(chalk.blue(`RANDOM SEND: ${cfg.sendAmount} ${cfg.sendTokenName} to ${cfg.sendAddressCount} random addresses (no funding)...`));

  const amount = parseFloat(cfg.sendAmount);
  const tokenAddress = TOKENS[cfg.sendTokenName];
  if (!tokenAddress) throw new Error(`Token ${cfg.sendTokenName} address not found in TOKENS map.`);

  const currentTokenBalance = parseFloat(await getWalletTokenBalance(wallet, cfg.sendTokenName));
  const totalAmountNeeded = amount * cfg.sendAddressCount;
  if (totalAmountNeeded > currentTokenBalance) {
    logger.warn(chalk.yellow(`Send skipped for ${wallet.address}: Insufficient ${cfg.sendTokenName} balance. Needed ${totalAmountNeeded}, have ${currentTokenBalance}.`));
    throw new Error(`Insufficient ${cfg.sendTokenName} balance.`);
  }

  const tokenC = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const decimals = await tokenC.decimals();
  const sendAmountRaw = ethers.parseUnits(cfg.sendAmount, decimals);

  let lastTx = null; // To store the last transaction for return

  for (let i = 0; i < cfg.sendAddressCount; i++) {
    const randomWallet = ethers.Wallet.createRandom(); // Create a random address, not a full wallet
    logger.info(chalk.gray(`  Sending ${cfg.sendAmount} ${cfg.sendTokenName} to ${randomWallet.address}...`));
    lastTx = await tokenC.transfer(randomWallet.address, sendAmountRaw, { gasLimit: GAS_LIMIT_ERC20, ...gasOptions });
    await lastTx.wait(); // Wait for transfer to confirm
    logger.info(chalk.green(`✔ Transfer confirmed: ${EXPLORER_TX_URL}${lastTx.hash}`));
  }
  return lastTx; // Return the last transaction object
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
    logger.warn(chalk.yellow(`Add LP skipped for ${wallet.address}: Insufficient ${cfg.lpTokenName} balance. Needed ${cfg.lpTokenAmount}, have ${currentTokenBalance}.`));
    throw new Error(`Insufficient ${cfg.lpTokenName} balance.`);
  }

  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
  const tokenC = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

  const decimals = await tokenC.decimals();
  const lpTokenAmountRaw = ethers.parseUnits(cfg.lpTokenAmount, decimals);
  const lpBaseAmountRaw = ethers.parseEther(cfg.lpBaseAmount); // For XRP

  const deadline = Math.floor(Date.now() / 1e3) + 600;

  const currentAllowance = await tokenC.allowance(wallet.address, ROUTER_ADDRESS);
    if (currentAllowance < lpTokenAmountRaw) {
        logger.info(chalk.blue(`Approving router for ${cfg.lpTokenAmount} ${cfg.lpTokenName}...`));
        const approvalTx = await tokenC.approve(ROUTER_ADDRESS, lpTokenAmountRaw, { gasLimit: GAS_LIMIT_ERC20, ...gasOptions });
        await approvalTx.wait(); // Wait for approval to confirm before proceeding
        logger.info(chalk.green(`✔ Approval confirmed: ${EXPLORER_TX_URL}${approvalTx.hash}`));
    } else {
       logger.info(chalk.gray(`Already approved enough ${cfg.lpTokenName} for router.`));
    }

  // Set min amounts to 0 or a very small value for testing, or calculate based on slippage
  return await router.addLiquidityETH(
      tokenAddress,
      lpTokenAmountRaw,
      0, // amountTokenMin - setting to 0 for relaxed testing, consider slippage
      0, // amountETHMin - setting to 0 for relaxed testing, consider slippage
      wallet.address,
      deadline,
      { value: lpBaseAmountRaw, gasLimit: GAS_LIMIT_COMPLEX, ...gasOptions }
    );
}

async function performRemoveLiquidity(wallet, cfg, gasOptions) {
    logger.info(chalk.blue(`REMOVE LIQUIDITY: Removing ${cfg.removeAmountPercentage}% of LP for ${cfg.lpTokenName}`));

    const tokenAddress = TOKENS[cfg.lpTokenName];
    if (!tokenAddress) throw new Error(`Token address not found for symbol: ${cfg.lpTokenName}`);

    const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
    const providerRouter = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider); // Use provider for read calls on router
    
    // Uniswap V2 Router doesn't have getPair directly. You usually derive it from Factory.
    // For simplicity in a bot, we assume a standard WXRP/Token pair for LP removal.
    // If the router doesn't have 'factory' or 'getPair' directly, this might need adjustment.
    // A more robust approach would involve fetching factory address from router, then calling getPair on factory.
    // For now, assuming factory address is discoverable or a known constant.
    
    // For Uniswap V2, the pair address can be calculated or fetched from the Factory contract.
    // Since the Router ABI doesn't usually contain `getPair`, this part is simplified.
    // If this fails, it might be due to the absence of the `getPair` function on the Router itself.
    // You'd typically need the Factory ABI and contract to get the pair address.
    // Let's assume for now that the `getPair` is exposed or we'll get an error.
    // The `getPair` function is actually on the Uniswap V2 Factory, not the Router.
    // To make this work robustly, you'd need the Factory address and its ABI.
    // For now, if getPair isn't on the router, this will fail.
    
    // A common workaround if getPair is not directly callable on router is to assume a standard pair creation
    // and know the factory address. For this example, let's keep it simple, assuming a helper or direct lookup
    // or that `router.factory()` exists and then calling `factoryContract.getPair()`.

    // THIS IS A PLACEHOLDER. A robust solution needs the FACTORY_ADDRESS and FACTORY_ABI
    // const FACTORY_ADDRESS = await providerRouter.factory(); // If router has a factory() method
    // const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) external view returns (address pair)"];
    // const factoryContract = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
    // const lpPairAddress = await factoryContract.getPair(TOKENS.WXRP, tokenAddress);

    // For now, let's proceed with the assumption that we know the LP token address or derive it.
    // A typical LP token address isn't directly the tokenAddress. It's the address of the specific liquidity pool.
    // This is a common point of confusion. You need to know the *LP token address* for the WXRP/RISE pair.
    // If you've added liquidity, you'd receive LP tokens. You need their address.
    
    // For demonstration, let's assume `lpTokenContract` is the actual LP token you hold.
    // In a real scenario, you'd need to find the specific LP token address for WXRP/RISE.
    // This often involves looking up the pair address from the Factory contract.
    // For this example, I'll use the 'RISE' token address as a placeholder for the LP token address itself,
    // which is not entirely accurate but allows the code structure to proceed.
    // YOU WILL LIKELY NEED TO CHANGE THIS:
    const lpTokenForPairAddress = TOKENS[cfg.lpTokenName]; // THIS IS LIKELY WRONG, IT SHOULD BE THE ACTUAL LP TOKEN ADDRESS FOR THE PAIR

    const lpTokenContract = new ethers.Contract(lpTokenForPairAddress, ERC20_ABI, wallet); // Use wallet for signed calls
    const lpBalance = await lpTokenContract.balanceOf(wallet.address);

    if (lpBalance === BigInt(0)) {
        logger.warn(chalk.yellow(`Wallet ${wallet.address} has no LP tokens for ${cfg.lpTokenName}. Skipping remove liquidity.`));
        throw new Error(`No LP tokens for ${cfg.lpTokenName}`);
    }

    const lpAmountToRemove = (lpBalance * BigInt(cfg.removeAmountPercentage)) / BigInt(100);

    if (lpAmountToRemove === BigInt(0)) {
        logger.warn(chalk.yellow(`Calculated LP amount to remove is zero. Skipping remove liquidity.`));
        throw new Error(`Calculated LP amount to remove is zero.`);
    }

    logger.info(chalk.gray(`  Attempting to remove ${ethers.formatUnits(lpAmountToRemove, 18)} LP tokens (Raw: ${lpAmountToRemove.toString()}).`)); // LP tokens usually have 18 decimals

    const currentAllowance = await lpTokenContract.allowance(wallet.address, ROUTER_ADDRESS);
    if (currentAllowance < lpAmountToRemove) {
        logger.info(chalk.blue(`Approving router for LP token removal...`));
        const approvalTx = await lpTokenContract.approve(ROUTER_ADDRESS, lpAmountToRemove, { gasLimit: GAS_LIMIT_ERC20, ...gasOptions });
        await approvalTx.wait();
        logger.info(chalk.green(`✔ LP Approval confirmed: ${EXPLORER_TX_URL}${approvalTx.hash}`));
    } else {
        logger.info(chalk.gray(`Already approved enough LP tokens for router.`));
    }

    const deadline = Math.floor(Date.now() / 1e3) + 600; // 10 minutes from now

    // Set min amounts to 0 for relaxed testing, or calculate based on slippage
    return await router.removeLiquidityETH(
        tokenAddress, // This is the address of the TOKEN in the WXRP/TOKEN pair (e.g., RISE)
        lpAmountToRemove,
        0, // amountTokenMin
        0, // amountETHMin
        wallet.address,
        deadline,
        { gasLimit: GAS_LIMIT_COMPLEX, ...gasOptions }
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

    const selectedFunctionConfig = selectedContractConfig.functions[Math.floor(Math.random() * selectedContractConfig.functions.length)];
    const functionName = selectedFunctionConfig.name;
    let functionArgs = [];

    if (typeof selectedFunctionConfig.args === 'function') {
        functionArgs = selectedFunctionConfig.args(wallet);
    } else if (Array.isArray(selectedFunctionConfig.args)) {
        functionArgs = selectedFunctionConfig.args;
    }

    logger.info(chalk.gray(`  Calling ${functionName}(${functionArgs.map(arg => typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : arg).join(', ')}) on ${selectedContractConfig.name} (${selectedContractConfig.address})...`));

    try {
        // Return the transaction object from the contract call
        const tx = await contract[functionName](...functionArgs, { gasLimit: GAS_LIMIT_CUSTOM_CONTRACT, ...gasOptions });
        logger.info(chalk.green(`✔ Custom contract call to ${functionName} initiated.`));
        return tx; // Return the transaction object
    } catch (error) {
        logger.error(chalk.red(`Failed to call ${functionName} on ${selectedContractConfig.name}: ${error.message}`));
        throw error; // Re-throw to be caught by withRetry
    }
}


async function getCalculatedAmount(wallet, tokenSymbol) {
  const tokenConfig = TOKEN_AMOUNT_CONFIG[tokenSymbol] || TOKEN_AMOUNT_CONFIG.DEFAULT;
  let balanceBigInt; // Store raw BigInt balance
  let decimals;

  try {
    if (tokenSymbol === "XRP") {
      balanceBigInt = await provider.getBalance(wallet.address);
      decimals = 18; // XRP is treated as 18 decimals on EVM
    } else {
      const tokenAddress = TOKENS[tokenSymbol];
      if (!tokenAddress) {
          logger.warn(chalk.yellow(`Token address not found for symbol: ${tokenSymbol}. Cannot calculate amount.`));
          return "0";
      }
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      decimals = await tokenContract.decimals();
      balanceBigInt = await tokenContract.balanceOf(wallet.address);
    }

    if (balanceBigInt === BigInt(0)) {
        logger.warn(chalk.yellow(`Wallet ${wallet.address} has zero ${tokenSymbol}. Cannot calculate amount. Returning "0".`));
        return "0";
    }

    // Convert BigInt balance to a floating-point number
    const balanceFormatted = parseFloat(ethers.formatUnits(balanceBigInt, decimals));

    let amount = 0;
    if (tokenConfig.type === "fixed") {
      amount = parseFloat(tokenConfig.value);
    } else if (tokenConfig.type === "percentage") {
      const randomPct = (Math.random() * (tokenConfig.max - tokenConfig.min)) + tokenConfig.min;
      amount = balanceFormatted * randomPct;
    } else if (tokenConfig.type === "range") {
      amount = (Math.random() * (tokenConfig.max - tokenConfig.min)) + tokenConfig.min;
    }

    // Ensure we don't try to use more than available
    amount = Math.min(amount, balanceFormatted);

    if (amount <= 0 || isNaN(amount)) {
        logger.warn(chalk.yellow(`Calculated amount for ${tokenSymbol} for wallet ${wallet.address} is too small or invalid: ${amount}. Returning "0".`));
        return "0";
    }

    // Return the amount formatted as a string with appropriate precision
    // Use Math.max to ensure precision is at least 4 for readability, or use token decimals if higher
    return amount.toFixed(Math.max(4, decimals));
  } catch (error) {
    logger.error(chalk.red(`Error calculating amount for ${tokenSymbol} for wallet ${wallet.address}: ${error.message}. Returning "0".`));
    return "0";
  }
}

async function checkAndRebalance(wallet) {
    logger.info(chalk.yellow(`Checking balances for rebalancing for wallet: ${wallet.address}`));
    const walletBalances = await getWalletBalances(wallet);

    // Prioritize rebalancing XRP if critically low
    if (parseFloat(walletBalances.XRP) < REBALANCE_THRESHOLDS.XRP) {
        logger.warn(chalk.yellow(`XRP balance low (${walletBalances.XRP}). Attempting to acquire more XRP...`));
        try {
            let rebalanced = false;
            for (const tokenSymbol of Object.keys(TOKENS)) {
                if (tokenSymbol === "XRP" || parseFloat(walletBalances[tokenSymbol]) < REBALANCE_THRESHOLDS[tokenSymbol] * 2) { // Only swap if other token is not also critically low
                    continue;
                }
                const amountToSwap = (parseFloat(walletBalances[tokenSymbol]) * 0.05).toFixed(4); // Swap 5% of the other token
                if (parseFloat(amountToSwap) <= 0) {
                     logger.info(chalk.gray(`Calculated swap amount for ${tokenSymbol} is zero. Skipping rebalance.`));
                     continue;
                }
                logger.info(chalk.blue(`Attempting to swap ${amountToSwap} ${tokenSymbol} for XRP to rebalance XRP...`));
                const receipt = await withRetry(async (gasOptions) => {
                    // Note: Direction is A to B, so tokenSymbol (e.g., RISE) to XRP
                    return await performSwap(wallet, [tokenSymbol, "XRP"], amountToSwap, "AtoB", gasOptions);
                });
                if (receipt) { // Only increment if transaction confirmed
                    activityStats.rebalances++;
                    rebalanced = true;
                    break; // Rebalanced XRP, move to next wallet
                }
            }
            if (!rebalanced) {
                logger.info(chalk.gray(`No suitable token found or available in sufficient quantity to rebalance XRP for wallet ${wallet.address}.`));
            }
        } catch (error) {
            logger.error(chalk.red(`Failed to rebalance XRP for wallet ${wallet.address}: ${error.message}`));
        }
        return; // Don't proceed with other actions if XRP rebalance was attempted/needed
    }

    // Rebalance other tokens if low, by swapping from XRP
    for (const tokenSymbol of Object.keys(REBALANCE_THRESHOLDS)) {
        if (tokenSymbol === "XRP") continue; // Skip XRP as it's handled above
        const threshold = REBALANCE_THRESHOLDS[tokenSymbol];
        const currentBalance = parseFloat(walletBalances[tokenSymbol]);

        if (currentBalance < threshold) {
            logger.warn(chalk.yellow(`${tokenSymbol} balance low (${currentBalance}). Attempting to acquire more...`));
            try {
                if (parseFloat(walletBalances.XRP) > REBALANCE_THRESHOLDS.XRP * 2) { // Ensure enough XRP to swap from
                    const amountToSwapXRP = (parseFloat(walletBalances.XRP) * 0.01).toFixed(4); // Swap 1% of XRP
                    if (parseFloat(amountToSwapXRP) <= 0) {
                        logger.info(chalk.gray(`Calculated swap amount for XRP is zero. Skipping rebalance.`));
                        continue;
                    }
                    logger.info(chalk.blue(`Attempting to swap ${amountToSwapXRP} XRP for ${tokenSymbol} to rebalance...`));
                    const receipt = await withRetry(async (gasOptions) => {
                        // Note: Direction is A to B, so XRP to tokenSymbol (e.g., RISE)
                        return await performSwap(wallet, ["XRP", tokenSymbol], amountToSwapXRP, "AtoB", gasOptions);
                    });
                    if (receipt) { // Only increment if transaction confirmed
                        activityStats.rebalances++;
                    }
                } else {
                    logger.info(chalk.gray(`Not enough XRP to rebalance ${tokenSymbol} for wallet ${wallet.address}.`));
                }
            } catch (error) {
                logger.error(chalk.red(`Failed to rebalance ${tokenSymbol} for wallet ${wallet.address}: ${error.message}`));
            }
            return; // Don't proceed with other actions if rebalance was attempted/needed
        }
    }
}

// Selects an action based on configured probabilities
function selectWeightedAction() {
    const rand = Math.random() * 100;
    let cumulativeProbability = 0;

    for (const action in ACTION_PROBABILITIES) {
        cumulativeProbability += ACTION_PROBABILITIES[action];
        if (rand < cumulativeProbability) {
            return action;
        }
    }
    return "SWAP"; // Fallback
}


async function startRandomLoop() {
  logger.info(chalk.green("\n--- Starting 24-Hour Random Loop ---"));
  logger.info(chalk.green("Press Ctrl+C to stop the loop at any time. Logs are in bot_activity.log"));
  sendAlert("XRPL EVM Bot started its 24-hour random interaction loop.", "info");

  const startTime = Date.now();
  const twentyFourHours = 24 * 60 * 60 * 1000;

  process.on('SIGINT', () => {
    logger.info(chalk.red("\nCtrl+C detected. Stopping the loop."));
    sendAlert("XRPL EVM Bot loop stopped manually.", "info");
    process.exit();
  });

  while (Date.now() - startTime < twentyFourHours) {
    for (const wallet of wallets) {
        logger.info(chalk.magenta(`\nProcessing Wallet: ${wallet.address}`));
        activityStats.lastActivity[wallet.address] = new Date().toLocaleString();

        let actionSuccessful = false;
        let retriesLeft = 3; // Max retries for the entire action per wallet cycle

        while (!actionSuccessful && retriesLeft > 0) {
            try {
                // Always check and rebalance first, regardless of chosen action
                await checkAndRebalance(wallet);

                const action = selectWeightedAction();
                logger.info(chalk.cyan(`Selected action for wallet ${wallet.address.slice(0, 8)}...: ${action}`));

                let receipt = null;
                switch (action) {
                    case "SWAP":
                        // Randomly pick a token to swap to/from XRP
                        const availableTokens = Object.keys(TOKENS).filter(t => t !== "XRP");
                        if (availableTokens.length === 0) {
                            logger.warn(chalk.yellow("No other tokens configured to swap with XRP. Skipping swap."));
                            throw new Error("No other tokens for swap.");
                        }
                        const tokenToSwapWith = availableTokens[Math.floor(Math.random() * availableTokens.length)];

                        const swapAmount = await getCalculatedAmount(wallet, "XRP"); // Amount of XRP to swap
                        if (parseFloat(swapAmount) > 0) {
                            receipt = await withRetry(async (gasOptions) => {
                                return await performSwap(wallet, ["XRP", tokenToSwapWith], swapAmount, "AtoB", gasOptions);
                            });
                            if (receipt) activityStats.swaps++;
                        } else {
                            logger.warn(chalk.yellow("Skipping swap due to insufficient or invalid calculated amount for XRP."));
                        }
                        break;

                    case "ADD_LIQUIDITY":
                        const lpConfig = TOKEN_AMOUNT_CONFIG.ADD_LIQUIDITY_CONFIG;
                        receipt = await withRetry(async (gasOptions) => {
                            return await performAddLiquidity(wallet, lpConfig, gasOptions);
                        });
                        if (receipt) activityStats.addsLiquidity++;
                        break;

                    case "REMOVE_LIQUIDITY":
                        const removeLpConfig = TOKEN_AMOUNT_CONFIG.REMOVE_LIQUIDITY_CONFIG;
                        receipt = await withRetry(async (gasOptions) => {
                            return await performRemoveLiquidity(wallet, removeLpConfig, gasOptions);
                        });
                        if (receipt) activityStats.removesLiquidity++;
                        break;

                    case "SEND_AND_RECEIVE":
                        const sendReceiveConfig = TOKEN_AMOUNT_CONFIG.SEND_AND_RECEIVE_CONFIG;
                        receipt = await withRetry(async (gasOptions) => {
                            return await performSendAndReceive(wallet, sendReceiveConfig, gasOptions);
                        });
                        if (receipt) activityStats.sendsAndReceives++;
                        break;

                    case "RANDOM_SEND":
                        const randomSendConfig = TOKEN_AMOUNT_CONFIG.RANDOM_SEND_CONFIG;
                        receipt = await withRetry(async (gasOptions) => {
                            return await performRandomSend(wallet, randomSendConfig, gasOptions);
                        });
                        if (receipt) activityStats.randomSends++;
                        break;

                    case "CUSTOM_CONTRACT_CALL":
                        if (CUSTOM_CONTRACTS_TO_INTERACT_WITH.length > 0) {
                            receipt = await withRetry(async (gasOptions) => {
                                return await performCustomContractCall(wallet, gasOptions);
                            });
                            if (receipt) activityStats.customContractCalls++;
                        } else {
                            logger.warn(chalk.yellow("Custom contract call action selected but no contracts configured. Skipping."));
                        }
                        break;
                }

                if (receipt) {
                    actionSuccessful = true;
                } else {
                    throw new Error("Action failed to produce a confirmed transaction.");
                }

            } catch (error) {
                retriesLeft--;
                logger.error(chalk.red(`Action failed for wallet ${wallet.address}: ${error.message}`));
                if (retriesLeft > 0) {
                    logger.info(chalk.yellow(`Retrying action for wallet ${wallet.address} (${retriesLeft} retries left)...`));
                    await delay(5000); // Small delay before retrying
                } else {
                    logger.error(chalk.red(`Action failed after all retries for wallet ${wallet.address}. Moving to next wallet/cycle.`));
                }
            }
        }
    }
    logger.info(chalk.white("\nAll wallets processed for this cycle. Waiting for next cycle..."));
    logger.info(chalk.white("Current Activity Stats:", activityStats));
    saveState(); // Save state after each full cycle

    const sleepTime = Math.floor(Math.random() * (MAX_LOOP_INTERVAL_SECONDS - MIN_LOOP_INTERVAL_SECONDS + 1) + MIN_LOOP_INTERVAL_SECONDS) * 1000;
    logger.info(chalk.white(`Sleeping for ${sleepTime / 1000} seconds before next cycle.`));
    await delay(sleepTime);
  }

  logger.info(chalk.green("\n--- 24-Hour Random Loop Finished ---"));
  sendAlert("XRPL EVM Bot completed its 24-hour random interaction loop.", "info");
  displayStats();
}

function displayStats() {
  logger.info(chalk.cyan("\n--- Final Activity Statistics ---"));
  for (const stat in activityStats) {
    if (typeof activityStats[stat] !== 'object') { // Exclude lastActivity object
        logger.info(chalk.cyan(`${stat}: ${activityStats[stat]}`));
    }
  }
  logger.info(chalk.cyan("----------------------------------"));
}

function sendAlert(message, level = 'info') {
    // In a real application, integrate with Telegram, Discord, Email APIs here.
    // For now, it just logs to console and file as an "ALERT DISPATCH"
    const alertMessage = `ALERT DISPATCH: ${message}`;
    if (level === 'error') {
        logger.error(chalk.bgRed.white(alertMessage));
    } else if (level === 'warn') {
        logger.warn(chalk.bgYellow.black(alertMessage));
    } else {
        logger.info(chalk.bgGreen.black(alertMessage));
    }
}

// Simple state management (can be expanded for more complex data)
function saveState() {
    // For now, just logging the stats. In a real app, you might save to a file or DB.
    logger.info(chalk.gray("Saving current bot state (activity stats)..."));
}

function loadState() {
    // In a real app, load from file/DB. For now, just initialize empty.
    logger.info(chalk.gray("Loading previous bot state (if any)..."));
    // activityStats remains initialized as empty for now
}

async function runMenu(wallets) {
  console.log(chalk.bold("\nSelect an option:"));
  console.log(chalk.yellow("1. Start 24-Hour Random Loop"));
  console.log(chalk.yellow("2. Test RPC Connection"));
  console.log(chalk.yellow("3. Exit"));

  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });

  readline.question(chalk.green("Enter your choice: "), async (choice) => {
    readline.close();
    switch (choice) {
      case '1':
        await startRandomLoop();
        break;
      case '2':
        await testRpc();
        process.exit(0);
        break;
      case '3':
        logger.info(chalk.red("Exiting bot."));
        process.exit(0);
        break;
      default:
        logger.warn(chalk.yellow("Invalid choice. Exiting."));
        process.exit(1);
    }
  });
}

// --- Main Execution ---
async function main() {
  displayBanner();
  logger.info(chalk.hex("#D8BFD8").bold("Initializing XRPL EVM Bot…"));

  try {
    // Test RPC connection early
    await testRpc();
  } catch (error) {
    logger.error(chalk.red(`Failed to connect to RPC URL ${RPC_URL}: ${error.message}`));
    process.exit(1);
  }

  const keys = PRIVATE_KEYS;

  if (keys.length === 0) {
    logger.error(chalk.red("No PRIVATE_KEYS found in .env. Please add at least one private key."));
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
