import { lazy, Suspense, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { List } from "@phosphor-icons/react/List";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { Moon } from "@phosphor-icons/react/Moon";
import { Sparkle } from "@phosphor-icons/react/Sparkle";
import { Sun } from "@phosphor-icons/react/Sun";
import { X } from "@phosphor-icons/react/X";
import { ACTIVE_ROLE_CHANGED_EVENT, ApiError } from "./api";
import { AuthPage, EnterpriseContactDialog, NotFoundPage, SecondaryPage, WorkspacePage } from "./SecondaryPages";
import { AUTH_SYNC_STORAGE_KEY, AUTH_UPDATED_EVENT, buildAuthHref, clearAuthSession, completeEmailAuth, currentPathWithSearchAndHash, loadAuthSession, normalizeReturnTo, readAuthSession, switchAuthRole, type AuthSession } from "./auth";
import { createDiscoveryIntake } from "./discoveryStore";
import { RoleSwitcher, type RoleSwitchProps } from "./RoleSwitcher";
import { PasswordSetupPage } from "./PasswordSetupPage";
import { secondaryRouteDescriptions, secondaryRouteTitles, type SecondaryRoute } from "./secondaryRoutes";

type Theme = "light" | "dark";

const AdminInquiriesPage = lazy(() => import("./AdminInquiriesPage"));

const THEME_STORAGE_KEY = "duduhire-theme";
const LEGACY_THEME_STORAGE_KEY = "valuebridge-theme";


const navItems = [
  { label: "首页", href: "/" },
  { label: secondaryRouteTitles.talent, href: "/talent" },
  { label: secondaryRouteTitles.projects, href: "/projects" },
  { label: "工作方式", href: "/how-it-works" },
  { label: "企业服务", href: "/enterprise" },
];

const howPaths = {
  problem: {
    label: "为需求方解决痛点",
    action: "描述业务问题",
    actionHref: "/talent",
    steps: [
      {
        title: "描述真实问题",
        body: "说说你遇到了什么问题、想改善什么，以及时间或预算限制。AI 会帮你梳理现状，并建议下一步需要补充什么。",
        image: "/images/home-card-clarify-need-v3.webp",
        imagePosition: "45% 0%",
      },
      {
        title: "挑选合适候选人",
        body: "比较候选人的能力证据，结合其角色、行动、成果与验证方式，判断谁更适合当前需求。",
        image: "/images/home-card-compare-evidence-v3.webp",
        imagePosition: "50% 70%",
      },
      {
        title: "确认交付结果",
        body: "确认合作目标与下一步，并把结果补充为后续可复用的记录。",
        image: "/images/home-card-confirm-delivery-v2.webp",
        imagePosition: "73% 100%",
      },
    ],
  },
  value: {
    label: "为个人发现价值",
    action: "发现你的价值",
    actionHref: "/projects",
    steps: [
      {
        title: "建立能力档案",
        body: "说明你解决过什么问题、承担什么角色，以及如何行动。",
        image: "/images/home-card-build-profile-v3.webp",
        imagePosition: "52% 0%",
      },
      {
        title: "补充可信证据",
        body: "关联交付成果、过程记录与客户评价，形成可核验的能力证据与合作信誉。",
        image: "/images/home-card-verify-evidence-v2.webp",
        imagePosition: "50% 45%",
      },
      {
        title: "确认适合的合作机会",
        body: "根据自己的兴趣与专长判断项目，并与需求方确认范围、方式与预期结果。",
        image: "/images/home-card-earn-reward-v4.webp",
        imagePosition: "42% 0%",
      },
    ],
  },
} as const;

function ThemeButton({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button className="icon-button" type="button" onClick={onToggle} aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"}>
      {theme === "light" ? <Moon size={18} weight="bold" /> : <Sun size={18} weight="bold" />}
    </button>
  );
}

function BrandLogo() {
  return (
    <a className="brand" href="/" aria-label="DuduHire 首页">
      <img className="brand-logo" src="/images/duduhire-logo.png" width="1341" height="410" alt="DuduHire" />
    </a>
  );
}

function Header({ theme, onThemeToggle, session, onLogout, roleSwitch }: { theme: Theme; onThemeToggle: () => void; session: AuthSession | null; onLogout: () => void; roleSwitch: RoleSwitchProps }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const mobileNavRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const currentPath = window.location.pathname.replace(/\/+$/, "") || "/";
  const visibleNavItems = navItems.filter((item) => !session
    || item.href !== (session.role === "client" ? "/projects" : "/talent"));

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 921px)");
    const closeOnDesktop = () => { if (desktop.matches) setMenuOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backgroundElements = Array.from(document.querySelectorAll<HTMLElement>(
      "#main, .site-footer, .site-header .brand, .site-header .desktop-nav, .site-header .skip-link, .site-header .nav-actions > :not(.menu-button)",
    )).map((element) => ({ element, wasInert: element.inert }));
    const focusTimer = window.setTimeout(() => mobileNavRef.current?.querySelector<HTMLElement>('a[href], button:not([disabled])')?.focus(), 0);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.body.style.overflow = "hidden";
    backgroundElements.forEach(({ element }) => { element.inert = true; });
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      backgroundElements.forEach(({ element, wasInert }) => { element.inert = wasInert; });
      window.removeEventListener("keydown", closeOnEscape);
      previousFocus?.focus();
    };
  }, [menuOpen]);

  const handleMobileNavKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = [menuButtonRef.current, ...Array.from(mobileNavRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])]
      .filter((element): element is HTMLElement => element !== null);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <>
    <header className="site-header">
      <a className="skip-link" href="#main">跳到主要内容</a>
      <div className="nav-shell">
        <BrandLogo />
        <nav className="desktop-nav" aria-label="主导航">
          {visibleNavItems.map((item) => (
            <a key={item.label} href={item.href} aria-current={currentPath === item.href ? "page" : undefined}>{item.label}</a>
          ))}
        </nav>
        <div className="nav-actions">
          <ThemeButton theme={theme} onToggle={onThemeToggle} />
          {session ? (
            <>
              <div className="nav-role-switch"><RoleSwitcher {...roleSwitch} /></div>
              <a className="nav-login" href="/workspace" aria-current={currentPath === "/workspace" ? "page" : undefined}>工作台</a>
              <button className="nav-session-action" type="button" disabled={roleSwitch.switching} onClick={onLogout}>退出登录</button>
            </>
          ) : (
            <>
              <a className="nav-login" href="/login" aria-current={currentPath === "/login" ? "page" : undefined}>登录</a>
              <a className="nav-cta" href="/signup" aria-current={currentPath === "/signup" ? "page" : undefined}>免费注册</a>
            </>
          )}
          <button ref={menuButtonRef} className="menu-button" type="button" aria-label={menuOpen ? "关闭导航" : "打开导航"} aria-controls="mobile-navigation" aria-expanded={menuOpen} onKeyDown={menuOpen ? handleMobileNavKeyDown : undefined} onClick={() => setMenuOpen((value) => !value)}>
            {menuOpen ? <X size={22} /> : <List size={22} />}
          </button>
        </div>
      </div>
    </header>
      {menuOpen && (
          <>
            <button
              className="mobile-nav-backdrop"
              type="button"
              tabIndex={-1}
              aria-label="关闭导航菜单"
              onClick={() => setMenuOpen(false)}
            />
            <nav
              id="mobile-navigation"
              ref={mobileNavRef}
              className="mobile-nav"
              aria-label="移动端导航"
              onKeyDown={handleMobileNavKeyDown}
            >
              {visibleNavItems.map((item) => (
                <a key={item.href} href={item.href} aria-current={currentPath === item.href ? "page" : undefined} onClick={() => setMenuOpen(false)}>{item.label}</a>
              ))}
              {session ? (
                <>
                  <RoleSwitcher {...roleSwitch} />
                  <a href="/workspace" aria-current={currentPath === "/workspace" ? "page" : undefined} onClick={() => setMenuOpen(false)}>工作台</a>
                  <button className="mobile-nav-logout" type="button" disabled={roleSwitch.switching} onClick={() => { setMenuOpen(false); onLogout(); }}>退出登录</button>
                </>
              ) : (
                <>
                  <a href="/login" aria-current={currentPath === "/login" ? "page" : undefined} onClick={() => setMenuOpen(false)}>登录</a>
                  <a className="button button-primary" href="/signup" onClick={() => setMenuOpen(false)}>免费注册 <ArrowRight size={18} /></a>
                </>
              )}
            </nav>
          </>
      )}
    </>
  );
}

function Hero() {
  const [intent, setIntent] = useState<"talent" | "work">("talent");
  const [query, setQuery] = useState("");
  const [queryError, setQueryError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const searchInFlightRef = useRef(false);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncVideo = () => {
      const video = videoRef.current;
      if (!video) return;
      if (preference.matches) {
        video.pause();
        if (video.readyState > 0) video.currentTime = 0;
      } else {
        void video.play().catch(() => undefined);
      }
    };
    syncVideo();
    preference.addEventListener("change", syncVideo);
    return () => preference.removeEventListener("change", syncVideo);
  }, []);

  const submitSearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (searchInFlightRef.current) return;
    searchInFlightRef.current = true;
    setIsSubmitting(true);
    setQueryError("");
    const prompt = query.trim();
    try {
      const intakeId = prompt ? await createDiscoveryIntake(prompt) : null;
      const destination = intakeId ? `/talent?intake=${encodeURIComponent(intakeId)}` : "/talent";
      const session = readAuthSession() ?? await loadAuthSession();
      window.location.assign(session ? destination : buildAuthHref("login", destination));
    } catch (error) {
      setQueryError(error instanceof Error ? error.message : "内容提交失败，请稍后重试。");
      searchInFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <section className="hero" id="top">
      <div className="hero-stage">
        <div className="hero-media" aria-hidden="true">
          <video
            ref={videoRef}
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            poster="/images/home-hero-team-kling-poster.jpg"
            disablePictureInPicture
          >
            <source src="/images/home-hero-team-kling.mp4" type="video/mp4" />
          </video>
        </div>
        <div className="hero-copy">
          <h1><span>让真实痛点</span><span>与真实能力更好地相遇</span></h1>
          <p className="hero-subtitle">
            <span>AI 帮你梳理业务需求，</span>
            <span>也帮你把项目经历整理成能力档案。</span>
          </p>
          <form className="hero-search" onSubmit={submitSearch} aria-busy={isSubmitting}>
          <div className="intent-toggle" role="group" aria-label="选择使用目的">
            <button type="button" disabled={isSubmitting} aria-pressed={intent === "talent"} className={intent === "talent" ? "active" : ""} onClick={() => { setIntent("talent"); setQueryError(""); }}>我想解决业务问题</button>
            <button type="button" disabled={isSubmitting} aria-pressed={intent === "work"} className={intent === "work" ? "active" : ""} onClick={() => { setIntent("work"); setQueryError(""); }}>我想发现自己的价值</button>
          </div>
          {intent === "talent" ? (
            <>
              <label className="sr-only" htmlFor="market-search">描述业务问题</label>
              <div className="search-control">
                <MagnifyingGlass size={21} weight="bold" aria-hidden="true" />
                <input
                  id="market-search"
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setQueryError(""); }}
                  maxLength={12_000}
                  disabled={isSubmitting}
                  aria-describedby={queryError ? "hero-search-error" : undefined}
                  placeholder="描述你真正想解决的问题..."
                />
                <button type="submit" disabled={isSubmitting}><MagnifyingGlass size={24} weight="bold" aria-hidden="true" />{isSubmitting ? "提交中…" : "开始梳理"}</button>
              </div>
            </>
          ) : (
            <a className="identity-card-start" href="/projects">开始构建能力档案<ArrowRight size={22} weight="bold" aria-hidden="true" /></a>
          )}
          {queryError && <p id="hero-search-error" className="hero-search-error" role="alert">{queryError}</p>}
          </form>
        </div>
        {intent === "talent" && (
          <div className="popular-searches" aria-label="热门搜索">
            <strong>热门搜索</strong>
            {[
              ["AI 客服自动化", "operations"],
              ["品牌视觉升级", "design"],
              ["数据分析", "product"],
              ["短视频制作", "design"],
              ["工作流自动化", "operations"],
              ["网站重构", "product"],
            ].map(([item, category]) => <a key={item} href={`/talent?category=${category}`}>{item}</a>)}
          </div>
        )}
      </div>
    </section>
  );
}

function PlatformProof() {
  const items = [
    "需求结构化",
    "能力证据化",
    "推荐可解释",
    "结果可追踪",
  ];

  return (
    <section className="method-strip" aria-label="DuduHire 方法">
      <div className="method-shell">
        <p><span>DuduHire Method</span><strong>从真实需求到可验证结果</strong></p>
        <ol>
          {items.map((item, index) => (
            <li key={item}><span>{String(index + 1).padStart(2, "0")}</span>{item}</li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function ValueSection() {
  const logic = [
    { label: "Demand", title: "需求是否清晰", body: "先明确目标、边界与成功标准。" },
    { label: "Capability", title: "能力是否匹配", body: "把经验还原为具体角色与行动。" },
    { label: "Evidence", title: "证据是否可信", body: "核对交付物、过程记录与结果。" },
    { label: "Outcome", title: "结果是否满意", body: "让成果成为下一次判断的依据。" },
  ];

  return (
    <section className="section value-section" id="value">
      <div className="section-shell value-logic">
        <div className="value-logic-intro">
          <h2><span>AI 驱动的</span><span>人才价值匹配平台</span></h2>
          <p>DuduHire 帮你说清需求、整理项目经历与成果，让你更好地判断是否适合合作。AI 提供建议，决定由你作出。</p>
        </div>
        <div className="logic-track">
          {logic.map((item, index) => (
            <article className={index === logic.length - 1 ? "logic-step logic-result" : "logic-step"} key={item.label}>
              <div className="logic-meta"><span>{String(index + 1).padStart(2, "0")}</span><small>{item.label}</small></div>
              <div><strong>{item.title}</strong><p>{item.body}</p></div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorksSection() {
  const [path, setPath] = useState<keyof typeof howPaths>("problem");
  const content = howPaths[path];

  return (
    <section className="section how-section" id="how-it-works">
      <div className="section-shell">
        <div className="how-heading">
          <div>
            <p className="section-kicker">简单三步，开始高质量协作</p>
            <h2>DuduHire 如何工作</h2>
          </div>
          <div className="how-tabs" aria-label="选择使用方式">
            <button type="button" className={path === "problem" ? "active" : ""} aria-pressed={path === "problem"} onClick={() => setPath("problem")}>我想解决业务问题</button>
            <button type="button" className={path === "value" ? "active" : ""} aria-pressed={path === "value"} onClick={() => setPath("value")}>我想发现自己的价值</button>
          </div>
        </div>
        <ol className="how-card-grid" key={path} aria-label={`${content.label}的三个步骤`}>
          {content.steps.map((step, index) => (
              <li className="how-path-card" key={step.title}>
                <img
                  className="how-card-image"
                  src={step.image}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  aria-hidden="true"
                  style={{ objectPosition: step.imagePosition }}
                />
                <div className="how-path-card-inner">
                  <div className="how-step-copy">
                    <strong>{step.title}</strong>
                    <p>{step.body}</p>
                  </div>
                  <div className="how-card-footer">
                    <span className="how-card-progress" aria-hidden="true">
                      {content.steps.map((progressStep, progressIndex) => (
                        <i className={progressIndex <= index ? "active" : ""} key={progressStep.title} />
                      ))}
                    </span>
                    {index === content.steps.length - 1 && (
                      <a className="button how-action" href={content.actionHref}>{content.action}<ArrowRight size={18} weight="bold" /></a>
                    )}
                  </div>
                </div>
              </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function PricingSection() {
  const [contactOpen, setContactOpen] = useState(false);
  const plans = [
    {
      name: "个人与单次项目",
      price: "基础版",
      description: "适合偶尔发起合作与单次项目，从一个问题开始。",
      action: "免费开始",
      href: "/signup?returnTo=%2Ftalent",
      features: [
        { text: "按需求匹配候选人并查看理由", included: true },
        { text: "浏览结构化能力档案", included: true },
        { text: "查看案例、证据与历史结果", included: true },
        { text: "保存候选人并记录下一步", included: true },
        { text: "多人评审与团队协作控制", included: false },
      ],
    },
    {
      name: "持续协作与治理",
      price: "团队版",
      description: "适合持续合作、重复采购与团队协同，让专业协作规模化运行。",
      action: "联系专家",
      opensContact: true,
      features: [
        { text: "按需求匹配候选人并查看理由", included: true },
        { text: "浏览结构化能力档案", included: true },
        { text: "查看案例、证据与历史结果", included: true },
        { text: "多人评审与团队协作控制", included: true },
        { text: "优先实施与治理支持", included: true },
      ],
      featured: true,
    },
  ];

  const updateSpotlight = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
    event.currentTarget.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
  };

  const resetSpotlight = (event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.style.setProperty("--spot-x", "-9999px");
    event.currentTarget.style.setProperty("--spot-y", "-9999px");
  };

  return (
    <section className="pricing-section" id="pricing">
      <div className="pricing-shell">
        <div className="pricing-heading">
          <div>
            <span className="pricing-label"><i aria-hidden="true" />服务方案</span>
            <h2>清晰的合作方案，<span>随你的需求持续扩展。</span></h2>
          </div>
          <p>从一次专业协作开始，<br />或为团队建立可以持续运行的能力网络。</p>
        </div>
        <div className="pricing-grid">
          {plans.map((plan) => (
            <div
              className={plan.featured ? "pricing-card-frame featured" : "pricing-card-frame"}
              key={plan.name}
              onPointerMove={updateSpotlight}
              onPointerLeave={resetSpotlight}
            >
              <article className="pricing-card">
                <div className="pricing-card-topline">
                  <span className="pricing-plan-name">{plan.name}</span>
                  {plan.featured && <span className="pricing-badge">推荐方案</span>}
                </div>
                <div className="pricing-divider" />
                <div className="pricing-price"><strong>{plan.price}</strong></div>
                <p className="pricing-description">{plan.description}</p>
                {plan.opensContact ? (
                  <button className="pricing-button primary" type="button" onClick={() => setContactOpen(true)}>
                    {plan.action}<ArrowRight size={16} weight="bold" />
                  </button>
                ) : (
                  <a className="pricing-button secondary" href={plan.href}>{plan.action}<ArrowRight size={16} weight="bold" /></a>
                )}
                <ul>
                  {plan.features.map((feature, index) => (
                    <li className={feature.included ? undefined : "excluded"} key={feature.text}>
                      <span>{feature.included ? <CheckCircle size={14} weight="fill" /> : <X size={13} weight="bold" />}</span>
                      {feature.text}
                      {index > 0 && <i aria-hidden="true" />}
                    </li>
                  ))}
                </ul>
              </article>
            </div>
          ))}
        </div>
      </div>
      <EnterpriseContactDialog open={contactOpen} onClose={() => setContactOpen(false)} source="home_pricing" />
    </section>
  );
}

function FinalCta() {
  const sectionRef = useRef<HTMLElement>(null);
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const observer = new IntersectionObserver(
      ([entry]) => setIsInView(entry.isIntersecting),
      { rootMargin: "120px 0px" },
    );

    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="section final-cta" ref={sectionRef}>
      <div className={`cta-shell${isInView ? " is-flowing" : ""}`}>
        <Sparkle size={30} weight="duotone" aria-hidden="true" />
        <div>
          <h2>找对人，把想做的事做成</h2>
          <p>不必先写完整需求。说说你想解决什么问题，AI 帮你理清需求、匹配候选人，并说明推荐理由。</p>
        </div>
        <a className="button button-primary button-large final-cta-button" href="/talent">
          <span className="final-cta-button__orb" aria-hidden="true" />
          <span className="final-cta-button__label">说说我想做的事</span>
          <span className="final-cta-button__arrow" aria-hidden="true">
            <ArrowRight size={20} weight="bold" />
          </span>
        </a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-shell">
        <BrandLogo />
        <p>让需求说得清，让能力看得见。</p>
        <div className="footer-links">
          <a href="/pricing">服务方案</a>
        </div>
        <p className="copyright">© {new Date().getFullYear()} DuduHire</p>
      </div>
    </footer>
  );
}

function AuthRedirect({ returnTo }: { returnTo: string }) {
  const loginHref = buildAuthHref("login", returnTo);

  useEffect(() => {
    window.location.replace(loginHref);
  }, [loginHref]);

  return (
    <section className="auth-redirect" aria-live="polite">
      <CircleNotchFallback />
      <h1>请先登录</h1>
      <p>正在带你前往登录页，登录后会回到这里。</p>
      <a href={loginHref}>如果没有自动跳转，请点这里</a>
    </section>
  );
}

function CircleNotchFallback() {
  return <span className="auth-redirect-spinner" aria-hidden="true" />;
}

function AuthStateLoading({ title = "正在确认登录状态" }: { title?: string }) {
  return (
    <section className="auth-redirect" aria-live="polite">
      <CircleNotchFallback />
      <h1>{title}</h1>
      <p>请稍候。</p>
    </section>
  );
}

function AuthStateError({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="auth-redirect" aria-live="polite">
      <h1>暂时无法确认登录状态</h1>
      <p>请检查网络连接后重试。</p>
      <button className="button button-primary" type="button" onClick={onRetry}>重新尝试</button>
    </section>
  );
}

function AuthVerifyPage() {
  const tokenRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);
  const [retrySequence, setRetrySequence] = useState(0);
  const [verificationUnavailable, setVerificationUnavailable] = useState(false);
  const [verificationDisabled, setVerificationDisabled] = useState(false);

  useEffect(() => {
    if (inFlightRef.current) return;
    if (!tokenRef.current) {
      tokenRef.current = new URLSearchParams(window.location.hash.slice(1)).get("token");
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    const token = tokenRef.current;
    if (!token) {
      window.location.replace("/login?authError=invalid_or_expired");
      return;
    }
    inFlightRef.current = true;
    setVerificationUnavailable(false);
    void completeEmailAuth(token)
      .then((result) => {
        if (result.authenticated) {
          window.location.replace(result.returnTo);
          return;
        }
        const params = new URLSearchParams({ authError: result.reason, returnTo: result.returnTo });
        window.location.replace(`/signup?${params.toString()}`);
      })
      .catch((error) => {
        if (error instanceof ApiError && error.code === "EMAIL_AUTH_DISABLED") {
          tokenRef.current = null;
          setVerificationDisabled(true);
          return;
        }
        if (error instanceof ApiError && error.status === 400) {
          const authError = error.code === "BROWSER_CONTEXT_REQUIRED" ? "browser_context_required" : "invalid_or_expired";
          window.location.replace(`/login?authError=${authError}`);
          return;
        }
        setVerificationUnavailable(true);
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  }, [retrySequence]);

  if (verificationDisabled) {
    return (
      <section className="auth-redirect" aria-live="polite">
        <h1>邮箱验证暂未启用</h1>
        <p>当前无法通过邮件链接登录，请返回登录页面查看可用方式。</p>
        <a className="button button-primary" href="/login">返回登录</a>
      </section>
    );
  }

  if (verificationUnavailable) {
    return (
      <section className="auth-redirect" aria-live="polite">
        <h1>验证服务暂时不可用</h1>
        <p>安全链接仍在当前页面中，请检查网络后重试。</p>
        <button className="button button-primary" type="button" onClick={() => setRetrySequence((value) => value + 1)}>重新验证</button>
      </section>
    );
  }
  return <AuthStateLoading title="正在验证邮箱" />;
}

function PageRedirect({ href, title, body }: { href: string; title: string; body: string }) {
  useEffect(() => {
    window.location.replace(href);
  }, [href]);

  return (
    <section className="auth-redirect" aria-live="polite">
      <CircleNotchFallback />
      <h1>{title}</h1>
      <p>{body}</p>
      <a href={href}>如果没有自动跳转，请点这里</a>
    </section>
  );
}

export default function App() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  const isHomePage = pathname === "/";
  const isWorkspacePage = pathname === "/workspace";
  const isAdminPage = pathname === "/admin/inquiries";
  const isAuthVerify = pathname === "/auth/verify";
  const isPasswordSetup = pathname === "/account/password";
  const isWorkspaceProfile = isWorkspacePage && new URLSearchParams(window.location.search).get("tab") === "profile";
  const authMode = pathname === "/login" ? "login" : pathname === "/signup" ? "signup" : null;
  const routeKey = pathname.slice(1) as SecondaryRoute;
  const secondaryRoute = Object.hasOwn(secondaryRouteTitles, routeKey) ? routeKey : null;
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = (localStorage.getItem(THEME_STORAGE_KEY) ?? localStorage.getItem(LEGACY_THEME_STORAGE_KEY)) as Theme | null;
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      // The system preference remains available when local storage is blocked.
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [session, setSession] = useState<AuthSession | null>(readAuthSession);
  const [authReady, setAuthReady] = useState(false);
  const [authLoadError, setAuthLoadError] = useState(false);
  const [authRetrySequence, setAuthRetrySequence] = useState(0);
  const [roleSwitchBusy, setRoleSwitchBusy] = useState(false);
  const [roleSwitchError, setRoleSwitchError] = useState("");
  const [roleContextStale, setRoleContextStale] = useState(false);
  const roleSwitchInFlightRef = useRef(false);
  const isProtectedPage = isPasswordSetup || isWorkspacePage || isAdminPage || routeKey === "talent" || routeKey === "projects";
  const sessionKey = session ? `${session.id}:${session.role}` : "guest";
  const expectedDiscoveryRoute = session?.role === "talent" ? "/projects" : "/talent";
  const isWrongDiscoveryRoute = Boolean(session)
    && (routeKey === "talent" || routeKey === "projects")
    && pathname !== expectedDiscoveryRoute;

  useEffect(() => {
    if (isAuthVerify) {
      setAuthReady(true);
      return;
    }
    let active = true;
    let syncRevision = 0;
    const syncSession = async (force = false) => {
      const revision = ++syncRevision;
      try {
        const nextSession = await loadAuthSession({ force });
        if (active && revision === syncRevision) {
          setSession(nextSession);
          setAuthLoadError(false);
        }
      } catch {
        if (active && revision === syncRevision) {
          setSession(readAuthSession());
          setAuthLoadError(true);
        }
      } finally {
        if (active && revision === syncRevision) setAuthReady(true);
      }
    };
    const handleAuthUpdate = () => {
      ++syncRevision;
      setSession(readAuthSession());
      setAuthLoadError(false);
      setAuthReady(true);
    };
    const refreshSession = () => void syncSession(true);
    const handleStorage = (event: StorageEvent) => {
      if (event.key === AUTH_SYNC_STORAGE_KEY) refreshSession();
    };
    const handleRoleConflict = () => setRoleContextStale(true);
    void syncSession();
    window.addEventListener(AUTH_UPDATED_EVENT, handleAuthUpdate);
    window.addEventListener("focus", refreshSession);
    window.addEventListener("storage", handleStorage);
    window.addEventListener(ACTIVE_ROLE_CHANGED_EVENT, handleRoleConflict);
    return () => {
      active = false;
      window.removeEventListener(AUTH_UPDATED_EVENT, handleAuthUpdate);
      window.removeEventListener("focus", refreshSession);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(ACTIVE_ROLE_CHANGED_EVENT, handleRoleConflict);
    };
  }, [authRetrySequence, isAuthVerify]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      localStorage.removeItem(LEGACY_THEME_STORAGE_KEY);
    } catch {
      // Theme changes still apply for the current page.
    }
  }, [theme]);

  useEffect(() => {
    const metaDescription = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (isHomePage) {
      document.title = "DuduHire | AI 驱动的人才价值匹配平台";
      metaDescription?.setAttribute("content", "DuduHire 用 AI 连接真实需求与真实能力，让证据、匹配理由与合作结果清晰可追踪。");
    } else if (isAdminPage) {
      document.title = "咨询管理 | DuduHire";
      metaDescription?.setAttribute("content", "DuduHire 企业咨询管理，仅限授权人员访问。");
    } else if (isWorkspacePage) {
      document.title = `${isWorkspaceProfile ? "个人信息" : "工作台"} | DuduHire`;
      metaDescription?.setAttribute("content", isWorkspaceProfile ? "管理 DuduHire 账户的个人资料与身份信息。" : "管理账户资料，查看问题发现或能力身份卡的完成状态。");
    } else if (isAuthVerify) {
      document.title = "验证邮箱 | DuduHire";
      metaDescription?.setAttribute("content", "验证邮箱并继续使用 DuduHire。");
    } else if (authMode) {
      document.title = `${authMode === "login" ? "登录" : "免费注册"} | DuduHire`;
      metaDescription?.setAttribute("content", authMode === "login" ? "登录 DuduHire，继续推进你的专业协作。" : "免费注册 DuduHire，从一个真实需求或一项真实能力开始。");
    } else if (secondaryRoute) {
      document.title = `${secondaryRouteTitles[secondaryRoute]} | DuduHire`;
      metaDescription?.setAttribute("content", secondaryRouteDescriptions[secondaryRoute]);
    } else {
      document.title = "页面未找到 | DuduHire";
      metaDescription?.setAttribute("content", "你访问的 DuduHire 页面不存在，请返回首页继续浏览。");
    }
  }, [authMode, isAdminPage, isAuthVerify, isHomePage, isWorkspacePage, isWorkspaceProfile, secondaryRoute]);

  const pageClass = isWorkspacePage ? "workspace-main" : secondaryRoute ? "secondary-main" : authMode || isAuthVerify ? "auth-main" : undefined;
  const showWorkspaceShell = isWorkspacePage || isAdminPage;
  const handleRoleSwitch = async () => {
    if (!session || roleSwitchInFlightRef.current) return;
    roleSwitchInFlightRef.current = true;
    setRoleSwitchBusy(true);
    setRoleSwitchError("");
    try {
      await switchAuthRole(session.role === "client" ? "talent" : "client");
      window.location.assign("/workspace");
    } catch (error) {
      setRoleSwitchError(error instanceof Error ? error.message : "身份切换失败，请重试。");
      roleSwitchInFlightRef.current = false;
      setRoleSwitchBusy(false);
    }
  };
  const roleSwitch: RoleSwitchProps = { role: session?.role ?? "client", switching: roleSwitchBusy, error: roleSwitchError, onSwitch: handleRoleSwitch };
  const handleLogout = async () => {
    if (roleSwitchInFlightRef.current) return;
    if (!(await clearAuthSession())) {
      window.alert("退出失败，请稍后重试。");
      return;
    }
    window.history.replaceState(null, "", "/");
    window.location.reload();
  };

  return (
    <>
      {!showWorkspaceShell && <Header theme={theme} onThemeToggle={() => setTheme((value) => (value === "light" ? "dark" : "light"))} session={session} onLogout={handleLogout} roleSwitch={roleSwitch} />}
      <main id="main" className={pageClass}>
        {roleContextStale && <div className="role-context-notice" role="alert"><p>使用身份已在其他页面切换，请刷新后继续。两个身份的已保存内容会分别保留。</p><button className="button button-secondary" type="button" onClick={() => window.location.reload()}>刷新使用身份</button></div>}
        {isAuthVerify ? (
          <AuthVerifyPage />
        ) : !authReady && (isProtectedPage || Boolean(authMode)) ? (
          <AuthStateLoading />
        ) : authLoadError && isProtectedPage && !session ? (
          <AuthStateError onRetry={() => { setAuthReady(false); setAuthLoadError(false); setAuthRetrySequence((value) => value + 1); }} />
        ) : isProtectedPage && !session ? (
          <AuthRedirect returnTo={currentPathWithSearchAndHash()} />
        ) : isPasswordSetup ? (
          <PasswordSetupPage />
        ) : isWrongDiscoveryRoute && roleSwitchBusy ? (
          <AuthStateLoading title="正在切换身份" />
        ) : isWrongDiscoveryRoute ? (
          <PageRedirect href={expectedDiscoveryRoute} title="正在前往当前身份的工作入口" body="可使用身份切换按钮进入另一身份，两个身份的已保存内容会分别保留。" />
        ) : isAdminPage ? (
          <Suspense fallback={<AuthStateLoading title="正在加载咨询管理" />}>
            <AdminInquiriesPage
              key={`admin:${sessionKey}`}
              session={session!}
              theme={theme}
              onThemeToggle={() => setTheme((value) => (value === "light" ? "dark" : "light"))}
              onLogout={handleLogout}
            />
          </Suspense>
        ) : isWorkspacePage ? (
          <WorkspacePage
            key={`workspace:${sessionKey}`}
            session={session!}
            theme={theme}
            onThemeToggle={() => setTheme((value) => (value === "light" ? "dark" : "light"))}
            onLogout={handleLogout}
            roleSwitch={roleSwitch}
          />
        ) : secondaryRoute ? (
          <SecondaryPage key={`secondary:${sessionKey}:${secondaryRoute}`} route={secondaryRoute} />
        ) : authMode ? (
          session ? <PageRedirect href={normalizeReturnTo(new URLSearchParams(window.location.search).get("returnTo"))} title="你已登录" body="正在继续之前的操作。" /> : <AuthPage mode={authMode} />
        ) : !isHomePage ? (
          <NotFoundPage />
        ) : (
          <>
            <Hero />
            <PlatformProof />
            <ValueSection />
            <HowItWorksSection />
            <PricingSection />
            <FinalCta />
          </>
        )}
      </main>
      {!showWorkspaceShell && <Footer />}
    </>
  );
}
