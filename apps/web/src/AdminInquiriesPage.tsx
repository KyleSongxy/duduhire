import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft } from "@phosphor-icons/react/ArrowLeft";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { EnvelopeSimple } from "@phosphor-icons/react/EnvelopeSimple";
import { EyeSlash } from "@phosphor-icons/react/EyeSlash";
import { LockKey } from "@phosphor-icons/react/LockKey";
import { Moon } from "@phosphor-icons/react/Moon";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { SignOut } from "@phosphor-icons/react/SignOut";
import { Sun } from "@phosphor-icons/react/Sun";
import { ApiError } from "./api";
import { buildAuthHref, type AuthSession } from "./auth";
import { changeInquiryStatus, loadAdminAccess, loadInquiries, revealInquiryContact, type AdminInquiry, type InquiryList, type InquiryStatus } from "./adminStore";
import "./admin.css";

const statusLabels: Record<InquiryStatus, string> = { new: "待跟进", contacted: "已联系", closed: "已结束" };
const statuses: InquiryStatus[] = ["new", "contacted", "closed"];
const sourceLabels: Record<string, string> = { home_pricing: "首页咨询", pricing_page: "服务方案", enterprise_page: "企业服务" };
const notificationLabels = { pending: "等待发送", sent: "邮件服务已接收", failed: "需排查投递结果" };
const dateFormatter = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
const formatDate = (value: string) => dateFormatter.format(new Date(value));

function initialStatus(): InquiryStatus {
  const value = new URLSearchParams(window.location.search).get("status");
  return statuses.includes(value as InquiryStatus) ? value as InquiryStatus : "new";
}

function InquiryDetail({ inquiry, onUpdated, onAccessLost, onClose }: {
  inquiry: AdminInquiry;
  onUpdated: () => void;
  onAccessLost: (status: number) => void;
  onClose: () => void;
}) {
  const [nextStatus, setNextStatus] = useState(inquiry.status);
  const [reason, setReason] = useState("");
  const [contact, setContact] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [reasonError, setReasonError] = useState("");
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 760px)").matches) {
      detailRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
    }
    return () => requestRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!contact) return;
    const hide = () => {
      setContact(null);
      setNotice("联系方式已隐藏，再次查看会重新记录。");
    };
    const timer = window.setTimeout(hide, 60_000);
    const handleVisibility = () => { if (document.hidden) hide(); };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [contact]);

  const handleFailure = (caught: unknown) => {
    if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) {
      setContact(null);
      onAccessLost(caught.status);
      return;
    }
    setError(caught instanceof ApiError && caught.status === 409
      ? "这条咨询的状态已更新。请刷新列表，确认最新状态后再操作。"
      : caught instanceof Error ? caught.message : "操作失败，请稍后重试。");
  };

  const handleReveal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    const purpose = reason.trim();
    if (purpose.length < 5) {
      setReasonError("请用至少 5 个字符说明本次查看用途。");
      reasonRef.current?.focus();
      return;
    }
    setReasonError("");
    setError("");
    setNotice("");
    setRevealing(true);
    busyRef.current = true;
    const request = new AbortController();
    requestRef.current = request;
    try {
      const result = await revealInquiryContact(inquiry.id, purpose, request.signal);
      if (!request.signal.aborted) {
        setContact(result.contactValue);
        setNotice("本次查看已记录。联系方式将在 60 秒后或切离页面时隐藏。");
      }
    } catch (caught) {
      if (!request.signal.aborted) handleFailure(caught);
    } finally {
      if (!request.signal.aborted) { setRevealing(false); busyRef.current = false; }
    }
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current || nextStatus === inquiry.status) return;
    busyRef.current = true;
    setSaving(true);
    setError("");
    const request = new AbortController();
    requestRef.current = request;
    try {
      await changeInquiryStatus(inquiry, nextStatus, request.signal);
      if (!request.signal.aborted) onUpdated();
    } catch (caught) {
      if (!request.signal.aborted) handleFailure(caught);
    } finally {
      if (!request.signal.aborted) { setSaving(false); busyRef.current = false; }
    }
  };

  return (
    <section className="ops-detail" ref={detailRef} aria-labelledby="inquiry-detail-title">
      <button type="button" className="ops-button ops-detail-back" onClick={onClose}><ArrowLeft size={18} aria-hidden="true" />返回咨询列表</button>
      <div className="ops-detail-heading">
        <span className="ops-eyebrow">咨询详情</span>
        <h2 id="inquiry-detail-title" tabIndex={-1} ref={headingRef}>{sourceLabels[inquiry.source] || "企业咨询"}</h2>
        <span className="ops-status" data-status={inquiry.status}>{statusLabels[inquiry.status]}</span>
      </div>
      <dl className="ops-metadata">
        <div><dt>咨询编号</dt><dd className="ops-id">{inquiry.id}</dd></div>
        <div><dt>收到时间</dt><dd>{formatDate(inquiry.createdAt)}</dd></div>
        <div><dt>最近更新</dt><dd>{formatDate(inquiry.updatedAt)}</dd></div>
        <div><dt>联系渠道</dt><dd>{inquiry.contactMethod === "phone" ? "手机号" : "微信号"}</dd></div>
        <div><dt>团队邮件通知</dt><dd>{notificationLabels[inquiry.notificationStatus]}<p className="ops-help">发送状态不代表收件箱送达或客户已被联系。</p></dd></div>
      </dl>
      <div className="ops-private">
        <div className="ops-section-label"><LockKey size={18} aria-hidden="true" /><h3>联系方式保护</h3></div>
        {contact ? (
          <div className="ops-contact-value">
            <span>{inquiry.contactMethod === "phone" ? "手机号" : "微信号"}</span>
            <strong>{contact}</strong>
            <button type="button" className="ops-button" onClick={() => { setContact(null); setNotice("联系方式已隐藏，再次查看会重新记录。"); }}><EyeSlash size={18} aria-hidden="true" />隐藏联系方式</button>
          </div>
        ) : (
          <form onSubmit={handleReveal} aria-busy={revealing} noValidate>
            <label htmlFor="contact-access-reason">本次查看用途</label>
            <textarea id="contact-access-reason" ref={reasonRef} value={reason} onChange={(event) => { setReason(event.target.value); setReasonError(""); }} minLength={5} maxLength={300} rows={3} disabled={saving || revealing} aria-invalid={Boolean(reasonError)} aria-describedby={`contact-access-help${reasonError ? " contact-access-error" : ""}`} />
            <p className="ops-help" id="contact-access-help">用于跟进本条咨询。请勿在此填写手机号、微信号或其他敏感信息。</p>
            {reasonError && <p className="ops-error" id="contact-access-error" role="alert">{reasonError}</p>}
            <button type="submit" className="ops-button" disabled={saving || revealing}><ShieldCheck size={18} aria-hidden="true" />{revealing ? "正在记录访问…" : "记录用途并查看"}</button>
          </form>
        )}
        <p className="ops-help">仅限本次业务跟进，禁止公开分享。每次查看均记录操作人、时间和用途。</p>
      </div>
      <form className="ops-progress" onSubmit={handleSave} aria-busy={saving}>
        <label htmlFor="inquiry-status">跟进状态</label>
        <select id="inquiry-status" value={nextStatus} onChange={(event) => setNextStatus(event.target.value as InquiryStatus)} disabled={saving || revealing}>
          {statuses.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
        </select>
        <p className="ops-help">请在实际联系或完成跟进后更新，变更会记入审计。</p>
        <button type="submit" className="button button-primary" disabled={saving || revealing || nextStatus === inquiry.status}>{saving ? "正在保存…" : "保存跟进状态"}<CheckCircle size={18} aria-hidden="true" /></button>
      </form>
      {notice && <p className="ops-help" role="status">{notice}</p>}
      {error && <p className="ops-error" role="alert">{error}</p>}
    </section>
  );
}

export default function AdminInquiriesPage({ session, theme, onThemeToggle, onLogout }: {
  session: AuthSession;
  theme: "light" | "dark";
  onThemeToggle: () => void;
  onLogout: () => void;
}) {
  const [access, setAccess] = useState<"loading" | "allowed" | "denied" | "expired" | "error">("loading");
  const [accessAttempt, setAccessAttempt] = useState(0);
  const [status, setStatus] = useState<InquiryStatus>(initialStatus);
  const [list, setList] = useState<InquiryList | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const paginationRequest = useRef<AbortController | null>(null);
  const paginationBusy = useRef(false);
  const selectionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const selected = list?.items.find((item) => item.id === selectedId);

  useEffect(() => {
    const controller = new AbortController();
    setAccess("loading");
    void loadAdminAccess(controller.signal)
      .then(({ authorized }) => { if (!controller.signal.aborted) setAccess(authorized ? "allowed" : "denied"); })
      .catch((caught) => { if (!controller.signal.aborted) setAccess(caught instanceof ApiError && caught.status === 401 ? "expired" : "error"); });
    return () => controller.abort();
  }, [accessAttempt]);

  useEffect(() => {
    const onPopState = () => setStatus(initialStatus());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (access !== "allowed") return;
    const controller = new AbortController();
    paginationRequest.current?.abort();
    paginationBusy.current = false;
    setLoadingMore(false);
    setLoading(true);
    setError("");
    setSelectedId(null);
    setList(null);
    void loadInquiries(status, null, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setList(result); })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) setAccess(caught.status === 401 ? "expired" : "denied");
        else setError(caught instanceof Error ? caught.message : "咨询列表加载失败，请重试。");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); paginationRequest.current?.abort(); };
  }, [access, status, attempt]);

  const handleMore = async () => {
    if (!list?.nextCursor || paginationBusy.current) return;
    const controller = new AbortController();
    paginationRequest.current = controller;
    paginationBusy.current = true;
    setLoadingMore(true);
    setError("");
    try {
      const result = await loadInquiries(status, list.nextCursor, controller.signal);
      if (!controller.signal.aborted) setList((current) => current && ({ ...result, items: [...current.items, ...result.items.filter((item) => !current.items.some((existing) => existing.id === item.id))] }));
    } catch (caught) {
      if (!controller.signal.aborted) {
        if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) setAccess(caught.status === 401 ? "expired" : "denied");
        else setError(caught instanceof Error ? caught.message : "后续咨询加载失败，请重试。");
      }
    } finally {
      if (!controller.signal.aborted) { setLoadingMore(false); paginationBusy.current = false; }
    }
  };

  const handleFilter = (value: InquiryStatus) => {
    if (status === value) return;
    setSelectedId(null);
    setNotice("");
    const url = new URL(window.location.href);
    url.searchParams.set("status", value);
    window.history.pushState(null, "", `${url.pathname}${url.search}`);
    setStatus(value);
  };

  return (
    <div className="ops-shell">
      <a className="skip-link" href="#ops-content">跳到咨询管理</a>
      <header className="ops-header">
        <a className="ops-brand" href="/workspace"><img className="brand-logo" src="/images/duduhire-logo.png" width="1341" height="410" alt="DuduHire" /><span>咨询管理</span></a>
        <div className="ops-header-actions">
          <a className="ops-button" href="/workspace"><ArrowLeft size={18} aria-hidden="true" />返回工作台</a>
          <button className="icon-button" type="button" aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"} onClick={onThemeToggle}>{theme === "light" ? <Moon size={18} /> : <Sun size={18} />}</button>
          <button className="ops-button" type="button" onClick={onLogout}><SignOut size={18} aria-hidden="true" /><span>退出登录</span></button>
        </div>
      </header>
      <div id="ops-content" className="ops-content" tabIndex={-1}>
        {access !== "allowed" ? (
          <section className="ops-gate" aria-live="polite">
            <ShieldCheck size={36} aria-hidden="true" />
            <h1>{access === "loading" ? "正在确认管理权限" : access === "denied" ? "当前账户没有管理权限" : access === "expired" ? "登录状态已失效" : "暂时无法确认管理权限"}</h1>
            <p>{access === "loading" ? "请稍候。" : access === "denied" ? "咨询资料仅向授权人员开放。如需访问，请联系平台管理员。" : access === "expired" ? "请重新登录后继续。" : "请检查网络连接后重试，未确认权限前不会加载任何咨询资料。"}</p>
            {access === "error" && <button className="button button-primary" type="button" onClick={() => setAccessAttempt((value) => value + 1)}>重新检查</button>}
            {access === "expired" && <a className="button button-primary" href={buildAuthHref("login", "/admin/inquiries")}>重新登录</a>}
            {access === "denied" && <a className="ops-button" href="/workspace">返回我的工作台<ArrowRight size={18} aria-hidden="true" /></a>}
          </section>
        ) : (
          <>
            <div className="ops-title-row">
              <div><span className="ops-eyebrow">BUSINESS CONTACT</span><h1>让每次咨询都有回应。</h1><p>查看新咨询、完成跟进，并留下清晰的处理记录。</p></div>
              <div className="ops-operator"><ShieldCheck size={18} aria-hidden="true" /><span>当前操作人<strong>{session.profile.displayName || session.email || session.phone}</strong></span></div>
            </div>
            <div className="ops-toolbar">
              <div className="ops-filters" ref={filtersRef} role="group" aria-label="咨询状态筛选">
                {statuses.map((value) => <button type="button" key={value} aria-pressed={status === value} onClick={() => handleFilter(value)}>{statusLabels[value]}<span>{list ? list.counts[value] : "—"}</span></button>)}
              </div>
              <button className="ops-button" type="button" disabled={loading || loadingMore} onClick={() => { setNotice(""); setAttempt((value) => value + 1); }}><ArrowClockwise size={18} aria-hidden="true" />刷新列表</button>
            </div>
            {notice && <p className="ops-feedback" role="status"><CheckCircle size={18} aria-hidden="true" />{notice}</p>}
            {error && <div className="ops-feedback ops-error" role="alert"><span>{error}</span><button type="button" className="ops-button" onClick={() => setAttempt((value) => value + 1)}>重新加载</button></div>}
            <div className="ops-grid">
              <section className="ops-inbox" aria-label={`${statusLabels[status]}咨询`} aria-busy={loading || loadingMore}>
                <div className="ops-inbox-heading"><h2>{statusLabels[status]}</h2><span>按收到时间由新到旧</span></div>
                {loading ? <div className="ops-empty" role="status"><span className="auth-redirect-spinner" aria-hidden="true" /><p>正在读取咨询…</p></div> : !list?.items.length && !error ? <div className="ops-empty"><EnvelopeSimple size={36} aria-hidden="true" /><h3>暂时没有{statusLabels[status]}咨询</h3><p>新的咨询提交后会显示在“待跟进”中。</p></div> : (
                  <ul className="ops-list">
                    {list?.items.map((item) => <li key={item.id}><button type="button" className="ops-list-item" aria-pressed={selectedId === item.id} aria-controls="ops-detail-region" aria-label={`查看咨询 ${item.id}`} onClick={(event) => { selectionTriggerRef.current = event.currentTarget; setSelectedId(item.id); }}><span className="ops-list-icon"><EnvelopeSimple size={22} aria-hidden="true" /></span><span className="ops-list-copy"><strong>{sourceLabels[item.source] || "企业咨询"}</strong><span>{item.contactMethod === "phone" ? "手机号" : "微信号"} · {formatDate(item.createdAt)}</span><small className="ops-id">{item.id}</small></span><span className="ops-list-tail"><span className="ops-status" data-status={item.status}>{statusLabels[item.status]}</span><ArrowRight size={18} aria-hidden="true" /></span></button></li>)}
                  </ul>
                )}
                {list?.nextCursor && <button className="ops-more ops-button" type="button" disabled={loadingMore} onClick={() => void handleMore()}>{loadingMore ? "正在加载…" : "加载更多咨询"}</button>}
              </section>
              <div id="ops-detail-region">
                {selected ? <InquiryDetail key={`${selected.id}:${selected.version}`} inquiry={selected} onClose={() => { setSelectedId(null); selectionTriggerRef.current?.focus(); }} onAccessLost={(code) => { setList(null); setSelectedId(null); setAccess(code === 401 ? "expired" : "denied"); }} onUpdated={() => { setSelectedId(null); setNotice("跟进状态已保存。"); setAttempt((value) => value + 1); filtersRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus(); }} /> : <section className="ops-detail ops-detail-placeholder"><ShieldCheck size={30} aria-hidden="true" /><h2>选择一条咨询</h2><p>查看联系渠道与跟进状态。联系方式默认隐藏，按需授权查看。</p><div className="ops-private-note">每次查看与状态变更均有审计记录。</div></section>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
