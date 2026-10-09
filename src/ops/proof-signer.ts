import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { PROOF_ISSUER, PROOF_AUDIENCE, sha256 } from './proof-contract.ts';
import { CompanyError } from '../core-errors.ts';
export class ProofSigner {
  private readonly privateKey;
  readonly kid: string;
  readonly jwk: { kty?: string; crv?: string; x?: string };
  constructor(sealedPem: string) {
    this.privateKey = createPrivateKey(sealedPem);
    if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new CompanyError('not_configured', 'unsupported proof key');
    this.jwk = createPublicKey(this.privateKey).export({ format: 'jwk' });
    this.kid = sha256(JSON.stringify(this.jwk)).slice(0, 32);
  }
  static generate(): string { return generateKeyPairSync('ed25519').privateKey.export({format: 'pem', type: 'pkcs8'}).toString(); }
  trust() { return { issuer: PROOF_ISSUER, audience: PROOF_AUDIENCE, alg: 'EdDSA', kid: this.kid, jwk: { ...this.jwk, kid: this.kid, alg: 'EdDSA', use: 'sig' }, statusPath: '/internal-ai/status', proofMaxAgeSeconds: 300, statusMaxAgeSeconds: 60, contractVersion: 1 }; }
  sign(type: 'proof' | 'status', payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: `sck-internal-ai-${type}+jwt`, kid: this.kid })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ ...payload, iss: PROOF_ISSUER, aud: PROOF_AUDIENCE })).toString('base64url');
    const message = header + '.' + body;
    return message + '.' + sign(null, Buffer.from(message), this.privateKey).toString('base64url');
  }
}
/** Reference public verifier; consumer must additionally match activity/digest/nonce and fetch current status. */
export function verifyCompanyProof(jwt: string, trust: ReturnType<ProofSigner['trust']>, type: 'proof' | 'status', now: number): Record<string, unknown> {
  try {
    if (trust.issuer !== PROOF_ISSUER || trust.audience !== PROOF_AUDIENCE || trust.alg !== 'EdDSA') throw new Error();
    if (jwt.length > 32_000) throw new Error();
    const parts = jwt.split('.'); if (parts.length !== 3) throw new Error();
    const [h, b, signature] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (header.alg !== 'EdDSA' || header.kid !== trust.kid || header.typ !== `sck-internal-ai-${type}+jwt`) throw new Error();
    if (!verify(null, Buffer.from(h + '.' + b), createPublicKey({ key: trust.jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw new Error();
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString()) as Record<string, unknown>;
    const max = type === 'proof' ? 300 : 60;
    if (claims.iss !== PROOF_ISSUER || claims.aud !== PROOF_AUDIENCE || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || Number(claims.exp) <= now / 1000 || Number(claims.iat) > now / 1000 || Number(claims.exp) - Number(claims.iat) > max || Number(claims.exp) <= Number(claims.iat)) throw new Error();
    if (type === 'status' && (!Number.isSafeInteger(claims.checkedAt) || Number(claims.checkedAt) > now / 1000 || now / 1000 - Number(claims.checkedAt) >= 60 || Number(claims.exp) > Number(claims.checkedAt) + 60 || typeof claims.valid !== 'boolean')) throw new Error();
    return claims;
  } catch { throw new CompanyError('forbidden', 'invalid company proof'); }
}
