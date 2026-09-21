import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "./api";
import { buildAuthHref, loadPasswordSetup, normalizeReturnTo, requestEmailAuth, savePassword } from "./auth";

export function PasswordSetupPage() {
  const returnTo = normalizeReturnTo(new URLSearchParams(window.location.search).get("returnTo"));
  const setupReturnTo = `/account/password?${new URLSearchParams({ returnTo })}`;
  const [proof, setProof] = useState<{ canSetPassword: boolean; email: string | null } | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [resendAt, setResendAt] = useState(0);
  const [clock, setClock] = useState(Date.now);
  const inFlight = useRef(false);
  useEffect(() => {
    let active = true;
    void loadPasswordSetup().then(value => { if (active) { setProof(value); setError(""); } }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 401) window.location.replace(buildAuthHref("login", setupReturnTo) + "&method=email");
      else setError("暂时无法读取邮箱验证状态，请重试。");
    });
    return () => { active = false; };
  }, [attempt, setupReturnTo]);
  useEffect(() => {
    if (!resendAt) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [resendAt]);
  const sendLink = async () => {
    if (inFlight.current || !proof?.email || Date.now() < resendAt) return;
    inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await requestEmailAuth({ email: proof.email, intent: "login", returnTo: setupReturnTo });
      setResendAt(Date.now() + result.resendAfterSeconds * 1000); setClock(Date.now());
      setNotice(result.delivery === "email"
        ? "验证邮件已发送。请在当前浏览器中打开邮件链接，验证后即可设置密码。"
        : "当前为开发演练，未发送真实邮件。需要启用邮件发送服务后才能完成邮箱验证。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "邮件发送失败，请重试。"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current || !proof?.canSetPassword) return;
    if ([...password].length < 12 || [...password].length > 128) { setError("密码长度须为 12–128 个字符。"); return; }
    if (password !== confirmation) { setError("两次输入的密码不一致。"); return; }
    inFlight.current = true; setBusy(true); setError("");
    try {
      await savePassword(password);
      setPassword(""); setConfirmation("");
      window.location.replace(buildAuthHref("login", returnTo) + "&method=password&passwordSaved=true");
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "EMAIL_REVERIFICATION_REQUIRED") {
        setProof(current => current && { ...current, canSetPassword: false }); setPassword(""); setConfirmation("");
      }
      setError(reason instanceof Error ? reason.message : "密码保存失败，请重试。");
    } finally { inFlight.current = false; setBusy(false); }
  };
  const remaining = Math.max(0, Math.ceil((resendAt - clock) / 1000));
  return <section className="password-setup-page auth-panel">
    <div className="auth-heading"><h1>设置登录密码</h1><p>验证邮箱后设置密码，以后可直接使用邮箱和密码登录。</p></div>
    {error && <p className="auth-field-error" role="alert">{error}</p>}
    {!proof ? <>{error ? <button className="button button-ghost" onClick={() => setAttempt(value => value + 1)}>重新检查</button> : <p>正在检查邮箱验证状态…</p>}</>
      : proof.canSetPassword ? <form onSubmit={submit}>
        <p>设置成功后，其他登录会话将退出，请使用新密码重新登录。</p>
        <label htmlFor="new-password">新密码</label>
        <input id="new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} aria-describedby="password-guidance" />
        <p id="password-guidance" className="auth-role-description">12–128 个字符，可使用空格和中文。建议使用一段容易记住的长密码。</p>
        <label htmlFor="confirm-password">确认新密码</label>
        <input id="confirm-password" type="password" autoComplete="new-password" required maxLength={128} value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} />
        <button className="button button-primary" disabled={busy}>{busy ? "正在保存…" : "保存密码"}</button>
      </form> : <>
        <p>{proof.email ? "为保护账户，请先通过邮件链接验证邮箱，再设置或重置密码。" : "此账户尚未绑定邮箱，请继续使用手机号登录。"}</p>
        {notice && <p role="status">{notice}</p>}
        {proof.email && <button className="button button-primary" disabled={busy || remaining > 0} onClick={() => void sendLink()}>{busy ? "正在发送…" : remaining > 0 ? `${remaining} 秒后可重新发送` : "发送验证邮件"}</button>}
      </>}
    <a className="password-setup-back" href={returnTo}>返回工作台</a>
  </section>;
}
