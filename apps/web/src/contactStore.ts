import { apiRequest } from "./api";

export type EnterpriseContactMethod = "phone" | "wechat";
export type EnterpriseInquirySource = "home_pricing" | "pricing_page" | "enterprise_page";

export async function submitEnterpriseInquiry(input: {
  requestId: string;
  method: EnterpriseContactMethod;
  contactValue: string;
  source: EnterpriseInquirySource;
}) {
  return apiRequest<{ accepted: true }>("/enterprise/inquiries", {
    method: "POST",
    body: JSON.stringify({
      requestId: input.requestId,
      method: input.method,
      contactValue: input.contactValue.trim(),
      source: input.source,
    }),
  });
}
