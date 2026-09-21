import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { ApiError } from "./api";
import { readAuthSession } from "./auth";
import type { DiscoveryKind } from "./discoveryFlow";
import { matchingConditionsSummary } from "./matchingPresentation";
import {
  emptyMatchingConstraints, loadMatchingResults, loadMatchingState, matchingDraftFrom, previewMatchingExamples, publishMatchingListing, readMatchingDraft, withdrawMatchingListing, writeMatchingDraft,
  type Engagement, type MatchingConstraints, type MatchingDraft, type MatchingResults, type MatchingState, type WorkMode,
} from "./matchingStore";
import "./matching.css";

type FormErrors = Partial<Record<"title" | "summary" | "skills" | "location" | "notes" | "consent" | "constraints", string>>;
const consentLabel = "我同意将以上内容用于匹配并展示给已登录的其他用户";

function validateDraft(value: MatchingDraft, consent: boolean): FormErrors {
  const errors: FormErrors = {};
  if (value.title.trim().length < 2 || value.title.trim().length > 60) errors.title = "请填写 2–60 字的展示标题。";
  if (value.summary.trim().length < 10 || value.summary.trim().length > 500) errors.summary = "请用 10–500 字说明实际工作或能力，不要填写联系方式。";
  if (value.skills.length < 1 || value.skills.length > 8) errors.skills = "请至少选择 1 项、最多 8 项与实际工作有关的能力。";
  if ((value.workMode === "onsite" || value.workMode === "hybrid") && !value.location.trim()) errors.location = "现场或混合办公需要填写一个工作城市。";
  if (value.location.trim().length > 60) errors.location = "工作地点不能超过 60 字，请填写一个城市。";
  if (value.notes.trim().length > 200) errors.notes = "补充说明不能超过 200 字。";
  const constraints = value.constraints;
  if (constraints) {
    if ([constraints.budgetMin, constraints.budgetMax].some((value) => value !== null && (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000))) errors.constraints = "预算需填写有效正数；暂未确定可留空。";
    if (constraints.budgetMin !== null && constraints.budgetMax !== null && constraints.budgetMin > constraints.budgetMax) errors.constraints = "预算下限不能高于预算上限。";
    if ((constraints.budgetMin !== null || constraints.budgetMax !== null) && (!constraints.budgetCurrency || !constraints.budgetPeriod)) errors.constraints = "填写预算时，请同时选择币种与计费方式。";
    if (constraints.weeklyHours !== null && (constraints.weeklyHours < 1 || constraints.weeklyHours > 168)) errors.constraints = "每周投入时间需在 1–168 小时之间。";
    if ([constraints.markets, constraints.languages].some((values) => values.filter((value) => value.trim()).length > 8 || values.some((value) => value.trim().length > 40))) errors.constraints = "市场和工作语言各最多 8 项，每项最多 40 字。";
  }
  if (!consent) errors.consent = "请先检查展示内容，再勾选同意参与匹配。";
  return errors;
}

function evidenceLabel(item: { field: string; value: string }, state: MatchingState) {
  if (item.field === "workMode") return state.workModes[item.value as WorkMode] ?? "工作方式";
  if (item.field === "engagement") return state.engagements[item.value as Engagement] ?? "合作方式";
  const labels: Record<string, string> = { "constraints.markets": "市场", "constraints.languages": "工作语言", "constraints.weeklyHours": "每周投入（小时）", "constraints.budgetMin": "预算下限", "constraints.budgetMax": "预算上限", "constraints.budgetCurrency": "预算币种", "constraints.budgetPeriod": "计费方式" };
  const display: Record<string, string> = { CNY: "人民币", USD: "美元", EUR: "欧元", project: "按项目", month: "按月", hour: "按小时" };
  return labels[item.field] ? `${labels[item.field]}：${display[item.value] ?? item.value}` : item.value;
}

function MatchingResultCards({ results, state }: { results: MatchingResults; state: MatchingState }) {
  return <ul className="matching-panel__result-list">{results.matches.map(({ listing, sharedSkills, reasons, gaps, readiness, followUpQuestions }) => <li key={listing.id} className="matching-panel__result">
    <div><span className="matching-panel__eyebrow">{listing.isExample || results.catalog === "examples" ? "示例资料 · 非真实用户 · 不可联系" : `${listing.kind === "problem" ? "已发布需求" : "已发布能力"} · 用户自行确认`}</span><h4>{listing.title}</h4></div>
    <p>{listing.summary}</p>
    <div className="matching-panel__meta"><span>{state.workModes[listing.workMode]}</span><span>{state.engagements[listing.engagement]}</span>{listing.location && <span>{listing.location}</span>}{listing.constraints?.markets.length ? <span>{listing.constraints.markets.join("、")}</span> : null}{listing.constraints?.languages.length ? <span>{listing.constraints.languages.join("、")}</span> : null}</div>
    <div className="matching-panel__tags" aria-label="共同工作能力">{sharedSkills.map((skill) => <span key={skill}>{skill}</span>)}</div>
    <div className="matching-panel__reason"><h5>相关之处</h5><ul>{reasons.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul></div>
    <div className="matching-panel__reason"><h5>还需确认{readiness === "needs_confirmation" ? " · 存在信息缺口" : ""}</h5><ul>{gaps.map((gap, index) => <li key={`${index}:${gap}`}>{gap}</li>)}</ul></div>
    {followUpQuestions?.length ? <details><summary>建议进一步核实的问题</summary><ul>{followUpQuestions.map((question) => <li key={question}>{question}</li>)}</ul></details> : null}
    {listing.notes && <details><summary>查看补充说明</summary><p>{listing.notes}</p></details>}
  </li>)}</ul>;
}

export function MatchingPanel({ kind, compact = false, autoOpen = false }: { kind: DiscoveryKind; compact?: boolean; autoOpen?: boolean }) {
  const isTalent = kind === "capability";
  const noun = isTalent ? "项目" : "人才";
  const discoveryHref = isTalent ? "/projects" : "/talent";
  const findLabel = `查找合适的${noun}`;
  const prefix = useId();
  const [draftStorageKey] = useState(() => {
    const session = readAuthSession();
    return session ? `duduhire-matching-draft:${session.id}:${session.signedInAt}:${kind}` : "";
  });
  const [recoveredDraft] = useState(() => {
    try { return draftStorageKey ? readMatchingDraft(window.sessionStorage, draftStorageKey) : null; } catch { return null; }
  });
  const [state, setState] = useState<MatchingState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(autoOpen || Boolean(recoveredDraft));
  const [editing, setEditing] = useState(Boolean(recoveredDraft));
  const [draft, setDraft] = useState<MatchingDraft | null>(recoveredDraft?.draft ?? null);
  const [draftBase, setDraftBase] = useState<{ threadId: string | null; sourceVersion: number; listingVersion: number } | null>(recoveredDraft?.base ?? null);
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [action, setAction] = useState<"publish" | "withdraw" | null>(null);
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState(recoveredDraft ? "已恢复此身份尚未发布的编辑，请重新检查内容并确认发布意愿。" : "");
  const [results, setResults] = useState<MatchingResults | null>(null);
  const [resultsError, setResultsError] = useState("");
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultAttempt, setResultAttempt] = useState(0);
  const [allSkills, setAllSkills] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const [exampleResults, setExampleResults] = useState<MatchingResults | null>(null);
  const [exampleError, setExampleError] = useState("");
  const [examplesLoading, setExamplesLoading] = useState(false);
  const exampleAbort = useRef<AbortController | null>(null);
  const autoOpened = useRef(Boolean(recoveredDraft));
  const stateSequence = useRef(0);
  const stateAbort = useRef<AbortController | null>(null);
  const actionInFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const busy = action !== null;
  const draftIsStale = Boolean(editing && draftBase && state && (
    draftBase.threadId !== (state.source?.threadId ?? null)
    || draftBase.sourceVersion !== (state.source?.version ?? 0)
    || draftBase.listingVersion !== (state.listing?.version ?? 0)
  ));

  useEffect(() => {
    if (!draftStorageKey) return;
    try { writeMatchingDraft(window.sessionStorage, draftStorageKey, editing && draft && draftBase ? { draft, base: draftBase } : null); } catch { /* Browser storage may be disabled. */ }
  }, [draft, draftBase, draftStorageKey, editing]);

  const refreshState = useCallback(async () => {
    const sequence = ++stateSequence.current;
    stateAbort.current?.abort();
    const controller = new AbortController();
    stateAbort.current = controller;
    setLoading(true);
    setLoadError("");
    exampleAbort.current?.abort();
    setExampleResults(null);
    setExamplesLoading(false);
    try {
      const next = await loadMatchingState(controller.signal);
      if (sequence !== stateSequence.current) return;
      if (next.kind !== kind) throw new Error("当前使用身份已更改，请刷新页面后继续。");
      setState(next);
      if (autoOpen && !autoOpened.current && next.source?.confirmed) {
        autoOpened.current = true;
        setExpanded(true);
        if (!next.listing?.active) {
          setDraft(matchingDraftFrom(next));
          setDraftBase({ threadId: next.source.threadId, sourceVersion: next.source.version, listingVersion: next.listing?.version ?? 0 });
          setEditing(true);
        }
      }
      setConsent(false);
      setResults(null);
      setResultAttempt((attempt) => attempt + 1);
    } catch (error) {
      if (sequence === stateSequence.current && !controller.signal.aborted) {
        setLoadError(error instanceof Error ? error.message : "匹配状态加载失败，请重试。");
      }
    } finally {
      if (sequence === stateSequence.current) setLoading(false);
    }
  }, [autoOpen, kind]);

  useEffect(() => {
    void refreshState();
    const onFocus = () => { if (!actionInFlight.current) void refreshState(); };
    window.addEventListener("focus", onFocus);
    return () => {
      stateSequence.current += 1;
      stateAbort.current?.abort();
      exampleAbort.current?.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshState]);

  useEffect(() => {
    if (!expanded || editing || !state?.listing?.active || !state.source?.confirmed || loading || loadError) {
      setResults(null);
      setResultsError("");
      setResultsLoading(false);
      return;
    }
    let active = true;
    const controller = new AbortController();
    setResultsLoading(true);
    setResultsError("");
    void loadMatchingResults(controller.signal)
      .then((value) => { if (active) setResults(value); })
      .catch((error) => {
        if (!active) return;
        setResults(null);
        setResultsError(error instanceof Error ? error.message : "匹配结果加载失败，请重试。");
        if (error instanceof ApiError && error.status === 409 && error.code !== "ACTIVE_ROLE_CHANGED") void refreshState();
      })
      .finally(() => { if (active) setResultsLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [expanded, editing, loading, loadError, state?.listing?.active, state?.listing?.version, state?.source?.confirmed, resultAttempt, refreshState]);

  const openMatching = () => {
    if (!state || loading) return;
    setExpanded(true);
    setActionError("");
    setMessage("");
    if (!state.listing?.active) {
      setDraft(matchingDraftFrom(state));
      setDraftBase({ threadId: state.source?.threadId ?? null, sourceVersion: state.source?.version ?? 0, listingVersion: state.listing?.version ?? 0 });
      setEditing(true);
      setConsent(false);
      setErrors({});
    }
  };

  const editListing = () => {
    if (!state) return;
    setDraft(matchingDraftFrom(state));
    setDraftBase({ threadId: state.source?.threadId ?? null, sourceVersion: state.source?.version ?? 0, listingVersion: state.listing?.version ?? 0 });
    setEditing(true);
    setExpanded(true);
    setConsent(false);
    setErrors({});
    setActionError("");
    setMessage("");
    setAllSkills(false);
    exampleAbort.current?.abort();
    setExampleResults(null);
    setExamplesLoading(false);
  };

  const changeDraft = <K extends keyof MatchingDraft>(key: K, value: MatchingDraft[K]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setConsent(false);
    setErrors((current) => ({ ...current, [key]: undefined, consent: undefined }));
    setActionError("");
    exampleAbort.current?.abort();
    setExampleResults(null);
    setExamplesLoading(false);
    setExampleError("");
  };

  const changeConstraint = <K extends keyof MatchingConstraints>(key: K, value: MatchingConstraints[K]) => {
    if (draft) changeDraft("constraints", { ...(draft.constraints ?? emptyMatchingConstraints()), [key]: value });
  };

  const toggleSkill = (skill: string, checked: boolean) => {
    if (!draft) return;
    const selected = checked ? [...draft.skills, skill] : draft.skills.filter((item) => item !== skill);
    if (selected.length > 8) return;
    changeDraft("skills", selected);
    setDraft((current) => current ? { ...current, requiredSkills: current.requiredSkills.filter((item) => selected.includes(item)) } : current);
    setConsent(false);
    setErrors((current) => ({ ...current, skills: undefined, consent: undefined }));
  };

  const previewExamples = async () => {
    if (!draft || !state?.source?.confirmed || draftIsStale || busy || loading || examplesLoading) return;
    const nextErrors = validateDraft(draft, true);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setActionError("先检查下面标出的信息，再查看示例匹配。");
      window.requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    exampleAbort.current?.abort();
    const controller = new AbortController();
    exampleAbort.current = controller;
    setExamplesLoading(true);
    setExampleError("");
    setActionError("");
    try {
      const preview = await previewMatchingExamples(draft, controller.signal);
      if (!controller.signal.aborted) setExampleResults(preview);
    } catch (error) {
      if (!controller.signal.aborted) setExampleError(error instanceof Error ? error.message : "示例暂时无法加载，请重试。");
    } finally {
      if (!controller.signal.aborted) setExamplesLoading(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!state || !draft || actionInFlight.current || loading) return;
    if (draftIsStale) {
      setActionError("预览依据的版本已变化。当前输入仍保留，请使用最新确认内容重新预览后再发布。");
      return;
    }
    const nextErrors = validateDraft(draft, consent);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      setActionError("请检查下面标出的内容后再发布。");
      window.requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    actionInFlight.current = true;
    setAction("publish");
    setActionError("");
    setMessage("");
    try {
      const saved = await publishMatchingListing(draft, state);
      setState((current) => current ? { ...current, listing: saved } : current);
      setEditing(false);
      setConsent(false);
      setMessage("匹配摘要已发布。其他用户只会看到你本次确认的展示内容，不会看到完整对话和附件。");
      setResultAttempt((attempt) => attempt + 1);
    } catch (error) {
      setConsent(false);
      if (error instanceof ApiError && error.status === 409 && error.code !== "ACTIVE_ROLE_CHANGED") {
        await refreshState();
        setActionError("资料已发生变化，本次编辑仍保留。请核对最新状态，重新检查内容并勾选同意后再提交。");
      } else if (error instanceof ApiError && error.status === 0) {
        await refreshState();
        setActionError("暂未确认发布是否成功，已尝试重新读取服务器状态，填写内容仍保留。请先核对当前状态；若已发布，可点击“暂不发布”返回结果。不会自动重复提交。");
      } else {
        setActionError(error instanceof Error ? error.message : "发布失败，填写的内容已保留，请重试。");
      }
    } finally {
      actionInFlight.current = false;
      setAction(null);
    }
  };

  const withdraw = async () => {
    if (!state?.listing || actionInFlight.current || loading) return;
    if (!window.confirm("退出后，当前摘要不再进入后续匹配结果，已保存的 AI 对话不会删除。其他用户此前看到的内容无法撤回。确定退出匹配？")) return;
    actionInFlight.current = true;
    setAction("withdraw");
    setActionError("");
    setMessage("");
    try {
      const withdrawn = await withdrawMatchingListing(state.listing.id, state.listing.version);
      setState((current) => current ? { ...current, listing: withdrawn } : current);
      setResults(null);
      setEditing(false);
      setConsent(false);
      setMessage("已退出匹配，后续检索不再返回当前摘要。你的 AI 对话和确认档案仍然保留。");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code !== "ACTIVE_ROLE_CHANGED") await refreshState();
      setActionError(error instanceof Error ? error.message : "退出匹配失败，请重试。");
    } finally {
      actionInFlight.current = false;
      setAction(null);
    }
  };

  const entry = state?.source?.confirmed
    ? <button type="button" className="button button-primary" disabled={loading || busy} onClick={openMatching}>{findLabel}<ArrowRight size={17} aria-hidden="true" /></button>
    : <a className="button button-primary" href={discoveryHref}>{isTalent ? "继续完善能力档案" : "继续梳理用人需求"}<ArrowRight size={17} aria-hidden="true" /></a>;

  if (compact && !expanded) return (
    <section className="matching-panel" aria-label={`${noun}匹配`}>
      {loading ? <p role="status">正在读取匹配状态…</p> : loadError ? <><p role="alert">{loadError}</p><button className="button matching-panel__secondary" type="button" onClick={() => void refreshState()}>重新加载匹配</button></> : entry}
      {!loading && !loadError && <p>已带入确认内容，可先私密查看示例匹配；公开前由你确认。</p>}
    </section>
  );

  return (
    <section className="matching-panel" aria-label={`${noun}匹配`}>
      <div className="matching-panel__surface">
        <header className="matching-panel__header">
          <div>
            <span className="matching-panel__eyebrow">从确认的{isTalent ? "能力" : "需求"}出发</span>
            <h2 className="matching-panel__heading">找到合适的{noun}</h2>
            <p>已带入你确认的内容，只需核对。匹配会说明相关工作与待核实事项，最终由你判断。</p>
          </div>
          {!loading && !loadError && (!expanded || !state?.listing?.active) && !editing && entry}
          {!loading && state?.listing?.active && <span className="matching-panel__status"><CheckCircle size={17} aria-hidden="true" />已参与匹配</span>}
        </header>
        {loading && <p role="status">正在读取匹配状态…</p>}
        {loadError && <div className="matching-panel__body"><p className="matching-panel__notice" role="alert">{loadError}</p><div><button className="button matching-panel__secondary" type="button" disabled={loading} onClick={() => void refreshState()}>重新加载匹配</button></div></div>}
        {message && <p className="matching-panel__notice" role="status">{message}</p>}
        {actionError && <p className="matching-panel__notice" role="alert">{actionError}</p>}
        {!loading && state && !state.source?.confirmed && <p className="matching-panel__notice">请先确认保存当前{isTalent ? "能力档案" : "用人需求"}，再参与匹配。修改后的草稿不会继续用于匹配。<a href={discoveryHref}>返回对话继续完善</a></p>}
        {!loading && state?.listing?.status === "published" && !state.listing.active && <p className="matching-panel__notice">原展示版本已暂停匹配。请先确认最新档案，再预览并重新发布；旧版本不会自动替你更新。</p>}
        {!loading && state?.listing?.status === "withdrawn" && !editing && <p>当前已退出匹配。需要重新参与时，请再次预览并确认展示内容。</p>}

        {expanded && editing && draft && state && <div className="matching-panel__body">
          {draftIsStale && <div className="matching-panel__notice" role="alert"><p>预览依据的版本已发生变化。当前输入仍保留，但不能直接发布到新版本。下面的操作会替换尚未发布的编辑，请先保留你需要的文字。</p><button className="button matching-panel__secondary" type="button" disabled={busy || loading || !state.source?.confirmed} onClick={() => { if (window.confirm("将使用最新确认内容替换尚未发布的编辑，继续吗？")) editListing(); }}>使用最新确认内容重新预览</button></div>}
          <form ref={formRef} className="matching-panel__form" aria-label="匹配资料预览" onSubmit={(event) => void submit(event)} noValidate>
            <div><h3 className="matching-panel__results-title">预览并编辑展示内容</h3><p>内容来自已确认的{isTalent ? "能力档案" : "需求"}，无需重新填写。点击发布后才会向其他已登录用户展示；请检查并移除联系方式与保密信息。</p></div>
            <fieldset className="matching-panel__fieldset" disabled={busy || loading}>
              <div className="matching-panel__fields">
                <div className="matching-panel__field matching-panel__field--full">
                  <label htmlFor={`${prefix}-title`}>展示标题</label>
                  <input id={`${prefix}-title`} value={draft.title} maxLength={60} required aria-invalid={Boolean(errors.title)} aria-describedby={errors.title ? `${prefix}-title-error` : undefined} onChange={(event) => changeDraft("title", event.target.value)} />
                  {errors.title && <span className="matching-panel__field-error" id={`${prefix}-title-error`}>{errors.title}</span>}
                </div>
                <div className="matching-panel__field matching-panel__field--full">
                  <label htmlFor={`${prefix}-summary`}>展示摘要</label>
                  <textarea id={`${prefix}-summary`} value={draft.summary} maxLength={500} rows={5} required aria-invalid={Boolean(errors.summary)} aria-describedby={`${prefix}-summary-help${errors.summary ? ` ${prefix}-summary-error` : ""}`} onChange={(event) => changeDraft("summary", event.target.value)} />
                  <small id={`${prefix}-summary-help`}>{isTalent ? "说明本人负责的工作、具体行动与结果，不要把团队成果写成个人成果。" : "说明要完成的工作和预期结果，不需要堆砌技术名词。"} {draft.summary.length}/500</small>
                  {errors.summary && <span className="matching-panel__field-error" id={`${prefix}-summary-error`}>{errors.summary}</span>}
                </div>
              </div>
            </fieldset>

            <fieldset className="matching-panel__fieldset" aria-label="工作能力" disabled={busy || loading}>
              <legend>{isTalent ? "我能提供的工作能力" : "这项工作需要的能力"}</legend>
              <p className="matching-panel__hint">已从实际工作中提炼 {draft.skills.length} 项，请取消不准确的内容；最多保留 8 项。</p>
              {(allSkills || !draft.skills.length) && <div className="matching-panel__field matching-panel__skill-search"><label htmlFor={`${prefix}-skill-search`}>查找工作能力</label><input id={`${prefix}-skill-search`} type="search" value={skillSearch} placeholder="输入 AI、评测、出海等关键词" onChange={(event) => setSkillSearch(event.target.value)} /></div>}
              <div className="matching-panel__skills">{(allSkills || !draft.skills.length ? state.skills.filter((skill) => skill.toLowerCase().includes(skillSearch.trim().toLowerCase()) || draft.skills.includes(skill)) : state.skills.filter((skill) => draft.skills.includes(skill))).map((skill, index) => <label className="matching-panel__skill" key={skill}><input type="checkbox" checked={draft.skills.includes(skill)} disabled={!draft.skills.includes(skill) && draft.skills.length >= 8} aria-invalid={index === 0 && Boolean(errors.skills)} aria-describedby={errors.skills ? `${prefix}-skills-error` : undefined} onChange={(event) => toggleSkill(skill, event.target.checked)} />{skill}</label>)}</div>
              {draft.skills.length > 0 && <button className="button matching-panel__secondary matching-panel__more" type="button" aria-expanded={allSkills} onClick={() => setAllSkills((value) => !value)}>{allSkills ? "收起其他能力" : "调整或添加能力"}</button>}
              {errors.skills && <p className="matching-panel__field-error" id={`${prefix}-skills-error`}>{errors.skills}</p>}
            </fieldset>

            <details open={Boolean(errors.location || errors.constraints)} className="matching-panel__conditions">
              <summary>合作条件：{matchingConditionsSummary(draft, state.workModes, state.engagements, isTalent)}<span>查看或调整</span></summary>
            <fieldset className="matching-panel__fieldset" disabled={busy || loading} tabIndex={errors.constraints ? -1 : undefined} aria-invalid={Boolean(errors.constraints)} aria-describedby={errors.constraints ? `${prefix}-constraints-error` : undefined}>
              <legend>合作条件</legend>
              <div className="matching-panel__fields">
                <div className="matching-panel__field"><label htmlFor={`${prefix}-work-mode`}>工作方式</label><select id={`${prefix}-work-mode`} value={draft.workMode} onChange={(event) => changeDraft("workMode", event.target.value as WorkMode)}>{Object.entries(state.workModes).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
                <div className="matching-panel__field"><label htmlFor={`${prefix}-engagement`}>合作方式</label><select id={`${prefix}-engagement`} value={draft.engagement} onChange={(event) => changeDraft("engagement", event.target.value as Engagement)}>{Object.entries(state.engagements).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
                <div className="matching-panel__field matching-panel__field--full"><label htmlFor={`${prefix}-location`}>工作地点</label><input id={`${prefix}-location`} value={draft.location} maxLength={60} placeholder="填写一个城市，如上海；远程可留空" required={draft.workMode === "onsite" || draft.workMode === "hybrid"} aria-invalid={Boolean(errors.location)} aria-describedby={errors.location ? `${prefix}-location-error` : undefined} onChange={(event) => changeDraft("location", event.target.value)} />{errors.location && <span className="matching-panel__field-error" id={`${prefix}-location-error`}>{errors.location}</span>}</div>
              </div>
              <p className="matching-panel__hint">这些条件会影响筛选。选择“可协商”则不限制；远程和混合办公分别匹配，现场或混合办公请填写一个城市。</p>
              <div className="matching-panel__fields matching-panel__more">
                <div className="matching-panel__field"><label htmlFor={`${prefix}-markets`}>{isTalent ? "服务过的市场" : "目标市场"}</label><input id={`${prefix}-markets`} value={draft.constraints?.markets.join("、") ?? ""} placeholder="如德国、美国；没有要求可留空" maxLength={200} onChange={(event) => changeConstraint("markets", event.target.value.split(/[,，、;；]/u))} /></div>
                <div className="matching-panel__field"><label htmlFor={`${prefix}-languages`}>工作语言</label><input id={`${prefix}-languages`} value={draft.constraints?.languages.join("、") ?? ""} placeholder="如英语、德语" maxLength={200} onChange={(event) => changeConstraint("languages", event.target.value.split(/[,，、;；]/u))} /></div>
                <div className="matching-panel__field"><label htmlFor={`${prefix}-hours`}>{isTalent ? "每周可投入时间（小时）" : "每周最低投入（小时）"}</label><input id={`${prefix}-hours`} type="number" min={1} max={168} value={draft.constraints?.weeklyHours ?? ""} onChange={(event) => changeConstraint("weeklyHours", event.target.value ? Number(event.target.value) : null)} /></div>
                <div className="matching-panel__field"><label htmlFor={`${prefix}-available`}>{isTalent ? "最早开始日期" : "最晚开始日期"}</label><input id={`${prefix}-available`} type="date" value={draft.constraints?.availableFrom ?? ""} onChange={(event) => changeConstraint("availableFrom", event.target.value)} /></div>
                <div className="matching-panel__field"><label htmlFor={`${prefix}-budget-min`}>{isTalent ? "期望报酬下限" : "预算下限"}</label><input id={`${prefix}-budget-min`} type="number" min={1} value={draft.constraints?.budgetMin ?? ""} onChange={(event) => changeConstraint("budgetMin", event.target.value ? Number(event.target.value) : null)} /></div>
                <div className="matching-panel__field"><label htmlFor={`${prefix}-budget-max`}>{isTalent ? "期望报酬上限" : "预算上限"}</label><input id={`${prefix}-budget-max`} type="number" min={1} value={draft.constraints?.budgetMax ?? ""} onChange={(event) => changeConstraint("budgetMax", event.target.value ? Number(event.target.value) : null)} /></div>
                <div className="matching-panel__field"><label htmlFor={`${prefix}-currency`}>币种</label><select id={`${prefix}-currency`} value={draft.constraints?.budgetCurrency ?? ""} onChange={(event) => changeConstraint("budgetCurrency", event.target.value as MatchingConstraints["budgetCurrency"] || null)}><option value="">待确认</option><option value="CNY">人民币</option><option value="USD">美元</option><option value="EUR">欧元</option></select></div>
                <div className="matching-panel__field"><label htmlFor={`${prefix}-budget-period`}>计费方式</label><select id={`${prefix}-budget-period`} value={draft.constraints?.budgetPeriod ?? ""} onChange={(event) => changeConstraint("budgetPeriod", event.target.value as MatchingConstraints["budgetPeriod"] || null)}><option value="">待确认</option><option value="project">按项目</option><option value="month">按月</option><option value="hour">按小时</option></select></div>
              </div>
              {errors.constraints && <p className="matching-panel__field-error" id={`${prefix}-constraints-error`} role="alert">{errors.constraints}</p>}
              <p className="matching-panel__hint">未填写的条件会标为待确认。预算仅在币种和计费方式一致时比较；目标市场和工作语言按必须满足的条件筛选。</p>
            </fieldset>
            </details>

            {Boolean(state.suggestionEvidence?.length || state.knowledgeSources?.length) && <details><summary>查看提炼依据与参考资料</summary><div className="matching-panel__body">{state.suggestionEvidence?.map((item, index) => <div className="matching-panel__reason" key={`${item.field}:${index}`}><h5>{evidenceLabel(item, state)}</h5><blockquote>{item.quote}</blockquote></div>)}{Boolean(state.knowledgeSources?.length) && <div><p className="matching-panel__hint">以下资料用于理解工作与核实要点，不用于证明个人能力。</p><ul>{state.knowledgeSources?.map((source) => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title}</a></li>)}</ul></div>}</div></details>}

            <details>
              <summary>补充筛选条件与说明（选填）</summary>
              <div className="matching-panel__body">
                {!isTalent && <fieldset className="matching-panel__fieldset" aria-label="必须具备的能力" disabled={busy || loading}><legend>其中哪些能力必须具备？</legend><p className="matching-panel__hint">只有公开资料中列出全部必需能力的人才会进入结果，不代表能力已获验证。未勾选的能力只用于比较相关性。</p><div className="matching-panel__skills">{draft.skills.map((skill) => <label className="matching-panel__skill" key={skill}><input type="checkbox" checked={draft.requiredSkills.includes(skill)} onChange={(event) => changeDraft("requiredSkills", event.target.checked ? [...draft.requiredSkills, skill] : draft.requiredSkills.filter((item) => item !== skill))} />必须具备：{skill}</label>)}</div></fieldset>}
                <div className="matching-panel__field"><label htmlFor={`${prefix}-notes`}>补充说明</label><textarea id={`${prefix}-notes`} value={draft.notes} maxLength={200} rows={3} disabled={busy || loading} aria-invalid={Boolean(errors.notes)} onChange={(event) => changeDraft("notes", event.target.value)} />{errors.notes && <span className="matching-panel__field-error">{errors.notes}</span>}<small>预算、可投入时间等可以在此说明，但仍需双方另行核实；请勿填写联系方式。</small></div>
              </div>
            </details>

            <div>
              <label className="matching-panel__consent"><input type="checkbox" checked={consent} disabled={busy || loading || draftIsStale || !state.source?.confirmed} aria-invalid={Boolean(errors.consent)} aria-describedby={errors.consent ? `${prefix}-consent-error` : undefined} onChange={(event) => { setConsent(event.target.checked); setErrors((current) => ({ ...current, consent: undefined })); }} />{consentLabel}</label>
              {errors.consent && <span className="matching-panel__field-error" id={`${prefix}-consent-error`} role="alert">{errors.consent}</span>}
              <div className="matching-panel__actions">
                <button className="button matching-panel__secondary" type="button" disabled={busy || loading || draftIsStale || !state.source?.confirmed || examplesLoading} aria-busy={examplesLoading} onClick={() => void previewExamples()}>{examplesLoading ? "正在比较示例…" : "查看示例匹配"}</button>
                <button className="button button-primary" type="submit" disabled={busy || loading || Boolean(loadError) || draftIsStale || !state.source?.confirmed} aria-busy={action === "publish"}>{action === "publish" ? "正在发布匹配资料…" : state.listing?.active ? "确认更新匹配资料" : "确认发布并查看匹配"}<ArrowRight size={17} aria-hidden="true" /></button>
                <button className="button matching-panel__secondary" type="button" disabled={busy || loading} onClick={() => { setEditing(false); setConsent(false); setErrors({}); }}>暂不发布</button>
              </div>
              <p className="matching-panel__hint">查看示例无需公开资料。只有勾选同意并点击发布后，以上摘要才会用于真实用户之间的匹配；完整对话和附件不会公开。</p>
            </div>
          </form>
        </div>}

        {(examplesLoading || exampleError || exampleResults) && state && <section className="matching-panel__body matching-panel__results" aria-label="示例匹配结果" aria-busy={examplesLoading}>
          <h3 className="matching-panel__results-title">示例匹配 · 仅供比较</h3>
          <p>这里是构建的示例人才与需求，用于检查提炼结果、匹配理由和信息缺口。不是可联系的真实用户，查看不会发布你的资料。</p>
          {examplesLoading && <p role="status">正在核对示例的工作能力与合作条件…</p>}
          {exampleError && <p role="alert">{exampleError}</p>}
          {!examplesLoading && exampleResults && (exampleResults.matches.length ? <MatchingResultCards results={exampleResults} state={state} /> : <p>示例库中暂无符合这些条件的内容。你可以检查条件是否准确；不会为了展示结果放宽必需条件。</p>)}
        </section>}

        {state?.listing?.status === "published" && ((!editing && expanded) || !state.listing.active) && <div className="matching-panel__body">
          <div className="matching-panel__actions">
            {!editing && state.source?.confirmed && <button className="button matching-panel__secondary" type="button" onClick={editListing} disabled={busy || loading}>修改展示资料</button>}
            <button className="button matching-panel__secondary" type="button" onClick={() => void withdraw()} disabled={busy || loading}>{action === "withdraw" ? "正在退出匹配…" : "退出匹配"}</button>
          </div>
        </div>}
        {expanded && !editing && state?.listing?.active && <div className="matching-panel__body">
          <section className="matching-panel__results" aria-label="匹配结果" aria-busy={resultsLoading}>
            <header className="matching-panel__result-header"><h3 className="matching-panel__results-title">{noun}匹配结果</h3><button className="button matching-panel__secondary" type="button" disabled={resultsLoading || loading || busy} onClick={() => setResultAttempt((attempt) => attempt + 1)}>刷新匹配结果</button></header>
            <p>仅包含其他用户主动发布且仍有效的摘要。结果按共同工作能力排序，不是胜任概率；经历未经平台核验，预算与可投入时间仍需另行确认。</p>
            {resultsLoading && <p role="status">正在比较已发布的工作能力与合作条件…</p>}
            {resultsError && <p className="matching-panel__notice" role="alert">{resultsError} 可点击“刷新匹配结果”重试。</p>}
            {!resultsLoading && results && results.matches.length === 0 && <div className="matching-panel__empty"><h3>{results.catalogLimited ? "本次检索范围内暂未找到符合条件的" : "暂时没有符合条件的"}{noun}</h3><p>本次检索的有效发布中，暂未找到与你的能力和合作条件相符的内容。你可以检查筛选条件，或稍后回来刷新；不会用演示资料填充结果。</p><div className="matching-panel__actions"><button className="button matching-panel__secondary" type="button" onClick={editListing}>调整匹配条件</button></div></div>}
            {!resultsLoading && results && results.matches.length > 0 && <>
              <p>本次检索命中 {results.total} 条相关结果，当前展示 {results.matches.length} 条。</p>
              <MatchingResultCards results={results} state={state} />
            </>}
            {results?.catalogLimited && <p className="matching-panel__hint">当前候选范围有数量限制，结果不代表全站完整名单。</p>}
            <p className="matching-panel__hint">当前提供匹配与比较，尚不支持站内联系、发送邀约或自动建立合作。</p>
          </section>
        </div>}
      </div>
    </section>
  );
}
