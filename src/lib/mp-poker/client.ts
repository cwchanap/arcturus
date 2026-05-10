import { ServerMessage, type ClientMessage } from './protocol';

export type MessageHandler = (msg: ServerMessage) => void;
export type DisconnectHandler = () => void;

export class MultiplayerPokerClient {
	private ws: WebSocket | null = null;
	private handlers = new Set<MessageHandler>();
	private disconnectHandlers = new Set<DisconnectHandler>();
	private _connected = false;

	constructor(private readonly url: string) {}

	get connected(): boolean {
		return this._connected;
	}

	connect(): Promise<void> {
		// Close any existing socket before opening a new one to prevent orphaned connections
		if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
			this.ws.close();
		}
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.url);
			this.ws = ws;
			ws.onopen = () => {
				this._connected = true;
				resolve();
			};
			ws.onerror = (e) => {
				if (!this._connected) {
					// Pre-open error — reject the connect promise
					reject(e);
				}
				// Post-open errors are followed by onclose, which handles cleanup
			};
			ws.onclose = () => {
				// Only react if this socket is still the active one — a superseded
				// socket's close event must not flip _connected or fire disconnect
				// handlers for the new connection.
				if (this.ws === ws && this._connected) {
					this._connected = false;
					for (const h of this.disconnectHandlers) h();
				}
			};
			ws.onmessage = (ev) => {
				try {
					const parsed = ServerMessage.parse(JSON.parse(ev.data));
					for (const h of this.handlers) h(parsed);
				} catch (err) {
					/* Drop malformed messages — protocol drift after a deploy can cause these.
					 * Log in dev to surface issues early. */
					if (import.meta.env.DEV) {
						console.warn('[MultiplayerPokerClient] dropped malformed message:', ev.data, err);
					}
				}
			};
		});
	}

	send(msg: ClientMessage): void {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(msg));
	}

	on(handler: MessageHandler): () => void {
		this.handlers.add(handler);
		return () => this.handlers.delete(handler);
	}

	onDisconnect(handler: DisconnectHandler): () => void {
		this.disconnectHandlers.add(handler);
		return () => this.disconnectHandlers.delete(handler);
	}

	close(): void {
		this._connected = false;
		this.ws?.close();
	}
}
