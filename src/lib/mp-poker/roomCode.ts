const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ROOM_CODE_REGEX = /^MP-[A-Z0-9]{6}$/;

export function generateRoomCode(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	let suffix = '';
	for (let i = 0; i < 6; i++) {
		suffix += ALPHABET[bytes[i] % ALPHABET.length];
	}
	return `MP-${suffix}`;
}

export function isValidRoomCode(code: string): boolean {
	return ROOM_CODE_REGEX.test(code);
}
