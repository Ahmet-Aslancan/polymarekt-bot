/**
 * Polymarket 15-minute crypto hedge bot.
 * Strategy: place orders on both YES and NO so combined cost per pair < $1.00 for locked-in profit.
 * Config: strategy.config.json + env. Dashboard: DASHBOARD_PORT (default 3750).
 */

import ora from 'ora';
import createClobClient from './utils/createClobClient';
import { loadStrategyConfig } from './config/strategyConfig';
import { startDashboard } from './services/dashboard';
import { HedgeBot } from './services/hedgeBot';
import { startHeartbeat, stopHeartbeat } from './services/heartbeat';

async function main(): Promise<void> {
    console.log('Polymarket 15-Minute Crypto Hedge Bot\n');

    const configSpinner = ora('Loading strategy config...').start();
    const config = loadStrategyConfig();
    configSpinner.succeed(`Config loaded (target pair cost < ${config.targetPairCostMax}, live=${config.liveTrading})`);

    const clobSpinner = ora('Creating CLOB client...').start();
    const clobClient = await createClobClient();
    clobSpinner.succeed('CLOB client ready.');

    startDashboard();

    const bot = new HedgeBot({
        config,
        clobClient,
    });
    bot.start();
    startHeartbeat();
    console.log('Bot started. Dashboard: http://localhost:' + (process.env.DASHBOARD_PORT || '3750'));
    console.log('Press Ctrl+C to stop.\n');

    process.on('SIGINT', () => {
        stopHeartbeat();
        bot.stop();
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        stopHeartbeat();
        bot.stop();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
