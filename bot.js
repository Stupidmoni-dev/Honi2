require('dotenv').config();
const { createLogger, format, transports } = require('winston');
const Bottleneck = require('bottleneck');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const { Telegraf } = require('telegraf');

// Configuration
const config = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    SOLSCAN_API_KEY: process.env.SOLSCAN_API_KEY || '',
    SOLSCAN_API_URL: 'https://api.solscan.io',
    COINGECKO_API_URL: 'https://api.coingecko.com/api/v3',
};

// Logger setup
const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: 'bot.log' }),
    ],
});

// Rate limiter
const limiter = new Bottleneck({
    minTime: 300,
    maxConcurrent: 5,
});

// Solana API setup
const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');

// Utilities
function formatTransactions(transactions) {
    if (!transactions || transactions.length === 0) return 'No recent transactions.';
    return transactions.map((tx, index) => `${index + 1}. TxID: ${tx.txId}`).join('\n');
}

// Function to get Token Info by Contract Address
async function getTokenInfoByAddress(address) {
    try {
        const tokenAccountInfo = await connection.getParsedAccountInfo(new PublicKey(address));
        if (!tokenAccountInfo || !tokenAccountInfo.value) {
            throw new Error('Token account not found or invalid address.');
        }
        const tokenData = tokenAccountInfo.value.data.parsed.info;
        return {
            name: tokenData.name,
            symbol: tokenData.symbol,
        };
    } catch (error) {
        logger.error(`Error fetching token info for ${address}: ${error.message}`);
        throw new Error('Failed to fetch token info.');
    }
}

// Function to fetch market data from CoinGecko
async function getMarketData(symbol) {
    try {
        const response = await axios.get(`${config.COINGECKO_API_URL}/coins/markets`, {
            params: {
                vs_currency: 'usd',
                ids: symbol.toLowerCase(),
            },
        });
        if (response.data.length === 0) {
            throw new Error('Token not found on CoinGecko.');
        }
        const token = response.data[0];
        return {
            price: token.current_price,
            marketCap: token.market_cap.toLocaleString(),
        };
    } catch (error) {
        logger.error(`Error fetching market data for ${symbol}: ${error.message}`);
        throw new Error('Failed to fetch market data.');
    }
}

// Fetch recent transactions
async function getTokenTransactions(address) {
    try {
        const publicKey = new PublicKey(address);
        const transactions = await connection.getConfirmedSignaturesForAddress2(publicKey, { limit: 10 });
        return transactions.map(tx => ({
            txId: tx.signature,
            type: tx.err ? 'failed' : 'confirmed',
        }));
    } catch (error) {
        logger.error(`Error fetching transactions for ${address}: ${error.message}`);
        throw new Error('Failed to fetch transactions.');
    }
}

// Check for Honeypot
function checkHoneypotLogic(transactions) {
    if (!transactions || transactions.length === 0) return true;
    if (transactions.every(tx => tx.type === 'receive')) return true;
    return false;
}

// Check Ownership
async function checkOwnership(address) {
    const accountInfo = await connection.getAccountInfo(new PublicKey(address));
    if (!accountInfo) return '❓ Unknown';
    return accountInfo.owner.toBase58() === '11111111111111111111111111111111'
        ? '🚨 Centralized Ownership'
        : `✅ Owner: ${accountInfo.owner.toBase58()}`;
}

// Developer Holdings
async function getDeveloperHoldings(address) {
    const tokenAccountInfo = await connection.getParsedAccountInfo(new PublicKey(address));
    if (!tokenAccountInfo || !tokenAccountInfo.value) return '❓ Unknown';
    const tokenData = tokenAccountInfo.value.data.parsed.info;
    const developerHoldingAmount = tokenData.amount || 0;
    return developerHoldingAmount;
}

// Bot setup
const bot = new Telegraf(config.BOT_TOKEN);

bot.start((ctx) => {
    ctx.reply(`
        🚀 Welcome to the Honeypot Checker Bot!
        Analyze Solana tokens for risks before investing.

        Use /check <TOKEN_ADDRESS> to analyze a token by contract address.
        Example: /check 4b1i...XYZ
        
        Use /balance <SOLANA_ADDRESS> to check the balance of a Solana wallet.
        Use /prices to get the current prices of Solana, Bitcoin, and Ethereum.
        Use /gas to check Solana gas fees.
        Use /donation to donate to the bot.
        Use /help to get FAQ and answers.
    `);
    logger.info('Bot started by user: ' + ctx.from.id);
});

// Command to check token info by contract address
bot.command('check', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
        return ctx.reply('❌ Usage: /check <TOKEN_ADDRESS>');
    }
    const tokenAddress = args[0];
    try {
        ctx.reply('🔍 Analyzing the token. Please wait...');
        
        // Fetch token info by contract address
        const tokenInfo = await getTokenInfoByAddress(tokenAddress);
        
        // Fetch transactions for the token
        const transactions = await getTokenTransactions(tokenAddress);
        
        // Check honeypot risk and ownership
        const isHoneypot = checkHoneypotLogic(transactions);
        const ownership = await checkOwnership(tokenAddress);

        // Fetch market data using token symbol
        const marketData = await getMarketData(tokenInfo.symbol);

        // Fetch developer holdings
        const devHoldings = await getDeveloperHoldings(tokenAddress);

        // Prepare analysis result
        const analysis = {
            honeypot: isHoneypot ? '⚠️ High Risk' : '✅ No Honeypot Detected',
            ownership,
            tokenDetails: {
                name: tokenInfo.name,
                symbol: tokenInfo.symbol,
                price: `$${marketData.price}`,
                marketCap: `$${marketData.marketCap}`,
            },
            transactions: transactions.slice(0, 5),
            developerHoldings: devHoldings,
        };

        ctx.reply(`
            🧾 **Token Analysis:**
            - **Honeypot Risk**: ${analysis.honeypot}
            - **Ownership**: ${analysis.ownership}
            - **Token Details**:
                Name: ${analysis.tokenDetails.name}
                Symbol: ${analysis.tokenDetails.symbol}
                Price: ${analysis.tokenDetails.price}
                Market Cap: ${analysis.tokenDetails.marketCap}
            - **Developer Holdings**: ${analysis.developerHoldings}
            - **Recent Transactions**: ${formatTransactions(analysis.transactions)}
        `);

    } catch (error) {
        ctx.reply(`❌ Error: ${error.message}`);
        logger.error(`Error during analysis for token: ${tokenAddress}`);
    }
});

// Command to check balance of Solana address
bot.command('balance', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 1) {
        return ctx.reply('❌ Usage: /balance <SOLANA_ADDRESS>');
    }
    const address = args[0];
    try {
        const publicKey = new PublicKey(address);
        const balance = await connection.getBalance(publicKey);
        ctx.reply(`💰 Balance of Solana address ${address}: ${balance / 1000000000} SOL`);
    } catch (error) {
        ctx.reply(`❌ Error: ${error.message}`);
    }
});

// Command to get current prices of Solana, Bitcoin, and Ethereum
bot.command('prices', async (ctx) => {
    try {
        const solPrice = await getMarketData('solana');
        const btcPrice = await getMarketData('bitcoin');
        const ethPrice = await getMarketData('ethereum');
        
        ctx.reply(`
            💹 **Current Crypto Prices**:
            - **Solana (SOL)**: $${solPrice.price}
            - **Bitcoin (BTC)**: $${btcPrice.price}
            - **Ethereum (ETH)**: $${ethPrice.price}
        `);
    } catch (error) {
        ctx.reply(`❌ Error: ${error.message}`);
    }
});

// Command to check gas fees for Solana
bot.command('gas', async (ctx) => {
    try {
        const blockhash = await connection.getRecentBlockhash();
        const fee = blockhash.feeCalculator.lamportsPerSignature;
        const gasFee = fee / 1000000000; // Convert to SOL
        ctx.reply(`💸 **Current Solana Gas Fee**: ${gasFee} SOL per transaction.`);
    } catch (error) {
        ctx.reply(`❌ Error fetching gas fee: ${error.message}`);
    }
});

// Donation command
bot.command('donation', (ctx) => {
    ctx.reply(`
        🙏 **Donate to support the bot**:
        - **Solana**: Fsf1YWcYCrKhkEkb5W6MeSm2yQiGfXM6qdasjjfLhqeY
        - **Bitcoin**: bc1q2zl77rcdqp8kj0yq6z8lvmvccvrq8zuthy7vrl
        - **Ethereum**: 0xd94a42E6cccA40Fea53Da371057479373F200d38
    `);
});

// Help command to show FAQ
bot.command('help', (ctx) => {
    ctx.reply(`
        📚 **FAQ**:
        - **How do I check a token's risk?**
            Use /check <TOKEN_ADDRESS> to analyze a token's risk.
        - **How do I check my Solana wallet balance?**
            Use /balance <SOLANA_ADDRESS> to check the balance of a Solana wallet.
        - **How do I get crypto prices?**
            Use /prices to get current prices for Solana, Bitcoin, and Ethereum.
        - **How do I check gas fees?**
            Use /gas to get the current gas fees for Solana transactions.
        - **How can I donate to the bot?**
            Use /donation to get the donation addresses.
    `);
});

bot.launch();
