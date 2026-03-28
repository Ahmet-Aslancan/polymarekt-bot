import { ethers } from 'ethers';
import { ENV } from '../config/env';
import { abi } from '../polymarket/abi';

const WSS_URL = ENV.WSS_URL;
const TARGET_WALLET = '';

const test = async () => {
    try {
        const wssProvider = new ethers.providers.WebSocketProvider(WSS_URL);

        const iface = new ethers.utils.Interface(abi);

        console.log('Listening for new blocks...');

        // Listen for new blocks
        wssProvider.on('block', async (blockNumber) => {
            try {
                console.log(`New block detected: ${blockNumber}`);
                const block = await wssProvider.getBlock(blockNumber, true);
                if (!block || !block.transactions) return;

                // In ethers v6, getBlock with prefetchTxs=true returns TransactionResponse[]
                // We need to fetch full transactions individually
                for (const txHash of block.transactions) {
                    const tx = await wssProvider.getTransaction(txHash);
                    if (!tx) continue;

                    let decodedData;
                    try {
                        decodedData = iface.parseTransaction({ data: tx.data, value: tx.value });
                        // eslint-disable-next-line no-unused-vars
                    } catch (decodeError) {
                        continue;
                    }
                    if (!decodedData) continue;
                    if (decodedData.args[0].maker !== TARGET_WALLET) continue;
                    const receipt = await wssProvider.getTransactionReceipt(tx.hash);
                    if (receipt && receipt.status !== 1) continue;

                    // ethers v6 uses native BigInt instead of BigNumber
                    const tokenId = decodedData.args[0].tokenId.toString();
                    const side = Number(decodedData.args[0].side);
                    const makerAmount = Number(decodedData.args[0].makerAmount);
                    const takerAmount = Number(decodedData.args[0].takerAmount);

                    console.log('Token ID:', tokenId);
                    console.log('side', side);
                    console.log('Taker Amount:', takerAmount);
                    console.log('Maker Amount:', makerAmount);
                }
            } catch (error) {
                console.error(`Error processing block ${blockNumber}:`, error);
            }
        });
    } catch (error) {
        console.error('An error occurred:', error);
    }
};

export default test;
