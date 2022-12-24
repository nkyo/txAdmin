const modulename = 'FXRunner';
import { spawn } from 'child_process';
import path from 'path';
import chalk from 'chalk';
import { promisify } from 'util';
import { parseArgsStringToArgv } from 'string-argv';
import StreamValues from 'stream-json/streamers/StreamValues';

import logger from '@core/extras/console.js';
import { convars, txEnv, verbose } from '@core/globalData';
import { validateFixServerConfig } from '@core/extras/fxsConfigHelper';
import OutputHandler from './outputHandler';

import { customAlphabet } from 'nanoid/non-secure';
import dict51 from 'nanoid-dictionary/nolookalikes';
const { dir, log, logOk, logWarn, logError } = logger(modulename);
const genMutex = customAlphabet(dict51, 5);


//Helpers
const sleep = promisify((a, f) => setTimeout(f, a));
const now = () => { return Math.round(Date.now() / 1000); };
const escape = (x) => { return x.toString().replace(/"/g, '\uff02'); };
const formatCommand = (cmd, ...params) => {
    return `${cmd} "` + [...params].map(escape).join('" "') + '"';
};
const getMutableConvars = (isCmdLine = false) => {
    const p = isCmdLine ? '+' : '';
    const playerDbConfigs = globals.playerDatabase.config;
    const checkPlayerJoin = (playerDbConfigs.onJoinCheckBan || playerDbConfigs.onJoinCheckWhitelist);

    return [
        //type, name, value
        [`${p}setr`, 'txAdmin-locale', globals.translator.language ?? 'en'],
        [`${p}set`, 'txAdmin-localeFile', globals.translator.customLocalePath ?? 'false'],
        [`${p}setr`, 'txAdmin-verbose', verbose],
        [`${p}set`, 'txAdmin-checkPlayerJoin', checkPlayerJoin],
        [`${p}set`, 'txAdmin-menuAlignRight', globals.config.menuAlignRight],
        [`${p}set`, 'txAdmin-menuPageKey', globals.config.menuPageKey],
    ];
};
const SHUTDOWN_NOTICE_DELAY = 5000;


export default class FXRunner {
    constructor(config) {
        this.config = config;
        this.spawnVariables = null;
        this.fxChild = null;
        this.restartDelayOverride == false;
        this.history = [];
        this.lastKillRequest = 0;
        this.fxServerPort = null;
        this.fxServerHost = null;
        this.currentMutex = null;
        this.outputHandler = new OutputHandler();
    }


    //================================================================
    /**
     * Refresh fxRunner configurations
     */
    refreshConfig() {
        this.config = globals.configVault.getScoped('fxRunner');
    }//Final refreshConfig()


    //================================================================
    /**
     * Receives the signal that all the start banner was already printed and other modules loaded
     */
    signalStartReady() {
        if (!this.config.autostart) return;

        if (this.config.serverDataPath === null || this.config.cfgPath === null) {
            return logWarn('Please open txAdmin on the browser to configure your server.');
        }

        if (!globals.adminVault || !globals.adminVault.admins) {
            return logWarn('The server will not auto start because there are no admins configured.');
        }

        this.spawnServer(true);
    }//Final signalStartReady()


    //================================================================
    /**
     * Setup the spawn parameters
     */
    setupVariables() {
        // Prepare extra args
        let extraArgs = [];
        if (typeof this.config.commandLine === 'string' && this.config.commandLine.length) {
            extraArgs = parseArgsStringToArgv(this.config.commandLine);
        }

        // Prepare default args (these convars can't change without restart)
        const txAdminInterface = (convars.forceInterface)
            ? `${convars.forceInterface}:${convars.txAdminPort}`
            : `127.0.0.1:${convars.txAdminPort}`;
        const cmdArgs = [
            getMutableConvars(true),
            extraArgs,
            '+set', 'onesync', this.config.onesync,
            '+sets', 'txAdmin-version', txEnv.txAdminVersion,
            '+setr', 'txAdmin-menuEnabled', globals.config.menuEnabled,
            '+set', 'txAdmin-luaComHost', txAdminInterface,
            '+set', 'txAdmin-luaComToken', globals.webServer.luaComToken,
            '+set', 'txAdminServerMode', 'true', //Can't change this one due to fxserver code compatibility
            '+exec', this.config.cfgPath,
        ].flat(2);

        // Configure spawn parameters according to the environment
        if (txEnv.isWindows) {
            this.spawnVariables = {
                command: `${txEnv.fxServerPath}/FXServer.exe`,
                args: cmdArgs,
            };
        } else {
            const alpinePath = path.resolve(txEnv.fxServerPath, '../../');
            this.spawnVariables = {
                command: `${alpinePath}/opt/cfx-server/ld-musl-x86_64.so.1`,
                args: [
                    '--library-path', `${alpinePath}/usr/lib/v8/:${alpinePath}/lib/:${alpinePath}/usr/lib/`,
                    '--',
                    `${alpinePath}/opt/cfx-server/FXServer`,
                    '+set', 'citizen_dir', `${alpinePath}/opt/cfx-server/citizen/`,
                    ...cmdArgs,
                ],
            };
        }
    }//Final setupVariables()


    //================================================================
    /**
     * Spawns the FXServer and sets up all the event handlers
     * @param {boolean} announce
     * @returns {string} null or error message
     */
    async spawnServer(announce) {
        //If the server is already alive
        if (this.fxChild !== null) {
            return logError('The server is already started.');
        }

        //Setup variables
        globals.webServer.resetToken();
        this.currentMutex = genMutex();
        this.setupVariables();
        if (verbose) {
            log('Spawn Variables: ' + this.spawnVariables.args.join(' '));
        }
        //Sanity Check
        if (
            this.spawnVariables == null
            || typeof this.spawnVariables.command == 'undefined'
            || typeof this.spawnVariables.args == 'undefined'
        ) {
            return logError('this.spawnVariables is not set.');
        }
        //If there is any FXServer configuration missing
        if (this.config.serverDataPath === null || this.config.cfgPath === null) {
            return logError('Cannot start the server with missing configuration (serverDataPath || cfgPath).');
        }

        //Validating server.cfg & configuration
        try {
            const result = await validateFixServerConfig(this.config.cfgPath, this.config.serverDataPath);
            if (result.errors) {
                const msg = `**Unable to start the server due to error(s) in your config file(s):**\n${result.errors}`;
                logError(msg);
                return msg;
            }
            if (result.warnings) {
                const msg = `**Warning regarding your configuration file(s):**\n${result.warnings}`;
                logWarn(msg);
            }

            this.fxServerHost = result.connectEndpoint;
        } catch (error) {
            const errMsg = logError(`server.cfg error: ${error.message}`);
            if (error.message.includes('unreadable')) {
                logError('That is the file where you configure your server and start resources.');
                logError('You likely moved/deleted your server files or copied the txData folder from another server.');
                logError('To fix this issue, open the txAdmin web interface then go to "Settings > FXServer" and fix the "Server Data Folder" and "CFX File Path".');
            }
            return errMsg;
        }

        //Reseting monitor stats
        globals.healthMonitor.resetMonitorStats();

        //Announcing
        if (announce === 'true' || announce === true) {
            let discordMessage = globals.translator.t('server_actions.spawning_discord', { servername: globals.config.serverName });
            globals.discordBot.sendAnnouncement(discordMessage);
        }

        //Starting server
        let pid;
        let historyIndex;
        try {
            this.fxChild = spawn(
                this.spawnVariables.command,
                this.spawnVariables.args,
                {
                    cwd: this.config.serverDataPath,
                    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
                },
            );
            if (typeof this.fxChild.pid === 'undefined') {
                throw new Error(`Executon of "${this.spawnVariables.command}" failed.`);
            }
            pid = this.fxChild.pid.toString();
            logOk(`>> [${pid}] FXServer Started!`);
            globals.logger.fxserver.writeMarker('starting');
            this.history.push({
                pid: pid,
                timestamps: {
                    start: now(),
                    kill: false,
                    exit: false,
                    close: false,
                },
            });
            historyIndex = this.history.length - 1;
        } catch (error) {
            logError('Failed to start FXServer with the following error:');
            dir(error);
            process.exit(0);
        }

        //Setting up stream handlers
        this.fxChild.stdout.setEncoding('utf8');

        //Setting up event handlers
        this.fxChild.on('close', function (code) {
            let printableCode;
            if (typeof code === 'number') {
                printableCode = `0x${code.toString(16).toUpperCase()}`;
            } else {
                printableCode = new String(code).toUpperCase();
            }
            logWarn(`>> [${pid}] FXServer Closed (${printableCode}).`);
            this.history[historyIndex].timestamps.close = now();
        }.bind(this));
        this.fxChild.on('disconnect', function () {
            logWarn(`>> [${pid}] FXServer Disconnected.`);
        }.bind(this));
        this.fxChild.on('error', function (err) {
            logWarn(`>> [${pid}] FXServer Errored:`);
            dir(err);
        }.bind(this));
        this.fxChild.on('exit', function () {
            process.stdout.write('\n'); //Make sure this isn't concatenated with the last line
            logWarn(`>> [${pid}] FXServer Exited.`);
            this.history[historyIndex].timestamps.exit = now();
            if (this.history[historyIndex].timestamps.exit - this.history[historyIndex].timestamps.start <= 5) {
                setTimeout(() => {
                    logWarn('FXServer didn\'t start. This is not an issue with txAdmin.');
                }, 500);
            }
        }.bind(this));

        this.fxChild.stdin.on('error', () => { });
        this.fxChild.stdin.on('data', () => { });

        this.fxChild.stdout.on('error', () => { });
        this.fxChild.stdout.on('data', this.outputHandler.write.bind(this.outputHandler, 'stdout', this.currentMutex));

        this.fxChild.stderr.on('error', () => { });
        this.fxChild.stderr.on('data', this.outputHandler.write.bind(this.outputHandler, 'stderr', this.currentMutex));

        const tracePipe = this.fxChild.stdio[3].pipe(StreamValues.withParser());
        tracePipe.on('error', (data) => {
            if (verbose) logWarn(`FD3 decode error: ${data.message}`);
            globals.databus.txStatsData.lastFD3Error = data.message;
        });
        tracePipe.on('data', this.outputHandler.trace.bind(this.outputHandler, this.currentMutex));

        return null;
    }//Final spawnServer()


    //================================================================
    /**
     * Restarts the FXServer
     * @param {string} reason
     * @param {string} author
     */
    async restartServer(reason = null, author = null) {
        try {
            //Restart server
            const killError = await this.killServer(reason, author, true);
            if (killError) return killError;

            //If delay override
            if (this.restartDelayOverride) {
                logWarn(`Restarting the fxserver with delay override ${this.restartDelayOverride}`);
                await sleep(this.restartDelayOverride);
            } else {
                await sleep(this.config.restartDelay);
            }

            //Start server again :)
            return this.spawnServer();
        } catch (error) {
            const errMsg = logError("Couldn't restart the server.");
            if (verbose) dir(error);
            return errMsg;
        }
    }


    //================================================================
    /**
     * Kills the FXServer
     * @param {string} reason
     * @param {string} author
     * @param {boolean} isRestarting
     */
    async killServer(reason = null, author = null, isRestarting = false) {
        try {
            //Prevent concurrent restart request
            const msTimestamp = Date.now();
            if (msTimestamp - this.lastKillRequest < SHUTDOWN_NOTICE_DELAY) {
                return 'Restart already in progress.';
            } else {
                this.lastKillRequest = msTimestamp;
            }

            // Send warnings
            const messageType = isRestarting ? 'restarting' : 'stopping';
            const tOptions = {
                servername: globals.config.serverName,
                reason: reason ?? 'no reason provided',
            };
            this.sendEvent('serverShuttingDown', {
                delay: SHUTDOWN_NOTICE_DELAY,
                author: author ?? 'txAdmin',
                message: globals.translator.t(`server_actions.${messageType}`, tOptions),
            });
            globals.discordBot.sendAnnouncement(
                globals.translator.t(`server_actions.${messageType}_discord`, tOptions),
            );

            //Awaiting restart delay
            await sleep(SHUTDOWN_NOTICE_DELAY);

            //Stopping server
            if (this.fxChild !== null) {
                this.fxChild.kill();
                this.fxChild = null;
                this.history[this.history.length - 1].timestamps.kill = now();
            }
            globals.resourcesManager.handleServerStop();
            globals.playerlistManager.handleServerStop(this.currentMutex);
            return null;
        } catch (error) {
            const msg = "Couldn't kill the server. Perhaps What Is Dead May Never Die.";
            logError(msg);
            if (verbose) dir(error);
            this.fxChild = null;
            return msg;
        }
    }


    //================================================================
    /**
     * Resets the convars in the server.
     * Useful for when we change txAdmin settings and want it to reflect on the server.
     * This will also fire the `txAdmin:event:configChanged`
     */
    resetConvars() {
        log('Refreshing fxserver convars.');
        try {
            const convarList = getMutableConvars(false);
            if (verbose) dir(convarList);
            convarList.forEach(([type, name, value]) => {
                this.srvCmd(formatCommand(type, name, value));
            });
            return this.sendEvent('configChanged');
        } catch (error) {
            if (verbose) {
                logError('Error resetting server convars');
                dir(error);
            }
            return false;
        }
    }


    //================================================================
    /**
     * Fires an `txAdmin:event` inside the server via srvCmd > stdin > command > lua broadcaster.
     * @param {string} eventType
     * @param {object} data
     */
    sendEvent(eventType, data = {}) {
        if (typeof eventType !== 'string') throw new Error('Expected eventType as String!');
        try {
            const eventCommand = formatCommand(
                'txaEvent',
                eventType,
                JSON.stringify(data),
            );
            return this.srvCmd(eventCommand);
        } catch (error) {
            if (verbose) {
                logError(`Error writing firing server event ${eventType}`);
                dir(error);
            }
            return false;
        }
    }


    //================================================================
    /**
     * Pipe a string into FXServer's stdin (aka executes a cfx's command)
     * TODO: make this method accept an array and apply the formatCommand() logic
     * @param {string} command
     */
    srvCmd(command) {
        if (typeof command !== 'string') throw new Error('Expected String!');
        if (this.fxChild === null) return false;
        const sanitized = command.replaceAll(/\n/g, ' ');
        try {
            const success = this.fxChild.stdin.write(sanitized + '\n');
            globals.logger.fxserver.writeMarker('command', sanitized);
            return success;
        } catch (error) {
            if (verbose) {
                logError('Error writing to fxChild.stdin');
                dir(error);
            }
            return false;
        }
    }


    //================================================================
    /**
     * Handles a live console command input
     * @param {object} session
     * @param {string} command
     */
    liveConsoleCmdHandler(session, command) {
        log(`${session.auth.username} executing ` + chalk.inverse(' ' + command + ' '), 'SocketIO');
        globals.logger.admin.write(`[${session.auth.username}] ${command}`);
        globals.fxRunner.srvCmd(command);
    }


    //================================================================
    /**
     * Pipe a string into FXServer's stdin (aka executes a cfx's command) and returns the stdout output.
     * NOTE: used only in webroutes\fxserver\commands.js and webroutes\player\actions.js
     * FIXME: deprecate this with a promise that resolves or rejects.
     * we can create a promise with settimeout to reject, and create a function that resolves it
     * and set this function in a map with the cmd id, and the resolve function as value
     * the internal functions should fd3 {id, message?} and outputhandler do Map.get(id)(message)
     * @param {*} command
     * @param {*} bufferTime the size of the buffer in milliseconds
     * @returns {string} buffer
     */
    async srvCmdBuffer(command, bufferTime = 1500) {
        if (typeof command !== 'string') throw new Error('Expected String!');
        if (this.fxChild === null) return false;
        this.outputHandler.cmdBuffer = '';
        this.outputHandler.enableCmdBuffer = true;
        const result = this.srvCmd(command);
        if (!result) return false;
        await sleep(bufferTime);
        this.outputHandler.enableCmdBuffer = false;
        return this.outputHandler.cmdBuffer.replace(/\x1b\[\d+(;\d)?m/g, '');
    }


    //================================================================
    /**
     * Returns the status of the server, with the states being:
     *  - not started
     *  - spawn ready
     *  - spawn awaiting last: <list of pending status of last instance>
     *  - kill pending: <list of pending events from current instance>
     *  - killed
     *  - closing
     *  - closed
     *  - spawned
     * @returns {string} status
     */
    getStatus() {
        if (!this.history.length) return 'not started';
        let curr = this.history[this.history.length - 1];

        if (!curr.timestamps.start && this.history.length == 1) {
            throw new Error('This should NOT happen. Let\'s see how long people will take to find this...');
        } else if (!curr.timestamps.start) {
            let last = this.history[this.history.length - 2];
            let pending = Object.keys(last.timestamps).filter((k) => !curr.timestamps[k]);
            if (!pending.length) {
                return 'spawn ready';
            } else {
                return 'spawn awaiting last: ' + pending.join(', ');
            }
        } else if (curr.timestamps.kill) {
            let pending = Object.keys(curr.timestamps).filter((k) => !curr.timestamps[k]);
            if (pending.length) {
                return 'kill pending: ' + pending.join(', ');
            } else {
                return 'killed';
            }
        } else if (curr.timestamps.exit && !curr.timestamps.close) {
            return 'closing';
        } else if (curr.timestamps.exit && curr.timestamps.close) {
            return 'closed';
        } else {
            return 'spawned';
        }
    }


    //================================================================
    /**
     * Returns the current fxserver uptime in seconds
     * @returns {numeric} buffer
     */
    getUptime() {
        if (!this.history.length) return 0;
        let curr = this.history[this.history.length - 1];

        return now() - curr.timestamps.start;
    }
};
