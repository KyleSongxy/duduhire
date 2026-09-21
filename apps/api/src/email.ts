import nodemailer, { type Transporter } from "nodemailer";
import type { AppConfig } from "./config.js";

type MagicLinkMessage = {
  deliveryId: string;
  to: string;
  link: string;
  expiresInMinutes: number;
};

export interface EmailSender {
  sendMagicLink(message: MagicLinkMessage): Promise<void>;
  close(): Promise<void>;
}

type SafeLogger = {
  info(data: Record<string, unknown>, message: string): void;
};

const smtpMaxPendingDeliveries = 25;

export function createSmtpTransportOptions(smtpUrl: string, requireTls: boolean) {
  let url: URL;
  try {
    url = new URL(smtpUrl);
  } catch {
    throw new Error("SMTP_URL must be a valid URL.");
  }
  const secure = url.protocol === "smtps:";
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    ...(user ? { auth: { user, pass } } : {}),
    pool: true as const,
    maxConnections: 5,
    maxMessages: 100,
    maxRequeues: 0,
    // Real mailbox credentials must never be sent over a downgraded plaintext
    // connection, including when the application is running in development.
    // Unauthenticated loopback mail receivers remain usable for local tests.
    requireTLS: requireTls || Boolean(user),
    ignoreTLS: false as const,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  };
}

class ConsoleEmailSender implements EmailSender {
  constructor(private readonly logger: SafeLogger) {}

  async sendMagicLink(message: MagicLinkMessage) {
    this.logger.info(
      {
        deliveryId: message.deliveryId,
        recipient: message.to,
        magicLink: message.link,
        expiresInMinutes: message.expiresInMinutes,
      },
      "Development authentication email",
    );
  }

  async close() {}
}

class DisabledEmailSender implements EmailSender {
  async sendMagicLink() {
    throw new Error("Email authentication is disabled.");
  }

  async close() {}
}

class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly from: { name: string; address: string };
  private readonly pendingDeliveries = new Set<Promise<unknown>>();

  constructor(from: string, smtpUrl: string, requireTls: boolean) {
    this.transporter = nodemailer.createTransport(createSmtpTransportOptions(smtpUrl, requireTls));
    const namedAddress = from.match(/^([^<>\r\n,]{1,100})<([^<>\r\n,]+)>$/u);
    this.from = namedAddress
      ? { name: namedAddress[1]!.trim(), address: namedAddress[2]!.trim() }
      : { name: "", address: from };
  }

  async sendMagicLink(message: MagicLinkMessage) {
    if (this.pendingDeliveries.size >= smtpMaxPendingDeliveries) {
      throw new Error("Email delivery queue is at capacity.");
    }
    const subject = "登录 DuduHire";
    const text = [
      "点击下面的安全链接，完成邮箱验证并继续使用 DuduHire：",
      "",
      message.link,
      "",
      `此链接将在 ${message.expiresInMinutes} 分钟后失效，且只能使用一次。`,
      "请在申请此邮件的同一浏览器中打开链接。",
      "如果这不是你的操作，请忽略此邮件。",
    ].join("\n");
    const html = `
      <div style="font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif;color:#151515;line-height:1.6">
        <h1 style="font-size:24px;margin:0 0 16px">登录 DuduHire</h1>
        <p>点击下方按钮，完成邮箱验证并继续使用 DuduHire。</p>
        <p style="margin:24px 0"><a href="${message.link}" style="display:inline-block;background:#087f23;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700">验证邮箱并继续</a></p>
        <p style="color:#626262;font-size:14px">此链接将在 ${message.expiresInMinutes} 分钟后失效，且只能使用一次。请在申请此邮件的同一浏览器中打开链接。如果这不是你的操作，请忽略此邮件。</p>
      </div>`;

    const delivery: Promise<unknown> = this.transporter.sendMail({
      from: this.from,
      to: { name: "", address: message.to },
      subject,
      text,
      html,
    });
    this.pendingDeliveries.add(delivery);
    try {
      await delivery;
    } finally {
      this.pendingDeliveries.delete(delivery);
    }
  }

  async close() {
    this.transporter.close();
  }
}

export function createEmailSender(config: AppConfig, logger: SafeLogger): EmailSender {
  if (config.emailDeliveryMode === "disabled") return new DisabledEmailSender();
  if (config.emailDeliveryMode === "console") return new ConsoleEmailSender(logger);
  if (!config.smtpUrl) throw new Error("SMTP_URL is required for SMTP delivery.");
  return new SmtpEmailSender(config.emailFrom, config.smtpUrl, config.environment === "production");
}
