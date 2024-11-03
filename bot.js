//this script is to add wallets to databse and webhook
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const web3 = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

// Configuration
const TELEGRAM_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const WEBHOOK_ID = process.env.WEBHOOK_ID;
const QUICKNODEURL = process.env.QUICKNODEURL

// Initialize bot and database
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const pool = new Pool({ connectionString: DATABASE_URL });

class TokenTransactionAnalyzer {
    constructor(connection) {
        this.connection = connection;
    }

    async getTokenAccounts(walletAddress) {
        const pubKey = new web3.PublicKey(walletAddress);
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(pubKey, {
            programId: TOKEN_PROGRAM_ID,
        });

        return tokenAccounts.value.map(accountInfo => ({
            address: accountInfo.pubkey.toString(),
            mint: accountInfo.account.data.parsed.info.mint,
            amount: accountInfo.account.data.parsed.info.tokenAmount.amount,
            decimals: accountInfo.account.data.parsed.info.tokenAmount.decimals,
            uiAmount: accountInfo.account.data.parsed.info.tokenAmount.uiAmount
        }));
    }

    async getAllTransactions(address, limit = 75) {
        const publicKey = new web3.PublicKey(address);
        try {
            const signaturesInfo = await this.connection.getSignaturesForAddress(publicKey, { limit: limit });
            return {
                count: signaturesInfo.length,
                signatures: signaturesInfo.map(sig => sig.signature)
            };
        } catch (error) {
            console.error(`Error retrieving signatures for ${address}:`, error);
            return {
                count: 0,
                signatures: []
            };
        }
    }

    async analyzeWallet(walletAddress) {
        try {
            if (!web3.PublicKey.isOnCurve(walletAddress)) {
                throw new Error('Invalid wallet address');
            }

            const tokenAccounts = await this.getTokenAccounts(walletAddress);
            const result = [];

            for (const account of tokenAccounts) {
                try {
                    const txInfo = await this.getAllTransactions(account.address);
                    result.push({
                        tokenAccount: account.address,
                        mintAddress: account.mint,
                        txCount: txInfo.count
                    });
                } catch (error) {
                    console.error(`Error processing token account ${account.address}:`, error.message);
                    continue;
                }
            }

            return result;

        } catch (error) {
            console.error("Error analyzing wallet:", error.message);
            throw error;
        }
    }
}

class WalletManager {
    constructor() {
        this.connection = new web3.Connection(QUICKNODEURL);
    }

    async analyzeWallet(walletAddress) {
        const analyzer = new TokenTransactionAnalyzer(this.connection);
        return await analyzer.analyzeWallet(walletAddress);
    }

    async updateWebhook(newAddress) {
        const baseUrl = "https://api.helius.xyz/v0";
        
        // Get current webhook configuration
        const getResponse = await fetch(
            `${baseUrl}/webhooks/${WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`,
            {
                method: 'GET',
                headers: { 'Content-Type': 'application/json' },
            }
        );
        const currentWebhook = await getResponse.json();

        // Update webhook with new address
        const updatedAddresses = [...new Set([
            ...(currentWebhook.accountAddresses || []),
            newAddress
        ])];

        const updateResponse = await fetch(
            `${baseUrl}/webhooks/${WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    webhookURL: "https://web-production-79a3.up.railway.app/",
                    transactionTypes: ["Any"],
                    accountAddresses: updatedAddresses,
                    webhookType: "enhanced"
                }),
            }
        );
        return await updateResponse.json();
    }

    async addToDatabase(walletAddress, name, category, tokenData) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Add wallet to main wallets table
            await client.query(
                'INSERT INTO wallets (wallet_address, name, category) VALUES ($1, $2, $3)',
                [walletAddress, name, category]
            );

            // Add token trading history
            for (const token of tokenData) {
                await client.query(
                    'INSERT INTO wallet_tokens (wallet_address, mint_address, tx_count) VALUES ($1, $2, $3)',
                    [walletAddress, token.mintAddress, token.txCount]
                );
            }

            await client.query('COMMIT');
            return true;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}

// Bot command handlers
bot.onText(/\/addwallet (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].split(' ');
    
    if (input.length < 3) {
        bot.sendMessage(chatId, 'Usage: /addwallet <address> <name> <category>');
        return;
    }

    const [walletAddress, name, category] = input;
    const manager = new WalletManager();

    try {
        // Analyze wallet
        bot.sendMessage(chatId, 'Analyzing wallet...');
        const tokenData = await manager.analyzeWallet(walletAddress);

        // Update webhook
        bot.sendMessage(chatId, 'Updating webhook...');
        await manager.updateWebhook(walletAddress);

        // Add to database
        bot.sendMessage(chatId, 'Adding to database...');
        await manager.addToDatabase(walletAddress, name, category, tokenData);

        bot.sendMessage(chatId, 'Wallet successfully added and analyzed!');
    } catch (error) {
        bot.sendMessage(chatId, `Error: ${error.message}`);
    }
});

// Start the bot
console.log('Bot is running...');
