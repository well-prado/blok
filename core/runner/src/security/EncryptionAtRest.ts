/**
 * Encryption at Rest for Blok Framework
 *
 * Provides AES-256-GCM encryption and decryption for data at rest:
 * - Symmetric encryption using AES-256-GCM (authenticated encryption)
 * - Key derivation via PBKDF2 with configurable iterations and salt length
 * - JSON object encryption/decryption with type safety
 * - Key rotation support for seamless secret re-keying
 *
 * @example
 * ```typescript
 * import { EncryptionAtRest } from "@blok/runner";
 *
 * const encryption = new EncryptionAtRest({
 *   algorithm: "aes-256-gcm",
 *   keyDerivation: { iterations: 100_000, saltLength: 16, digest: "sha512" },
 *   encoding: "base64",
 * });
 *
 * // Encrypt a string
 * const payload = encryption.encrypt("sensitive data", "my-secret-key");
 *
 * // Decrypt it back
 * const plaintext = encryption.decrypt(payload, "my-secret-key");
 *
 * // Encrypt/decrypt JSON objects
 * const encrypted = encryption.encryptObject({ userId: 42, email: "a@b.com" }, "key");
 * const obj = encryption.decryptObject<{ userId: number; email: string }>(encrypted, "key");
 *
 * // Rotate encryption key
 * const reEncrypted = encryption.rotateKey(encrypted, "old-key", "new-key");
 * ```
 */

import {
	type CipherGCM,
	type DecipherGCM,
	createCipheriv,
	createDecipheriv,
	pbkdf2Sync,
	randomBytes,
} from "node:crypto";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/**
 * Encrypted payload containing all data needed for decryption.
 *
 * This is a self-describing structure: it includes the algorithm and
 * initialization vector so that the correct decryption parameters can be
 * reconstructed without external metadata.
 */
export interface EncryptedPayload {
	/** Base64- or hex-encoded initialization vector */
	iv: string;
	/** Base64- or hex-encoded ciphertext */
	ciphertext: string;
	/** Base64- or hex-encoded GCM authentication tag */
	tag: string;
	/** Algorithm used for encryption (e.g. "aes-256-gcm") */
	algorithm: string;
	/** Optional identifier for the key that was used */
	keyId?: string;
}

/**
 * PBKDF2 key derivation settings.
 */
export interface KeyDerivationConfig {
	/** Number of PBKDF2 iterations (recommended >= 100 000) */
	iterations: number;
	/** Length of the random salt in bytes (default 16) */
	saltLength: number;
	/** Hash digest algorithm (default "sha512") */
	digest: string;
}

/**
 * Configuration for the {@link EncryptionAtRest} class.
 */
export interface EncryptionConfig {
	/**
	 * Cipher algorithm to use.
	 * @default "aes-256-gcm"
	 */
	algorithm?: string;

	/**
	 * PBKDF2 key derivation settings.
	 * @default { iterations: 100_000, saltLength: 16, digest: "sha512" }
	 */
	keyDerivation?: Partial<KeyDerivationConfig>;

	/**
	 * Output encoding for binary values in {@link EncryptedPayload}.
	 * @default "base64"
	 */
	encoding?: BufferEncoding;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AES-256-GCM requires a 256-bit (32 byte) key */
const KEY_LENGTH_BYTES = 32;

/** GCM recommended IV length is 12 bytes (96 bits) */
const IV_LENGTH_BYTES = 12;

/** GCM authentication tag length in bytes */
const AUTH_TAG_LENGTH_BYTES = 16;

const DEFAULT_KEY_DERIVATION: KeyDerivationConfig = {
	iterations: 100_000,
	saltLength: 16,
	digest: "sha512",
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Provides AES-256-GCM encryption and decryption for data at rest.
 *
 * All encrypted payloads are self-describing: they embed the IV, auth tag,
 * and algorithm so that decryption does not require out-of-band metadata.
 *
 * Keys are derived from a passphrase via PBKDF2 with a per-encryption random
 * salt.  The salt is prepended to the ciphertext so it can be recovered
 * during decryption.
 *
 * @example
 * ```typescript
 * const enc = new EncryptionAtRest();
 * const payload = enc.encrypt("hello", "passphrase");
 * const plain = enc.decrypt(payload, "passphrase");
 * console.log(plain); // "hello"
 * ```
 */
export class EncryptionAtRest {
	private readonly algorithm: string;
	private readonly keyDerivation: KeyDerivationConfig;
	private readonly encoding: BufferEncoding;

	/**
	 * Create a new EncryptionAtRest instance.
	 *
	 * @param config - Optional configuration overrides
	 */
	constructor(config?: EncryptionConfig) {
		this.algorithm = config?.algorithm ?? "aes-256-gcm";
		this.keyDerivation = {
			...DEFAULT_KEY_DERIVATION,
			...config?.keyDerivation,
		};
		this.encoding = config?.encoding ?? "base64";
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	/**
	 * Encrypt a plaintext string using AES-256-GCM.
	 *
	 * A fresh random IV and PBKDF2 salt are generated for every call, meaning
	 * encrypting the same plaintext twice with the same key will produce
	 * different ciphertexts.
	 *
	 * @param plaintext - The string to encrypt
	 * @param key - Passphrase from which the encryption key is derived
	 * @returns An {@link EncryptedPayload} containing everything needed for decryption
	 *
	 * @example
	 * ```typescript
	 * const payload = encryption.encrypt("my secret", "passphrase");
	 * // payload.ciphertext, payload.iv, payload.tag are all present
	 * ```
	 */
	encrypt(plaintext: string, key: string): EncryptedPayload {
		const salt = randomBytes(this.keyDerivation.saltLength);
		const derivedKey = this.deriveKey(key, salt);
		const iv = randomBytes(IV_LENGTH_BYTES);

		const cipher = createCipheriv(this.algorithm, derivedKey, iv, {
			authTagLength: AUTH_TAG_LENGTH_BYTES,
		} as Parameters<typeof createCipheriv>[3]) as CipherGCM;

		const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

		const tag = cipher.getAuthTag();

		// Prepend the salt to the ciphertext so it can be recovered on decrypt
		const ciphertextWithSalt = Buffer.concat([salt, encrypted]);

		return {
			iv: iv.toString(this.encoding),
			ciphertext: ciphertextWithSalt.toString(this.encoding),
			tag: tag.toString(this.encoding),
			algorithm: this.algorithm,
		};
	}

	/**
	 * Decrypt an {@link EncryptedPayload} back to the original plaintext.
	 *
	 * @param payload - The encrypted payload produced by {@link encrypt}
	 * @param key - The same passphrase that was used for encryption
	 * @returns The original plaintext string
	 * @throws {Error} If the key is wrong or the payload has been tampered with
	 *
	 * @example
	 * ```typescript
	 * const plaintext = encryption.decrypt(payload, "passphrase");
	 * ```
	 */
	decrypt(payload: EncryptedPayload, key: string): string {
		const iv = Buffer.from(payload.iv, this.encoding);
		const tag = Buffer.from(payload.tag, this.encoding);
		const ciphertextWithSalt = Buffer.from(payload.ciphertext, this.encoding);

		// Extract the salt from the beginning of the ciphertext
		const salt = ciphertextWithSalt.subarray(0, this.keyDerivation.saltLength);
		const ciphertext = ciphertextWithSalt.subarray(this.keyDerivation.saltLength);

		const derivedKey = this.deriveKey(key, salt);

		const decipher = createDecipheriv(this.algorithm, derivedKey, iv, {
			authTagLength: AUTH_TAG_LENGTH_BYTES,
		} as Parameters<typeof createDecipheriv>[3]) as DecipherGCM;
		decipher.setAuthTag(tag);

		const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

		return decrypted.toString("utf8");
	}

	/**
	 * Encrypt a JSON-serializable object.
	 *
	 * The object is serialized to JSON and then encrypted.  The result is a
	 * single Base64/hex string that encodes the full {@link EncryptedPayload}
	 * as JSON.
	 *
	 * @typeParam T - Type of the object being encrypted
	 * @param obj - The object to encrypt
	 * @param key - Passphrase from which the encryption key is derived
	 * @returns A single encoded string representing the encrypted object
	 *
	 * @example
	 * ```typescript
	 * const token = encryption.encryptObject({ userId: 1 }, "key");
	 * ```
	 */
	encryptObject<T>(obj: T, key: string): string {
		const json = JSON.stringify(obj);
		const payload = this.encrypt(json, key);
		return Buffer.from(JSON.stringify(payload)).toString(this.encoding);
	}

	/**
	 * Decrypt a string produced by {@link encryptObject} back to the original
	 * typed object.
	 *
	 * @typeParam T - Expected type of the decrypted object
	 * @param ciphertext - The encoded string produced by {@link encryptObject}
	 * @param key - The same passphrase that was used for encryption
	 * @returns The original object
	 * @throws {Error} If decryption or JSON parsing fails
	 *
	 * @example
	 * ```typescript
	 * const obj = encryption.decryptObject<{ userId: number }>(token, "key");
	 * console.log(obj.userId); // 1
	 * ```
	 */
	decryptObject<T>(ciphertext: string, key: string): T {
		const payloadJson = Buffer.from(ciphertext, this.encoding).toString("utf8");
		const payload: EncryptedPayload = JSON.parse(payloadJson);
		const json = this.decrypt(payload, key);
		return JSON.parse(json) as T;
	}

	/**
	 * Re-encrypt data with a new key (key rotation).
	 *
	 * This is a convenience method that decrypts with the old key and
	 * re-encrypts with the new key in a single call.  It works with the
	 * encoded strings produced by {@link encryptObject}.
	 *
	 * @param data - The encoded ciphertext string to re-encrypt
	 * @param oldKey - The current passphrase
	 * @param newKey - The new passphrase to encrypt with
	 * @returns A new encoded ciphertext string encrypted under the new key
	 *
	 * @example
	 * ```typescript
	 * const rotated = encryption.rotateKey(existingCiphertext, "old-pass", "new-pass");
	 * ```
	 */
	rotateKey(data: string, oldKey: string, newKey: string): string {
		const payloadJson = Buffer.from(data, this.encoding).toString("utf8");
		const payload: EncryptedPayload = JSON.parse(payloadJson);
		const plaintext = this.decrypt(payload, oldKey);
		const newPayload = this.encrypt(plaintext, newKey);
		return Buffer.from(JSON.stringify(newPayload)).toString(this.encoding);
	}

	// -----------------------------------------------------------------------
	// Private helpers
	// -----------------------------------------------------------------------

	/**
	 * Derive a fixed-length encryption key from a passphrase and salt using
	 * PBKDF2.
	 *
	 * @param passphrase - The user-supplied passphrase
	 * @param salt - Random salt bytes
	 * @returns A Buffer of {@link KEY_LENGTH_BYTES} bytes
	 */
	private deriveKey(passphrase: string, salt: Buffer): Buffer {
		return pbkdf2Sync(passphrase, salt, this.keyDerivation.iterations, KEY_LENGTH_BYTES, this.keyDerivation.digest);
	}
}
