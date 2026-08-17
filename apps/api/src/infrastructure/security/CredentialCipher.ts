import crypto from "node:crypto";

const algorithm = "aes-256-gcm";

export class CredentialCipher {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    this.key = parseKey(keyMaterial);
  }

  encrypt(value: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(algorithm, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
  }

  decrypt(value: string): string {
    const [version, ivText, tagText, ciphertextText] = value.split(":");
    if (version !== "v1" || !ivText || !tagText || !ciphertextText) {
      throw new Error("Invalid encrypted credential format");
    }

    const decipher = crypto.createDecipheriv(algorithm, this.key, Buffer.from(ivText, "base64url"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]);
    return plaintext.toString("utf8");
  }
}

export function parseKey(keyMaterial: string): Buffer {
  const value = keyMaterial.trim();
  const isHex = /^[a-f0-9]{64}$/i.test(value);
  const key = isHex ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("BINANCE_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes. Use: openssl rand -hex 32");
  }
  return key;
}
