import { ServerMessage, type ClientMessage } from './protocol';

export type MessageHandler = (msg: ServerMessage) => void;

export class MultiplayerPokerClient {
	private ws: WebSocket | null = null;
	private handlers = new Set<MessageHandler>();

	constructor(private readonly url: string) {}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(this.url);
			this.ws.onopen = () => resolve();
			this.ws.onerror = (e) => reject(e);
			this.ws.onmessage = (ev) => {
				try {
					const parsed = ServerMessage.parse(JSON.parse(ev.data));
					for (const h of this.handlers) h(parsed);
				} catch {
					/* drop malformed messages */
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

	close(): void {
		this.ws?.close();
	}
}
