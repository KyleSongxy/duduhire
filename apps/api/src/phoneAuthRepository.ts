import type { AuthIntent, AuthRole } from "./domain.js";
import type { ChallengeCreationResult, NewSession, VerifyChallengeResult } from "./repository.js";

/** Only keyed hashes of the verification code and browser/IP bindings are stored. */
export type NewPhoneChallenge = {
  id: string;
  phone: string;
  intent: AuthIntent;
  requestedRole: AuthRole | null;
  codeHash: string;
  browserBindingHash: string;
  requestIpHash: string;
  returnTo: string;
  expiresAt: Date;
  createdAt: Date;
};

export type PhoneChallengeLimits = {
  resendSeconds: number;
  phoneHourlyLimit: number;
  ipHourlyLimit: number;
  dailyLimit: number;
};

export type PhoneChallengeVerificationReservation =
  | { status: "reserved"; phone: string }
  | { status: "invalid" };

export interface PhoneAuthRepository {
  createPhoneChallengeIfAllowed(
    challenge: NewPhoneChallenge,
    now: Date,
    limits: PhoneChallengeLimits,
  ): Promise<ChallengeCreationResult>;
  /** Atomically records the provider-returned code hash and activates a pending challenge. */
  markPhoneChallengeSent(id: string, codeHash: string): Promise<boolean>;
  invalidatePhoneChallenge(id: string): Promise<void>;
  /** Reserves a 30-second lease; provider verification happens after this transaction commits. */
  reservePhoneChallengeVerification(
    id: string,
    browserBindingHash: string,
    codeHash: string,
    now: Date,
    leaseId: string,
    maxAttempts: number,
  ): Promise<PhoneChallengeVerificationReservation>;
  releasePhoneChallengeVerification(id: string, leaseId: string): Promise<void>;
  /** Consumes the lease/challenge, resolves the verified phone identity, and creates the session atomically. */
  completePhoneChallengeVerification(
    id: string,
    leaseId: string,
    now: Date,
    newSession: NewSession,
  ): Promise<VerifyChallengeResult>;
}
