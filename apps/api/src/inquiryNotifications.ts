import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { Pool } from "pg";
import type { NotificationConfig } from "./config.js";
import { createSmtpTransportOptions } from "./email.js";

export type InquiryNotification = { eventId: string; inquiryId: string; source: string; attemptCount: number };
export interface InquiryNotificationQueue {
  claim(leaseToken: string): Promise<InquiryNotification | null>;
  finish(eventId: string, leaseToken: string, delivered: boolean): Promise<boolean>;
}
export interface InquiryNotificationSender {
  send(notification: InquiryNotification): Promise<void>;
  close(): Promise<void>;
}

export class PostgresInquiryNotificationQueue implements InquiryNotificationQueue {
  constructor(private readonly pool: Pool) {}

  async claim(leaseToken: string) {
    const result = await this.pool.query<{ event_id: string; inquiry_id: string; source: string; attempt_count: number }>(
      "SELECT * FROM public.claim_inquiry_notification($1)", [leaseToken],
    );
    const row = result.rows[0];
    return row ? { eventId: row.event_id, inquiryId: row.inquiry_id, source: row.source, attemptCount: row.attempt_count } : null;
  }

  async finish(eventId: string, leaseToken: string, delivered: boolean) {
    const result = await this.pool.query<{ finished: boolean }>(
      "SELECT public.finish_inquiry_notification($1, $2, $3) AS finished", [eventId, leaseToken, delivered],
    );
    return result.rows[0]?.finished === true;
  }
}

export function buildInquiryNotificationMessage(notification: InquiryNotification, webOrigin: string) {
  const sourceLabels: Record<string, string> = {
    home_pricing: "首页", pricing_page: "定价页面", enterprise_page: "企业服务页面",
  };
  return {
    subject: "DuduHire 收到新的企业咨询",
    text: [
      "DuduHire 收到新的企业咨询，请在管理后台处理。", "",
      `咨询编号：${notification.inquiryId}`,
      `来源：${sourceLabels[notification.source] ?? "企业咨询"}`,
      `管理后台：${webOrigin}/admin/inquiries`, "",
      "此通知不包含联系方式。请使用已授权的账户登录后台查看。",
    ].join("\n"),
    messageId: `<${notification.eventId}@notifications.duduhire>`,
  };
}

export function createInquiryNotificationSender(config: NotificationConfig): InquiryNotificationSender {
  const transporter = nodemailer.createTransport(createSmtpTransportOptions(config.smtpUrl, config.requireTls));
  return {
    async send(notification) {
      await transporter.sendMail({
        from: config.emailFrom, to: { name: "", address: config.recipient },
        ...buildInquiryNotificationMessage(notification, config.webOrigin),
      });
    },
    async close() { transporter.close(); },
  };
}

export async function processInquiryNotification(queue: InquiryNotificationQueue, sender: InquiryNotificationSender) {
  const leaseToken = randomUUID();
  const notification = await queue.claim(leaseToken);
  if (!notification) return { status: "idle" as const };
  let delivered = false;
  try {
    await sender.send(notification);
    delivered = true;
  } catch {
    // SMTP responses can contain recipient addresses; persist/log only fixed codes.
  }
  const finalized = await queue.finish(notification.eventId, leaseToken, delivered);
  return {
    status: !finalized ? "lease_lost" as const : delivered ? "sent" as const
      : notification.attemptCount >= 8 ? "dead_lettered" as const : "retry_scheduled" as const,
    eventId: notification.eventId,
  };
}
