/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as net from 'net';
import { getNLSConfiguration } from 'vs/server/node/remoteLanguagePacks';
import { FileAccess } from 'vs/base/common/network';
import { join, delimiter } from 'vs/base/common/path';
import { VSBuffer } from 'vs/base/common/buffer';
import { IRemoteConsoleLog } from 'vs/base/common/console';
import { Emitter, Event } from 'vs/base/common/event';
import { createRandomIPCHandle, NodeSocket, WebSocketNodeSocket } from 'vs/base/parts/ipc/node/ipc.net';
import { getResolvedShellEnv } from 'vs/platform/shell/node/shellEnv';
import { ILogService } from 'vs/platform/log/common/log';
import { IRemoteExtensionHostStartParams } from 'vs/platform/remote/common/remoteAgentConnection';
import { IExtHostReadyMessage, IExtHostSocketMessage, IExtHostReduceGraceTimeMessage } from 'vs/workbench/services/extensions/common/extensionHostProtocol';
import { IServerEnvironmentService } from 'vs/server/node/serverEnvironmentService';
import { IProcessEnvironment, isWindows } from 'vs/base/common/platform';
import { logRemoteEntry } from 'vs/workbench/services/extensions/common/remoteConsoleUtil';
import { removeDangerousEnvVariables } from 'vs/base/common/processes';
import { IExtensionHostStatusService } from 'vs/server/node/extensionHostStatusService';
import { DisposableStore, toDisposable } from 'vs/base/common/lifecycle';

export async function buildUserEnvironment(startParamsEnv: { [key: string]: string | null } = {}, withUserShellEnvironment: boolean, language: string, isDebug: boolean, environmentService: IServerEnvironmentService, logService: ILogService): Promise<IProcessEnvironment> {
	const nlsConfig = await getNLSConfiguration(language, environmentService.userDataPath);

	let userShellEnv: typeof process.env = {};
	if (withUserShellEnvironment) {
		try {
			userShellEnv = await getResolvedShellEnv(logService, environmentService.args, process.env);
		} catch (error) {
			logService.error('ExtensionHostConnection#buildUserEnvironment resolving shell environment failed', error);
		}
	}

	const processEnv = process.env;

	const env: IProcessEnvironment = {
		...processEnv,
		...userShellEnv,
		...{
			VSCODE_LOG_NATIVE: String(isDebug),
			VSCODE_AMD_ENTRYPOINT: 'vs/workbench/api/node/extensionHostProcess',
			VSCODE_PIPE_LOGGING: 'true',
			VSCODE_VERBOSE_LOGGING: 'true',
			VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
			VSCODE_LOG_STACK: 'false',
			VSCODE_NLS_CONFIG: JSON.stringify(nlsConfig, undefined, 0)
		},
		...startParamsEnv
	};

	const binFolder = environmentService.isBuilt ? join(environmentService.appRoot, 'bin') : join(environmentService.appRoot, 'resources', 'server', 'bin-dev');
	const remoteCliBinFolder = join(binFolder, 'remote-cli'); // contains the `code` command that can talk to the remote server

	let PATH = readCaseInsensitive(env, 'PATH');
	if (PATH) {
		PATH = remoteCliBinFolder + delimiter + PATH;
	} else {
		PATH = remoteCliBinFolder;
	}
	setCaseInsensitive(env, 'PATH', PATH);

	if (!environmentService.args['without-browser-env-var']) {
		env.BROWSER = join(binFolder, 'helpers', isWindows ? 'browser.cmd' : 'browser.sh'); // a command that opens a browser on the local machine
	}

	removeNulls(env);
	return env;
}

class ConnectionData {
	constructor(
		public readonly socket: NodeSocket | WebSocketNodeSocket,
		public readonly initialDataChunk: VSBuffer
	) { }

	public socketDrain(): Promise<void> {
		return this.socket.drain();
	}

	public toIExtHostSocketMessage(): IExtHostSocketMessage {

		let skipWebSocketFrames: boolean;
		let permessageDeflate: boolean;
		let inflateBytes: VSBuffer;

		if (this.socket instanceof NodeSocket) {
			skipWebSocketFrames = true;
			permessageDeflate = false;
			inflateBytes = VSBuffer.alloc(0);
		} else {
			skipWebSocketFrames = false;
			permessageDeflate = this.socket.permessageDeflate;
			inflateBytes = this.socket.recordedInflateBytes;
		}

		return {
			type: 'VSCODE_EXTHOST_IPC_SOCKET',
			initialDataChunk: (<Buffer>this.initialDataChunk.buffer).toString('base64'),
			skipWebSocketFrames: skipWebSocketFrames,
			permessageDeflate: permessageDeflate,
			inflateBytes: (<Buffer>inflateBytes.buffer).toString('base64'),
		};
	}
}

export class ExtensionHostConnection {

	private _onClose = new Emitter<void>();
	readonly onClose: Event<void> = this._onClose.event;

	private readonly _canSendSocket: boolean;
	private _disposed: boolean;
	private _remoteAddress: string;
	private _extensionHostProcess: cp.ChildProcess | null;
	private _connectionData: ConnectionData | null;

	constructor(
		private readonly _reconnectionToken: string,
		remoteAddress: string,
		socket: NodeSocket | WebSocketNodeSocket,
		initialDataChunk: VSBuffer,
		@IServerEnvironmentService private readonly _environmentService: IServerEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IExtensionHostStatusService private readonly _extensionHostStatusService: IExtensionHostStatusService,
	) {
		this._canSendSocket = (!isWindows || !this._environmentService.args['socket-path']);
		this._disposed = false;
		this._remoteAddress = remoteAddress;
		this._extensionHostProcess = null;
		this._connectionData = new ConnectionData(socket, initialDataChunk);

		this._log(`New connection established.`);
	}

	private get _logPrefix(): string {
		return `[${this._remoteAddress}][${this._reconnectionToken.substr(0, 8)}][ExtensionHostConnection] `;
	}

	private _log(_str: string): void {
		this._logService.info(`${this._logPrefix}${_str}`);
	}

	private _logError(_str: string): void {
		this._logService.error(`${this._logPrefix}${_str}`);
	}

	private async _pipeSockets(extHostSocket: net.Socket, connectionData: ConnectionData): Promise<void> {

		const disposables = new DisposableStore();
		disposables.add(connectionData.socket);
		disposables.add(toDisposable(() => {
			extHostSocket.destroy();
		}));

		const stopAndCleanup = () => {
			disposables.dispose();
		};

		disposables.add(connectionData.socket.onEnd(stopAndCleanup));
		disposables.add(connectionData.socket.onClose(stopAndCleanup));

		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'end')(stopAndCleanup));
		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'close')(stopAndCleanup));
		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'error')(stopAndCleanup));

		disposables.add(connectionData.socket.onData((e) => extHostSocket.write(e.buffer)));
		disposables.add(Event.fromNodeEventEmitter<Buffer>(extHostSocket, 'data')((e) => {
			connectionData.socket.write(VSBuffer.wrap(e));
		}));

		if (connectionData.initialDataChunk.byteLength > 0) {
			extHostSocket.write(connectionData.initialDataChunk.buffer);
		}
	}

	private async _sendSocketToExtensionHost(extensionHostProcess: cp.ChildProcess, connectionData: ConnectionData): Promise<void> {
		// Make sure all outstanding writes have been drained before sending the socket
		await connectionData.socketDrain();
		const msg = connectionData.toIExtHostSocketMessage();
		let socket: net.Socket;
		if (connectionData.socket instanceof NodeSocket) {
			socket = connectionData.socket.socket;
		} else {
			socket = connectionData.socket.socket.socket;
		}
		extensionHostProcess.send(msg, socket);
	}

	public shortenReconnectionGraceTimeIfNecessary(): void {
		if (!this._extensionHostProcess) {
			return;
		}
		const msg: IExtHostReduceGraceTimeMessage = {
			type: 'VSCODE_EXTHOST_IPC_REDUCE_GRACE_TIME'
		};
		this._extensionHostProcess.send(msg);
	}

	public acceptReconnection(remoteAddress: string, _socket: NodeSocket | WebSocketNodeSocket, initialDataChunk: VSBuffer): void {
		this._remoteAddress = remoteAddress;
		this._log(`The client has reconnected.`);
		const connectionData = new ConnectionData(_socket, initialDataChunk);

		if (!this._extensionHostProcess) {
			// The extension host didn't even start up yet
			this._connectionData = connectionData;
			return;
		}

		this._sendSocketToExtensionHost(this._extensionHostProcess, connectionData);
	}

	private _cleanResources(): void {
		if (this._disposed) {
			// already called
			return;
		}
		this._disposed = true;
		if (this._connectionData) {
			this._connectionData.socket.end();
			this._connectionData = null;
		}
		if (this._extensionHostProcess) {
			this._extensionHostProcess.kill();
			this._extensionHostProcess = null;
		}
		this._onClose.fire(undefined);
	}

	public async start(startParams: IRemoteExtensionHostStartParams): Promise<void> {
		try {
			let execArgv: string[] = [];
			if (startParams.port && !(<any>process).pkg) {
				execArgv = [`--inspect${startParams.break ? '-brk' : ''}=${startParams.port}`];
			}

			const env = await buildUserEnvironment(startParams.env, true, startParams.language, !!startParams.debugId, this._environmentService, this._logService);
			removeDangerousEnvVariables(env);

			let extHostNamedPipeServer: net.Server | null;

			if (this._canSendSocket) {
				env['VSCODE_EXTHOST_WILL_SEND_SOCKET'] = 'true';
				extHostNamedPipeServer = null;
			} else {
				const { namedPipeServer, pipeName } = await this._listenOnPipe();
				env['VSCODE_IPC_HOOK_EXTHOST'] = pipeName;
				extHostNamedPipeServer = namedPipeServer;
			}

			const opts = {
				env,
				execArgv,
				silent: true
			};

			// Run Extension Host as fork of current process
			const args = ['--type=extensionHost', `--transformURIs`];
			const useHostProxy = this._environmentService.args['use-host-proxy'];
			args.push(`--useHostProxy=${useHostProxy ? 'true' : 'false'}`);
			this._extensionHostProcess = cp.fork(FileAccess.asFileUri('bootstrap-fork', require).fsPath, args, opts);
			const pid = this._extensionHostProcess.pid;
			this._log(`<${pid}> Launched Extension Host Process.`);

			// Catch all output coming from the extension host process
			this._extensionHostProcess.stdout!.setEncoding('utf8');
			this._extensionHostProcess.stderr!.setEncoding('utf8');
			const onStdout = Event.fromNodeEventEmitter<string>(this._extensionHostProcess.stdout!, 'data');
			const onStderr = Event.fromNodeEventEmitter<string>(this._extensionHostProcess.stderr!, 'data');
			onStdout((e) => this._log(`<${pid}> ${e}`));
			onStderr((e) => this._log(`<${pid}><stderr> ${e}`));


			// Support logging from extension host
			this._extensionHostProcess.on('message', msg => {
				if (msg && (<IRemoteConsoleLog>msg).type === '__$console') {
					logRemoteEntry(this._logService, (<IRemoteConsoleLog>msg), `${this._logPrefix}<${pid}>`);
				}
			});

			// Lifecycle
			this._extensionHostProcess.on('error', (err) => {
				this._logError(`<${pid}> Extension Host Process had an error`);
				this._logService.error(err);
				this._cleanResources();
			});

			this._extensionHostProcess.on('exit', (code: number, signal: string) => {
				this._extensionHostStatusService.setExitInfo(this._reconnectionToken, { code, signal });
				this._log(`<${pid}> Extension Host Process exited with code: ${code}, signal: ${signal}.`);
				this._cleanResources();
			});

			if (extHostNamedPipeServer) {
				extHostNamedPipeServer.on('connection', (socket) => {
					extHostNamedPipeServer!.close();
					this._pipeSockets(socket, this._connectionData!);
				});
			} else {
				const messageListener = (msg: IExtHostReadyMessage) => {
					if (msg.type === 'VSCODE_EXTHOST_IPC_READY') {
						this._extensionHostProcess!.removeListener('message', messageListener);
						this._sendSocketToExtensionHost(this._extensionHostProcess!, this._connectionData!);
						this._connectionData = null;
					}
				};
				this._extensionHostProcess.on('message', messageListener);
			}

		} catch (error) {
			console.error('ExtensionHostConnection errored');
			if (error) {
				console.error(error);
			}
		}
	}

	private _listenOnPipe(): Promise<{ pipeName: string; namedPipeServer: net.Server }> {
		return new Promise<{ pipeName: string; namedPipeServer: net.Server }>((resolve, reject) => {
			const pipeName = createRandomIPCHandle();

			const namedPipeServer = net.createServer();
			namedPipeServer.on('error', reject);
			namedPipeServer.listen(pipeName, () => {
				namedPipeServer?.removeListener('error', reject);
				resolve({ pipeName, namedPipeServer });
			});
		});
	}
}

function readCaseInsensitive(env: { [key: string]: string | undefined }, key: string): string | undefined {
	const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === key.toLowerCase());
	const pathKey = pathKeys.length > 0 ? pathKeys[0] : key;
	return env[pathKey];
}

function setCaseInsensitive(env: { [key: string]: unknown }, key: string, value: string): void {
	const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === key.toLowerCase());
	const pathKey = pathKeys.length > 0 ? pathKeys[0] : key;
	env[pathKey] = value;
}

function removeNulls(env: { [key: string]: unknown | null }): void {
	// Don't delete while iterating the object itself
	for (const key of Object.keys(env)) {
		if (env[key] === null) {
			delete env[key];
		}
	}
}
