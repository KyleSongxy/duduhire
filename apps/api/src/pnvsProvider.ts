import PnvsSdk, { CheckSmsVerifyCodeRequest, SendSmsVerifyCodeRequest } from "@alicloud/dypnsapi20170525";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { RetryOptions, RuntimeOptions } from "@darabonba/typescript";
import { getPnvsCredentialInputIssue } from "./pnvsCredentials.js";

export const PNVS_ENDPOINT = "dypnsapi.aliyuncs.com";
export const DEFAULT_PNVS_SIGN_NAME = "恒创联众";
export const DEFAULT_PNVS_TEMPLATE_CODE = "100001";

export interface SendPhoneVerificationInput {
  phone: string;
  requestId: string;
  expiresInSeconds: number;
}

export interface CheckPhoneVerificationInput {
  phone: string;
  requestId: string;
  code: string;
}

export interface PhoneVerificationProvider {
  /** Code is server-only: persist only a challenge-bound HMAC, never return it to a browser or log it. */
  send(input: SendPhoneVerificationInput): Promise<{ code: string }>;
  /** The caller must first validate the challenge-bound local HMAC and atomically limit attempts. */
  check(input: CheckPhoneVerificationInput): Promise<boolean>;
}

export interface AliyunPnvsProviderOptions {
  accessKeyId: string;
  accessKeySecret: string;
  signName?: string;
  templateCode?: string;
  schemeName?: string;
  timeoutMs?: number;
}

export class PhoneVerificationProviderError extends Error {
  constructor() {
    super("Phone verification service is unavailable.");
    this.name = "PhoneVerificationProviderError";
  }
}

/** A narrow dependency seam allows contract tests without creating any network request. */
export interface PnvsApiClient {
  sendSmsVerifyCodeWithOptions(request: SendSmsVerifyCodeRequest, runtime: RuntimeOptions): Promise<unknown>;
  checkSmsVerifyCodeWithOptions(request: CheckSmsVerifyCodeRequest, runtime: RuntimeOptions): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function successfulModel(response: unknown, requestId: string): Record<string, unknown> {
  const result = record(response);
  const body = record(result?.body);
  const model = record(body?.model);
  if (result?.statusCode !== 200 || body?.code !== "OK" || body?.success !== true || !model || model.outId !== requestId) {
    throw new PhoneVerificationProviderError();
  }
  return model;
}

function validateDestination(phone: string, requestId: string): string {
  if (typeof phone !== "string" || typeof requestId !== "string"
    || !/^\+861[3-9]\d{9}$/u.test(phone) || !/^[A-Za-z0-9_-]{1,128}$/u.test(requestId)) {
    throw new PhoneVerificationProviderError();
  }
  return phone.slice(3);
}

/** Only the documented PNVS HTTPS endpoint is supported; credentials are explicit, never auto-discovered. */
export function createAliyunPnvsProvider(
  options: AliyunPnvsProviderOptions,
  // The CommonJS SDK exposes .default in Node; Bundler and NodeNext infer different import types.
  createClient: (config: $OpenApiUtil.Config) => PnvsApiClient = config => new (PnvsSdk as unknown as {
    default: new (config: $OpenApiUtil.Config) => PnvsApiClient;
  }).default(config),
): PhoneVerificationProvider {
  try {
    const signName = options.signName ?? DEFAULT_PNVS_SIGN_NAME;
    const templateCode = options.templateCode ?? DEFAULT_PNVS_TEMPLATE_CODE;
    const schemeName = options.schemeName;
    const timeoutMs = options.timeoutMs ?? 8_000;
    if ([options.accessKeyId, options.accessKeySecret].some(value => typeof value !== "string" || getPnvsCredentialInputIssue(value) !== undefined)
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8_000
      || typeof signName !== "string" || !signName || signName.length > 100 || /[\p{Cc}\r\n]/u.test(signName)
      || typeof templateCode !== "string" || !/^\d{1,20}$/u.test(templateCode)
      || (schemeName !== undefined && (typeof schemeName !== "string" || !schemeName || schemeName.length > 20 || /[\p{Cc}\r\n]/u.test(schemeName)))) {
      throw new PhoneVerificationProviderError();
    }
    const retryOptions = new RetryOptions({ retryable: false });
    const config = new $OpenApiUtil.Config({
      accessKeyId: options.accessKeyId.trim(),
      accessKeySecret: options.accessKeySecret.trim(),
      type: "access_key",
      endpoint: PNVS_ENDPOINT,
      regionId: "cn-hangzhou",
      protocol: "HTTPS",
      method: "POST",
      userAgent: "DuduHire-PNVS",
      readTimeout: timeoutMs,
      connectTimeout: timeoutMs,
      noProxy: PNVS_ENDPOINT,
      disableHttp2: true,
      tlsMinVersion: "TLSv1.2",
      retryOptions,
    });
    const client = createClient(config);
    const runtime = () => {
      const settings = new RuntimeOptions({
        autoretry: false, maxAttempts: 1,
        readTimeout: timeoutMs, connectTimeout: timeoutMs,
        noProxy: PNVS_ENDPOINT, ignoreSSL: false,
      });
      // This SDK version omits retryOptions from RuntimeOptions.names(); assign it explicitly.
      settings.retryOptions = retryOptions;
      return settings;
    };

    async function invoke(operation: () => Promise<unknown>): Promise<unknown> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The overall deadline includes SDK credential/signing work as well as its socket timeouts.
        // A timed-out send is ambiguous and must leave its local challenge unusable; never retry it.
        return await Promise.race([
          Promise.resolve().then(operation),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new PhoneVerificationProviderError()), timeoutMs);
          }),
        ]);
      } catch {
        // Provider errors can embed request URLs, phone numbers, codes and credentials.
        throw new PhoneVerificationProviderError();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    return {
      async send(input) {
        const phoneNumber = validateDestination(input.phone, input.requestId);
        if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 60 || input.expiresInSeconds > 600) {
          throw new PhoneVerificationProviderError();
        }
        // PNVS can only check codes it generated. ReturnVerifyCode is used solely for the local HMAC binding.
        // https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-sendsmsverifycode
        const request = new SendSmsVerifyCodeRequest({
          countryCode: "86", phoneNumber, signName, templateCode, schemeName,
          templateParam: JSON.stringify({ code: "##code##", min: String(Math.ceil(input.expiresInSeconds / 60)) }),
          codeLength: 6, codeType: 1, validTime: input.expiresInSeconds,
          interval: 60, duplicatePolicy: 1, autoRetry: 0, returnVerifyCode: true,
          outId: input.requestId,
        });
        const response = await invoke(() => client.sendSmsVerifyCodeWithOptions(request, runtime()));
        const model = successfulModel(response, input.requestId);
        if (typeof model.verifyCode !== "string" || !/^\d{6}$/u.test(model.verifyCode)) throw new PhoneVerificationProviderError();
        return { code: model.verifyCode };
      },
      async check(input) {
        const phoneNumber = validateDestination(input.phone, input.requestId);
        if (typeof input.code !== "string" || !/^\d{6}$/u.test(input.code)) return false;
        const request = new CheckSmsVerifyCodeRequest({
          countryCode: "86", phoneNumber, schemeName, outId: input.requestId,
          verifyCode: input.code, caseAuthPolicy: 2,
        });
        const response = await invoke(() => client.checkSmsVerifyCodeWithOptions(request, runtime()));
        // OutId is documented as a pass-through value, not a challenge-isolation guarantee.
        // https://help.aliyun.com/zh/pnvs/developer-reference/api-dypnsapi-2017-05-25-checksmsverifycode
        return successfulModel(response, input.requestId).verifyResult === "PASS";
      },
    };
  } catch {
    throw new PhoneVerificationProviderError();
  }
}
