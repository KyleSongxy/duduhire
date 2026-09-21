import { apiRequest } from "./api";

export type InquiryStatus = "new" | "contacted" | "closed";
export type AdminInquiry = {
  id: string;
  source: string;
  contactMethod: "phone" | "wechat";
  status: InquiryStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  notificationStatus: "pending" | "sent" | "failed";
};

export type InquiryList = {
  items: AdminInquiry[];
  nextCursor: string | null;
  counts: Record<InquiryStatus, number>;
};

export function loadAdminAccess(signal?: AbortSignal) {
  return apiRequest<{ authorized: boolean }>("/admin/access", { signal, cache: "no-store" });
}

export function loadInquiries(status: InquiryStatus, cursor: string | null, signal?: AbortSignal) {
  const params = new URLSearchParams({ status, limit: "20" });
  if (cursor) params.set("cursor", cursor);
  return apiRequest<InquiryList>(`/admin/inquiries?${params}`, { signal, cache: "no-store" });
}

export function changeInquiryStatus(inquiry: AdminInquiry, status: InquiryStatus, signal?: AbortSignal) {
  return apiRequest<{ inquiry: AdminInquiry }>(`/admin/inquiries/${encodeURIComponent(inquiry.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ status, expectedVersion: inquiry.version }),
    signal,
    cache: "no-store",
  });
}

export function revealInquiryContact(id: string, reason: string, signal?: AbortSignal) {
  return apiRequest<{ contactMethod: "phone" | "wechat"; contactValue: string }>(`/admin/inquiries/${encodeURIComponent(id)}/reveal-contact`, {
    method: "POST",
    body: JSON.stringify({ reason }),
    signal,
    cache: "no-store",
  });
}
