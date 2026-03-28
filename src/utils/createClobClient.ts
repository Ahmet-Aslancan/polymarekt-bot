import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';

const proxyWallet = ENV.PROXY_WALLET;
const privateKey = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;

const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137;
    const host = CLOB_HTTP_URL;
    const wallet = new ethers.Wallet(privateKey);
    // Use POLY_GNOSIS_SAFE because the proxy wallet is a Gnosis Safe
    // (created via Polymarket's SafeFactory, NOT PolyProxyFactory).
    // POLY_PROXY (type 1) only works with PolyProxy wallets.
    let clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        undefined,
        SignatureType.POLY_GNOSIS_SAFE as any,
        proxyWallet
    );

    try {
        const originalConsoleError = console.error;
        console.error = function () { };
        let creds: any;
        try {
            creds = await clobClient.createApiKey();
        } finally {
            console.error = originalConsoleError;
        }

        if (!creds || !creds.key) {
            creds = await clobClient.deriveApiKey();
            console.log('API Key derived');
        } else {
            console.log('API Key created');
        }

        clobClient = new ClobClient(
            host,
            chainId,
            wallet,
            creds,
            SignatureType.POLY_GNOSIS_SAFE as any,
            proxyWallet
        );

        return clobClient;
    } catch (error) {
        console.error('Error in createClobClient:', error);
        throw error;
    }
};

export default createClobClient;
