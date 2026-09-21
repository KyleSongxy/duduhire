import { useCallback, useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type ElementType, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowRight } from "@phosphor-icons/react/ArrowRight";
import { Briefcase } from "@phosphor-icons/react/Briefcase";
import { Buildings } from "@phosphor-icons/react/Buildings";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { ChatCircleText } from "@phosphor-icons/react/ChatCircleText";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";
import { CircleNotch } from "@phosphor-icons/react/CircleNotch";
import { ClipboardText } from "@phosphor-icons/react/ClipboardText";
import { ContactlessPayment } from "@phosphor-icons/react/ContactlessPayment";
import { Database } from "@phosphor-icons/react/Database";
import { FileMagnifyingGlass } from "@phosphor-icons/react/FileMagnifyingGlass";
import { FileText } from "@phosphor-icons/react/FileText";
import { Fingerprint } from "@phosphor-icons/react/Fingerprint";
import { FlowArrow } from "@phosphor-icons/react/FlowArrow";
import { Handshake } from "@phosphor-icons/react/Handshake";
import { Kanban } from "@phosphor-icons/react/Kanban";
import { List } from "@phosphor-icons/react/List";
import { Microphone } from "@phosphor-icons/react/Microphone";
import { Moon } from "@phosphor-icons/react/Moon";
import { Package } from "@phosphor-icons/react/Package";
import { Paperclip } from "@phosphor-icons/react/Paperclip";
import { PaperPlaneTilt } from "@phosphor-icons/react/PaperPlaneTilt";
import { Phone } from "@phosphor-icons/react/Phone";
import { ShieldCheck } from "@phosphor-icons/react/ShieldCheck";
import { SidebarSimple } from "@phosphor-icons/react/SidebarSimple";
import { SignOut } from "@phosphor-icons/react/SignOut";
import { StopCircle } from "@phosphor-icons/react/StopCircle";
import { Sun } from "@phosphor-icons/react/Sun";
import { Target } from "@phosphor-icons/react/Target";
import { UserFocus } from "@phosphor-icons/react/UserFocus";
import { UserCircle } from "@phosphor-icons/react/UserCircle";
import { UsersThree } from "@phosphor-icons/react/UsersThree";
import { House } from "@phosphor-icons/react/House";
import { WechatLogo } from "@phosphor-icons/react/WechatLogo";
import { X } from "@phosphor-icons/react/X";
import { CapabilityIdentityCard, type CapabilityIdentityProfile } from "./CapabilityIdentityCard";
import { MatchingPanel } from "./MatchingPanel";
import { ApiError, readApiAuthContextVersion } from "./api";
import { readPendingPhoneAuth, savePendingPhoneAuth, type PendingPhoneAuth } from "./pendingPhoneAuth";
import { buildAuthHref, checkLoginEligibility, completePhoneAuth, inferAuthRole, loadAuthMethods, loginWithPassword, normalizeReturnTo, readAuthSession, requestEmailAuth, requestPhoneAuth, type AuthRole, type AuthSession } from "./auth";
import { submitEnterpriseInquiry, type EnterpriseContactMethod, type EnterpriseInquirySource } from "./contactStore";
import {
  claimDiscoveryIntake,
  createRequestId,
  loadDiscovery,
  resetDiscovery,
  submitDiscoveryTurn,
  type CapabilityIdentityArtifact,
  type DiscoveryArtifact,
  type DiscoveryAttachmentInput,
  type DiscoveryState,
  type DiscoveryTurn,
  type DiscoveryVersion,
} from "./discoveryStore";
import { discoveryAnswerForDisplay, discoveryExamples, discoveryFlowHelper, discoveryMissingLabels, discoveryReviewFields, readDiscoveryComposerDraft, shouldFoldDiscoveryHistory, shouldShowCapabilityArtifact, writeDiscoveryComposerDraft, type DiscoveryComposerDraft, type DiscoveryFlow, type DiscoveryKind, type DiscoveryPendingSubmission } from "./discoveryFlow";
import { loadPersonalProfile, mergePersonalProfileEdits, readPersonalProfileDraft, savePersonalProfile, writePersonalProfileDraft } from "./profileStore";
import type { SecondaryRoute } from "./secondaryRoutes";
import { loadWorkspace, type PaymentAccountStatus } from "./workspaceStore";
import { RoleSwitcher, type RoleSwitchProps } from "./RoleSwitcher";

type Feature = {
  title: string;
  body: string;
};

type PageConfig = {
  label: string;
  title: [string, string];
  description: string;
  action: string;
  actionHref: string;
  image: string;
  imageAlt: string;
  supportImage: string;
  supportImageAlt: string;
  icon: ElementType;
  principles: [string, string, string];
  statement: string;
  statementBody: string;
  features: Feature[];
  flowTitle: string;
  flowBody: string;
  steps: [Feature, Feature, Feature];
  closingTitle: string;
  closingBody: string;
  closingAction: string;
  closingHref: string;
};

const pricingPage: PageConfig = {
  label: "定价",
  title: ["从一次协作开始，", "按实际需要扩展"],
  description: "个人与单次项目可免费开始，团队能力按需求配置。",
  action: "免费开始",
  actionHref: "/signup",
  image: "/images/duduhire-pricing-hero.webp",
  imageAlt: "专业人士在安静的工作空间中规划合作",
  supportImage: "/images/evidence-workspace.webp",
  supportImageAlt: "专业人士规划项目范围与协作投入",
  icon: FileMagnifyingGlass,
  principles: ["基础功能免费", "按需升级", "企业范围单独确认"],
  statement: "先验证价值，再为持续协作投入",
  statementBody: "基础能力保持清晰可用。团队版聚焦共同评审、协作治理与组织级结果追踪。",
  features: [
    { title: "基础版", body: "适合个人、需求探索与单次项目，可免费开始。" },
    { title: "团队版", body: "适合重复采购、多人评审与持续协作，按需配置。" },
    { title: "企业服务", body: "面向复杂权限、流程集成与治理要求，定制实施范围。" },
  ],
  flowTitle: "先免费开始，需要时再扩展",
  flowBody: "个人、团队和企业方案对应不同的协作规模与治理要求。",
  steps: [
    { title: "免费建立需求或档案", body: "使用结构化表达、能力浏览和匹配解释。" },
    { title: "按协作规模升级", body: "需要共享评审与项目治理时再启用团队能力。" },
    { title: "企业场景单独规划", body: "根据权限、集成、安全和服务范围确认方案。" },
  ],
  closingTitle: "先免费开始，验证完整的判断逻辑",
  closingBody: "当团队需要持续运行时，再选择更完整的协作能力。",
  closingAction: "了解企业服务",
  closingHref: "/enterprise",
};

function SecondaryHero({ page }: { page: PageConfig }) {
  const Icon = page.icon;
  return (
    <section className="secondary-hero">
      <div className="secondary-hero-copy">
        <p className="secondary-label"><Icon size={18} weight="duotone" />{page.label}</p>
        <h1><span>{page.title[0]}</span><span>{page.title[1]}</span></h1>
        <p>{page.description}</p>
        <a className="button button-primary button-large" href={page.actionHref}>{page.action}<ArrowRight size={19} weight="bold" /></a>
      </div>
      <figure className="secondary-hero-media">
        <img src={page.image} alt={page.imageAlt} fetchPriority="high" sizes="(max-width: 980px) 100vw, 48vw" />
      </figure>
    </section>
  );
}

function SecondaryPrinciples({ page }: { page: PageConfig }) {
  return (
    <section className="secondary-principles" aria-label="DuduHire 协作原则">
      <p>DuduHire 方法</p>
      <ul>
        {page.principles.map((principle) => (
          <li key={principle}><CheckCircle size={20} weight="fill" aria-hidden="true" />{principle}</li>
        ))}
      </ul>
    </section>
  );
}

function handleTabNavigation(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  currentIndex: number,
  count: number,
  selectTab: (index: number) => void,
) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  let nextIndex = currentIndex;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % count;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex + count - 1) % count;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = count - 1;
  else return;

  event.preventDefault();
  selectTab(nextIndex);
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
}

function SecondaryValue({ page }: { page: PageConfig }) {
  return (
    <section className="secondary-value">
      <figure className="secondary-value-media">
        <img src={page.supportImage} alt={page.supportImageAlt} loading="lazy" sizes="(max-width: 980px) 100vw, 44vw" />
      </figure>
      <div className="secondary-value-copy">
        <div className="secondary-value-lead">
        <h2>{page.statement}</h2>
        <p>{page.statementBody}</p>
        </div>
        <div className="secondary-feature-stack">
          {page.features.map((feature) => (
            <article key={feature.title}>
              <CheckCircle size={22} weight="duotone" aria-hidden="true" />
              <div><h3>{feature.title}</h3><p>{feature.body}</p></div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function SecondaryFlow({ page }: { page: PageConfig }) {
  const flowIcons = [FileMagnifyingGlass, Fingerprint, Target];
  return (
    <section className="secondary-flow">
      <div className="secondary-flow-heading">
        <h2>{page.flowTitle}</h2>
        <p>{page.flowBody}</p>
      </div>
      <ol>
        {page.steps.map((step, index) => {
          const FlowIcon = flowIcons[index];
          return (
            <li key={step.title}>
              <span><FlowIcon size={25} weight="duotone" aria-hidden="true" /></span>
              <div><h3>{step.title}</h3><p>{step.body}</p></div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

type DiscoveryAttachment = {
  id: string;
  file: File;
  textExcerpt: string;
};

type DiscoveryMode = "talent" | "projects";

const MAX_DISCOVERY_FILES = 5;
const MAX_DISCOVERY_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DISCOVERY_MESSAGE_CHARS = 12_000;
const DISCOVERY_FILE_ACCEPT = ".txt,.md,.csv,.json,.html,.xml";
const DISCOVERY_FILE_EXTENSIONS = new Set(DISCOVERY_FILE_ACCEPT.split(",").map((extension) => extension.slice(1)));

function getDiscoveryFileExtension(filename: string) {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function isDiscoveryFileSupported(file: File) {
  return DISCOVERY_FILE_EXTENSIONS.has(getDiscoveryFileExtension(file.name));
}

function formatDiscoveryFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type TalentSpeechRecognitionResult = {
  [index: number]: { transcript: string };
};

type TalentSpeechRecognitionEvent = Event & {
  results: {
    length: number;
    [index: number]: TalentSpeechRecognitionResult;
  };
};

type TalentSpeechRecognitionErrorEvent = Event & {
  error: string;
};

type TalentSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: TalentSpeechRecognitionEvent) => void) | null;
  onerror: ((event: TalentSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type TalentSpeechRecognitionConstructor = new () => TalentSpeechRecognition;

function getInitialDiscoveryEntry(mode: DiscoveryMode) {
  if (mode !== "talent") return { prompt: "", startsFresh: false, intakeId: "" };
  const searchParams = new URLSearchParams(window.location.search);
  const intakeId = searchParams.get("intake")?.trim() ?? "";
  if (/^[A-Za-z0-9_-]{16,128}$/u.test(intakeId)) return { prompt: "", startsFresh: true, intakeId };
  const categoryPrompts: Record<string, string> = {
    product: "我需要产品与技术方向的支持，希望先梳理问题和真正需要的能力。",
    design: "我需要设计与创意方向的支持，希望先梳理目标、受众和交付标准。",
    growth: "我需要市场与增长方向的支持，希望先梳理增长问题、约束和验证方式。",
    operations: "我需要运营与支持方向的帮助，希望先梳理流程卡点和预期结果。",
  };
  const category = searchParams.get("category");
  if (category && categoryPrompts[category]) return { prompt: categoryPrompts[category], startsFresh: true, intakeId: "" };
  return { prompt: "", startsFresh: false, intakeId: "" };
}

function clearDiscoveryEntryQuery() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("category") && !url.searchParams.has("intake")) return;
  url.searchParams.delete("category");
  url.searchParams.delete("intake");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function TalentLiquidCore({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  const resumeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    activeRef.current = active;
    if (active) resumeRef.current();
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    });
    if (!gl) return;

    const vertexSource = `
      attribute vec2 aPosition;

      void main() {
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `;

    const fragmentSource = `
      precision highp float;

      uniform vec2 uResolution;
      uniform float uTime;
      uniform vec2 uMouse;
      uniform float uMorph;
      uniform float uNoiseScale;
      uniform float uMouseAmount;
      uniform float uMetal;
      uniform float uCamera;
      uniform float uDark;

      #define MAX_STEPS 70
      #define MAX_DIST 20.0
      #define SURF_DIST 0.002

      vec3 mod289(vec3 value) {
        return value - floor(value * (1.0 / 289.0)) * 289.0;
      }

      vec4 mod289(vec4 value) {
        return value - floor(value * (1.0 / 289.0)) * 289.0;
      }

      vec4 permute(vec4 value) {
        return mod289(((value * 34.0) + 1.0) * value);
      }

      vec4 taylorInvSqrt(vec4 value) {
        return 1.79284291400159 - 0.85373472095314 * value;
      }

      float snoise(vec3 value) {
        const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
        const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
        vec3 cell = floor(value + dot(value, C.yyy));
        vec3 x0 = value - cell + dot(cell, C.xxx);
        vec3 gradient = step(x0.yzx, x0.xyz);
        vec3 inverseGradient = 1.0 - gradient;
        vec3 i1 = min(gradient.xyz, inverseGradient.zxy);
        vec3 i2 = max(gradient.xyz, inverseGradient.zxy);
        vec3 x1 = x0 - i1 + C.xxx;
        vec3 x2 = x0 - i2 + C.yyy;
        vec3 x3 = x0 - D.yyy;
        cell = mod289(cell);
        vec4 permutation = permute(
          permute(
            permute(cell.z + vec4(0.0, i1.z, i2.z, 1.0))
            + cell.y + vec4(0.0, i1.y, i2.y, 1.0)
          )
          + cell.x + vec4(0.0, i1.x, i2.x, 1.0)
        );
        float scale = 0.142857142857;
        vec3 ns = scale * D.wyz - D.xzx;
        vec4 points = permutation - 49.0 * floor(permutation * ns.z * ns.z);
        vec4 xGrid = floor(points * ns.z);
        vec4 yGrid = floor(points - 7.0 * xGrid);
        vec4 x = xGrid * ns.x + ns.yyyy;
        vec4 y = yGrid * ns.x + ns.yyyy;
        vec4 h = 1.0 - abs(x) - abs(y);
        vec4 b0 = vec4(x.xy, y.xy);
        vec4 b1 = vec4(x.zw, y.zw);
        vec4 s0 = floor(b0) * 2.0 + 1.0;
        vec4 s1 = floor(b1) * 2.0 + 1.0;
        vec4 sh = -step(h, vec4(0.0));
        vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
        vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
        vec3 p0 = vec3(a0.xy, h.x);
        vec3 p1 = vec3(a0.zw, h.y);
        vec3 p2 = vec3(a1.xy, h.z);
        vec3 p3 = vec3(a1.zw, h.w);
        vec4 normalization = taylorInvSqrt(
          vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3))
        );
        p0 *= normalization.x;
        p1 *= normalization.y;
        p2 *= normalization.z;
        p3 *= normalization.w;
        vec4 influence = max(
          0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)),
          0.0
        );
        influence *= influence;
        return 42.0 * dot(
          influence * influence,
          vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3))
        );
      }

      float liquidMap(vec3 point, float time) {
        float radius = 1.8 + sin(time * 0.22) * 0.032;
        float morph = snoise(point * (0.8 * uNoiseScale) + time * 0.1) * 0.25;
        morph += snoise(point * (1.5 * uNoiseScale) - time * 0.05 + 10.0) * 0.065;
        morph += snoise(point * (3.0 * uNoiseScale) + time * 0.02) * 0.012;
        return length(point) - radius + morph * uMorph;
      }

      vec3 calculateNormal(vec3 point, float time) {
        vec2 epsilon = vec2(0.002, 0.0);
        return normalize(vec3(
          liquidMap(point + epsilon.xyy, time) - liquidMap(point - epsilon.xyy, time),
          liquidMap(point + epsilon.yxy, time) - liquidMap(point - epsilon.yxy, time),
          liquidMap(point + epsilon.yyx, time) - liquidMap(point - epsilon.yyx, time)
        ));
      }

      vec3 studioEnvironment(vec3 direction, vec2 mouse) {
        vec3 color = mix(vec3(0.13, 0.145, 0.145), vec3(0.045, 0.055, 0.06), uDark);
        vec3 keyDirection = normalize(vec3(
          0.5 + mouse.x,
          1.0 + mouse.y * 0.5,
          1.2
        ));
        float key = pow(max(dot(direction, keyDirection), 0.0), 12.0);
        color += vec3(1.0, 0.99, 0.97) * key * 1.58;

        vec3 rimDirection = normalize(vec3(-0.8, -0.2, -1.0));
        float rim = pow(max(dot(direction, rimDirection), 0.0), 6.0);
        color += vec3(0.18, 0.78, 0.92) * rim * 0.9;

        vec3 fillDirection = normalize(vec3(-1.0, 0.5, 0.5));
        float fill = pow(max(dot(direction, fillDirection), 0.0), 3.0);
        color += vec3(0.94, 0.53, 0.29) * fill * 0.48;

        float panel = exp(-pow((direction.y - 0.2) * 4.0, 2.0))
          * smoothstep(-0.5, 0.5, direction.z);
        color += vec3(0.76, 0.88, 0.9) * panel * 0.46;
        float darkPanel = pow(
          max(1.0 - abs(direction.x * 1.25 + direction.y * 0.32), 0.0),
          18.0
        );
        color = mix(color, vec3(0.012, 0.026, 0.03), darkPanel * 0.62);
        return color;
      }

      void main() {
        vec2 uv = (gl_FragCoord.xy - uResolution * 0.5)
          / min(uResolution.x, uResolution.y);
        float time = uTime * 0.8;
        vec2 mouse = uMouse * uMouseAmount;

        vec3 rayOrigin = vec3(0.0, 0.0, uCamera);
        vec3 lookAt = vec3(mouse.x, mouse.y, 0.0);
        vec3 forward = normalize(lookAt - rayOrigin);
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
        vec3 up = cross(forward, right);
        vec3 rayDirection = normalize(forward + uv.x * right + uv.y * up);

        float travel = 0.0;
        for (int stepIndex = 0; stepIndex < MAX_STEPS; stepIndex++) {
          vec3 samplePoint = rayOrigin + rayDirection * travel;
          float distanceToSurface = liquidMap(samplePoint, time);
          travel += distanceToSurface;
          if (travel > MAX_DIST || abs(distanceToSurface) < SURF_DIST) break;
        }

        if (travel >= MAX_DIST) {
          gl_FragColor = vec4(0.0);
          return;
        }

        vec3 position = rayOrigin + rayDirection * travel;
        vec3 normal = calculateNormal(position, time);
        vec3 reflection = reflect(rayDirection, normal);
        float facing = max(dot(normal, -rayDirection), 0.0);
        float edge = pow(1.0 - facing, 2.05);
        float fresnel = 0.035 + 0.965 * pow(1.0 - facing, 5.0);

        vec3 reflectedColor = studioEnvironment(reflection, uMouse);
        vec3 redRefraction = refract(rayDirection, normal, 1.0 / 1.43);
        vec3 greenRefraction = refract(rayDirection, normal, 1.0 / 1.47);
        vec3 blueRefraction = refract(rayDirection, normal, 1.0 / 1.52);
        vec3 refractedColor = vec3(
          studioEnvironment(redRefraction, uMouse).r,
          studioEnvironment(greenRefraction, uMouse).g,
          studioEnvironment(blueRefraction, uMouse).b
        );

        float internalFlow = snoise(position * 1.35 - time * 0.12);
        float thickness = clamp(0.22 + edge * 0.58 + internalFlow * 0.09, 0.14, 0.92);
        vec3 absorption = exp(-vec3(0.32, 0.075, 0.13) * thickness);
        vec3 transmittedColor = refractedColor * absorption;
        transmittedColor += vec3(0.72, 0.9, 0.86) * (0.08 + thickness * 0.07);

        vec3 color = mix(transmittedColor, reflectedColor, clamp(fresnel * 1.18, 0.0, 1.0));
        vec3 lightPosition = normalize(vec3(0.5 + uMouse.x, 1.0, 1.0));
        float sharpSpecular = pow(max(dot(reflection, lightPosition), 0.0), 82.0);
        float broadSpecular = pow(max(dot(reflection, lightPosition), 0.0), 15.0);
        color += vec3(1.0) * sharpSpecular * 2.45 * uMetal;
        color += vec3(0.82, 0.94, 0.98) * broadSpecular * 0.34;

        float cyanEdge = edge * smoothstep(-0.72, 0.56, -normal.x + normal.y * 0.2);
        float amberEdge = edge * smoothstep(-0.62, 0.66, normal.x - normal.y * 0.54);
        color += vec3(0.03, 0.72, 1.0) * cyanEdge * 0.82;
        color += vec3(1.0, 0.37, 0.08) * amberEdge * 0.58;

        color = color / (color + 0.52);
        color = pow(color, vec3(1.0 / 2.2));
        color = mix(color, color * vec3(0.9, 1.02, 1.04), 0.26);
        float edgePolarity = smoothstep(-0.34, 0.46, normal.x - normal.y * 0.38);
        vec3 edgeTone = mix(vec3(0.018, 0.25, 0.32), vec3(0.34, 0.075, 0.025), edgePolarity);
        color = mix(color, edgeTone, edge * 0.48);
        color += vec3(1.0, 0.985, 0.96) * sharpSpecular * 0.34;

        float glassAlpha = clamp(
          0.18 + thickness * 0.1 + edge * 0.6 + sharpSpecular * 0.16,
          0.2,
          0.92
        );
        gl_FragColor = vec4(color * glassAlpha, glassAlpha);
      }
    `;

    const compileShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    if (!vertexShader || !fragmentShader) {
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      return;
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return;
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return;
    }

    const buffer = gl.createBuffer();
    if (!buffer) {
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return;
    }

    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const positionLocation = gl.getAttribLocation(program, "aPosition");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const uniforms = {
      resolution: gl.getUniformLocation(program, "uResolution"),
      time: gl.getUniformLocation(program, "uTime"),
      mouse: gl.getUniformLocation(program, "uMouse"),
      morph: gl.getUniformLocation(program, "uMorph"),
      noiseScale: gl.getUniformLocation(program, "uNoiseScale"),
      mouseAmount: gl.getUniformLocation(program, "uMouseAmount"),
      metal: gl.getUniformLocation(program, "uMetal"),
      camera: gl.getUniformLocation(program, "uCamera"),
      dark: gl.getUniformLocation(program, "uDark"),
    };

    let frameId = 0;
    let isRunning = false;
    let reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let targetMouseX = 0;
    let targetMouseY = 0;
    let mouseX = 0;
    let mouseY = 0;
    const startTime = performance.now();
    let previousFrameTime = startTime;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const density = Math.min(window.devicePixelRatio || 1, 1.5);
      const width = Math.max(1, Math.round(bounds.width * density));
      const height = Math.max(1, Math.round(bounds.height * density));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    };

    const updatePointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const bounds = canvas.getBoundingClientRect();
      targetMouseX = ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * 2 - 1;
      targetMouseY = -(((event.clientY - bounds.top) / Math.max(bounds.height, 1)) * 2 - 1);
    };

    const resetPointer = () => {
      targetMouseX = 0;
      targetMouseY = 0;
    };

    const render = (now: number) => {
      resize();
      const frameDelta = Math.min(Math.max(now - previousFrameTime, 0), 32);
      const pointerEase = 1 - Math.exp(-frameDelta / 190);
      previousFrameTime = now;
      mouseX += (targetMouseX - mouseX) * pointerEase;
      mouseY += (targetMouseY - mouseY) * pointerEase;
      if (reduceMotion) {
        mouseX = 0;
        mouseY = 0;
      }

      const dark = document.documentElement.dataset.theme === "dark";
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
      gl.uniform1f(uniforms.time, reduceMotion ? 1.6 : (now - startTime) * 0.00105);
      gl.uniform2f(uniforms.mouse, mouseX, mouseY);
      gl.uniform1f(uniforms.morph, 1.0);
      gl.uniform1f(uniforms.noiseScale, 0.7);
      gl.uniform1f(uniforms.mouseAmount, 0.17);
      gl.uniform1f(uniforms.metal, dark ? 0.98 : 0.9);
      gl.uniform1f(uniforms.camera, 5.5);
      gl.uniform1f(uniforms.dark, dark ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      canvas.dataset.ready = "true";
      canvas.parentElement?.setAttribute("data-rendered", "true");
    };

    const animate = (now: number) => {
      if (!activeRef.current || reduceMotion || document.hidden) {
        isRunning = false;
        return;
      }
      render(now);
      frameId = window.requestAnimationFrame(animate);
    };

    const start = () => {
      if (isRunning || reduceMotion || !activeRef.current || document.hidden) return;
      isRunning = true;
      frameId = window.requestAnimationFrame(animate);
    };
    resumeRef.current = start;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleMotionChange = () => {
      reduceMotion = motionQuery.matches;
      window.cancelAnimationFrame(frameId);
      isRunning = false;
      render(performance.now());
      start();
    };
    const handleVisibility = () => {
      if (document.hidden) {
        window.cancelAnimationFrame(frameId);
        isRunning = false;
        return;
      }
      render(performance.now());
      start();
    };
    const resizeObserver = new ResizeObserver(() => render(performance.now()));
    const themeObserver = new MutationObserver(() => render(performance.now()));
    resizeObserver.observe(canvas);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    canvas.addEventListener("pointermove", updatePointer, { passive: true });
    canvas.addEventListener("pointerleave", resetPointer);
    motionQuery.addEventListener("change", handleMotionChange);
    document.addEventListener("visibilitychange", handleVisibility);

    render(performance.now());
    start();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      canvas.removeEventListener("pointermove", updatePointer);
      canvas.removeEventListener("pointerleave", resetPointer);
      motionQuery.removeEventListener("change", handleMotionChange);
      document.removeEventListener("visibilitychange", handleVisibility);
      resumeRef.current = () => undefined;
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
    };
  }, []);

  return (
    <div
      className="talent-liquid-custom"
      role="img"
      aria-label="透明液态玻璃雕塑缓慢流动，内部带有青蓝与暖橙色散，并随指针方向产生轻微视角漂移"
    >
      <span className="talent-liquid-fallback" aria-hidden="true" />
      <canvas ref={canvasRef} className="talent-liquid-canvas" aria-hidden="true" />
    </div>
  );
}

function EnterpriseText({ text }: { text: string }) {
  return text.split(/(?<=[，、。；！？])/u).filter(Boolean).map((phrase, index) => (
    <span className="enterprise-v2-text-phrase" key={index}>{phrase}</span>
  ));
}

const enterpriseLifecycleStages = [
  {
    label: "诊断",
    icon: ClipboardText,
    eyebrow: "需求说明",
    title: "说清问题，确定目标",
    body: "从现在最费时、最影响业务的事情说起。AI 辅助整理现状、目标和限制，你可以随时补充或纠正。",
    details: ["业务现状与问题清单", "目标与效果判断标准", "首期范围与限制条件"],
    board: [
      {
        label: "业务现状",
        title: "能做演示，离交付还差几步",
        body: "一位创业者想把 AI 客服演示做成收费产品，还需补齐商家账号、资料管理、收款和日常维护。",
        points: [
          { label: "服务对象", text: "有重复商品咨询的小商家" },
          { label: "核心问题", text: "能回答问题，还不能稳定服务多家客户" },
          { label: "首期目标", text: "让首批商家完成试用、反馈与付费验证" },
        ],
      },
      { label: "首期范围", title: "先解决售前咨询", body: "先接商家网站咨询，回答商品与配送问题；订单查询和自动退款暂不纳入首期。" },
      { label: "创业者角色", title: "一人主导，按需协作", body: "OPC（一人公司）的创业者把握客户与产品方向，按需引入专业人员。" },
    ],
    handoff: "先说清为谁解决什么问题，再确定第一版做什么。",
  },
  {
    label: "蓝图",
    icon: FlowArrow,
    eyebrow: "实施方案",
    title: "拆清任务，排好计划",
    body: "把目标拆成具体工作，约定先做什么、每一步交付什么、如何验收，让预算和时间安排有依据。",
    details: ["工作范围与任务清单", "阶段计划与预算估算", "验收标准与准备事项"],
    board: [
      {
        label: "实施顺序",
        title: "先做可用版本，再接真实客户",
        body: "把试用到付费的过程拆开，先打通商家使用、客服回答和收款，再逐步增加功能。",
        points: [
          { label: "商家使用", text: "注册账号，上传本店商品与常见问答" },
          { label: "客服回答", text: "按商家资料回答，不确定时转商家客服" },
          { label: "付费使用", text: "用现成工具收款，确认后开通服务" },
        ],
      },
      { label: "首批试用", title: "先让 3 家商家试用", body: "约定试用范围，记录回答错误、操作卡点和付费意愿。" },
      { label: "预算安排", title: "开发费与运行费分开", body: "分别估算开发费用、AI 使用费用和人工维护时间，再确定首期预算。" },
    ],
    handoff: "先约定功能、预算与验收标准，再按任务安排人员。",
  },
  {
    label: "组队",
    icon: UsersThree,
    eyebrow: "团队建议",
    title: "按任务找人，分清职责",
    body: "根据任务确定需要哪些角色，再核对相关经验、参与时间和分工。团队方案需沟通确认，当前还不能在网站上组建项目团队。",
    details: ["所需角色与具体职责", "相关项目经验与作品", "参与时间与协作安排"],
    board: [
      {
        label: "协作分工",
        title: "一人把握方向，专业角色补位",
        body: "创业者负责客户、定价与验收；设计、开发、测试按阶段参与，不必一次招齐全职团队。",
        points: [
          { label: "产品与设计", text: "梳理商家使用流程，设计操作页面" },
          { label: "开发与 AI", text: "实现账号、客服回答、收费与用量记录" },
          { label: "测试与上线", text: "检查回答质量、资料访问与故障恢复" },
        ],
      },
      { label: "协作方式", title: "按阶段约定交付", body: "每项工作写清交付物、参与时间和费用，创业者统一做决定。" },
      { label: "交接要求", title: "源码与账号归属清楚", body: "约定源码和账号归属，交付部署、使用与维护说明。" },
    ],
    handoff: "明确分工、阶段费用与交接要求，再启动开发。",
  },
  {
    label: "交付",
    icon: Kanban,
    eyebrow: "交付计划与记录",
    title: "跟进进度，及时解决问题",
    body: "按约定的计划推进，定期说明完成了什么、卡在哪里、下一步做什么。涉及范围、费用或时间的变化，先由企业确认。",
    details: ["阶段成果与进度说明", "问题、风险与处理记录", "变更确认与验收清单"],
    board: [
      {
        label: "阶段检查",
        title: "从试用反馈，到首批付费",
        body: "先邀请商家使用真实商品资料试用，修复关键问题后，再开放付费并跟进运行情况。",
        points: [
          { label: "回答检查", text: "答案是否有依据，答不上时能否求助" },
          { label: "资料保护", text: "一家商家不能看到另一家的资料" },
          { label: "收费与恢复", text: "付费后能否使用，服务中断如何恢复" },
        ],
      },
      { label: "风险处理", title: "答错先纠正，异常能停用", body: "资料不足时转给商家客服，并告知接待时间；发现异常可暂停 AI 回答。" },
      { label: "上线支持", title: "上线之后也有人管", body: "约定故障联系人、资料更新方式与维护费用，让创业者能继续经营。" },
    ],
    handoff: "完成试用与收款检查，再开放付费并持续跟进。",
  },
  {
    label: "衡量",
    icon: Target,
    eyebrow: "项目结果报告",
    title: "对比结果，判断实际收益",
    body: "对照开始前的情况与约定目标，检查效果有没有改善、哪些问题仍未解决，再决定继续优化、扩大使用或暂停投入。",
    details: ["使用前后的效果对比", "交付成果与效果依据", "后续改进与维护建议"],
    board: [
      {
        label: "效果对比",
        title: "有人持续用，也有人愿意付费",
        body: "把试用、付费和使用成本放在一起看，判断产品是否值得继续投入，不把上线当成成功。",
        points: [
          { label: "实际使用", text: "商家是否持续使用，哪些问题仍需人工" },
          { label: "付费验证", text: "试用商家是否付费，到期是否续费" },
          { label: "收入与成本", text: "付费收入与 AI、服务器、维护支出" },
        ],
      },
      { label: "判断依据", title: "看使用，也看账单", body: "结合使用记录、付费账单和商家反馈；试用期较短时，不提前判断续费。" },
      { label: "下一步", title: "验证之后再扩展", body: "若商家愿付费但维护太费时，先改流程；持续使用且费用可控，再增加客户。" },
    ],
    handoff: "根据真实使用、付费与成本，决定继续优化、扩展或暂停。",
  },
];

const enterpriseServiceModes = [
  {
    icon: UserFocus,
    label: "专家增强",
    title: "补充一个关键专家",
    body: "已有内部团队和明确负责人，只缺某项关键能力。平台负责推荐、筛选、合同与支付。",
    meta: "适合 1-2 人",
    owner: "企业管理项目",
  },
  {
    icon: UsersThree,
    label: "定制团队",
    title: "组建一支完整项目团队",
    body: "项目目标已经明确，但需要多个角色共同完成。平台负责角色拆解、组队、启动与协作支持。",
    meta: "适合 3-8 人",
    owner: "企业与平台共同管理",
  },
  {
    icon: Package,
    label: "托管交付",
    title: "让平台负责完整交付",
    body: "只有业务目标，还缺少方案或交付能力。平台负责诊断、方案、团队、项目管理、质量与验收。",
    meta: "适合复杂跨职能项目",
    owner: "平台承担交付管理",
    featured: true,
  },
  {
    icon: Buildings,
    label: "长期弹性团队",
    title: "建立持续扩展的外部能力",
    body: "长期存在多个项目或产品方向，需要稳定核心团队与按阶段加入的专家，按月或年度合作。",
    meta: "适合长期、多项目需求",
    owner: "建立可复用团队",
  },
];

const enterpriseValueSteps = [
  { icon: ChatCircleText, title: "形成需求说明", body: "梳理业务目标、现状、约束与成功标准。" },
  { icon: ClipboardText, title: "整理实施方案", body: "明确项目范围、工作包、里程碑与验收方式。" },
  { icon: FlowArrow, title: "确定合作模式", body: "选择专家增强、定制团队或托管交付。" },
  { icon: UsersThree, title: "配置专业团队", body: "按阶段安排负责人、领域专家与实施角色。" },
  { icon: Database, title: "管理交付过程", body: "透明跟踪进度、风险、变更与企业决策。" },
  { icon: Target, title: "验证业务结果", body: "对照成功指标验收，并沉淀可复用成果。" },
];

function EnterpriseProcessList({ side }: { side: "left" | "right" }) {
  const offset = side === "left" ? 0 : 3;
  return (
    <ol className={`talent-process-list talent-process-list-${side}`} start={side === "right" ? 4 : undefined}>
      {enterpriseValueSteps.slice(offset, offset + 3).map((step, index) => {
        const StepIcon = step.icon;
        return (
          <li key={step.title} style={{ "--talent-step": index + offset } as CSSProperties}>
            <span aria-hidden="true"><StepIcon size={22} weight="duotone" /></span>
            <div><h3>{step.title}</h3><p>{step.body}</p></div>
          </li>
        );
      })}
    </ol>
  );
}

function validateEnterpriseContact(method: EnterpriseContactMethod, value: string) {
  const trimmedValue = value.trim();
  if (!trimmedValue) return method === "phone" ? "请填写手机号" : "请填写微信号";

  if (method === "phone") {
    const digits = trimmedValue.replace(/\D/g, "");
    if (!/^[+\d][\d\s()-]*$/.test(trimmedValue) || digits.length < 6 || digits.length > 15) {
      return "请输入有效的手机号，可包含国家或地区代码";
    }
    return "";
  }

  if (/\s/.test(trimmedValue) || trimmedValue.length < 2 || trimmedValue.length > 32) {
    return "请输入 2–32 个字符且不含空格的微信号";
  }
  return "";
}

export function EnterpriseContactDialog({
  open,
  onClose,
  source,
}: {
  open: boolean;
  onClose: () => void;
  source: EnterpriseInquirySource;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contactInputRef = useRef<HTMLInputElement>(null);
  const submissionSequenceRef = useRef(0);
  const submissionInFlightRef = useRef<number | null>(null);
  const retryInquiryRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const [method, setMethod] = useState<EnterpriseContactMethod>("phone");
  const [contactValue, setContactValue] = useState("");
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    if (open && !dialog.open) {
      const previousOverflow = document.body.style.overflow;
      const closeOnEscape = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          dialog.close();
        }
      };
      document.body.style.overflow = "hidden";
      window.addEventListener("keydown", closeOnEscape);
      dialog.showModal();
      const frameId = window.requestAnimationFrame(() => contactInputRef.current?.focus());
      return () => {
        window.cancelAnimationFrame(frameId);
        window.removeEventListener("keydown", closeOnEscape);
        document.body.style.overflow = previousOverflow;
      };
    }

    if (!open && dialog.open) dialog.close();
    return undefined;
  }, [open]);

  const resetDialog = () => {
    submissionSequenceRef.current += 1;
    submissionInFlightRef.current = null;
    retryInquiryRef.current = null;
    setMethod("phone");
    setContactValue("");
    setError("");
    setSubmitted(false);
    setIsSubmitting(false);
    onClose();
  };

  const closeDialog = () => {
    if (dialogRef.current?.open) dialogRef.current.close();
    else resetDialog();
  };

  const chooseMethod = (nextMethod: EnterpriseContactMethod) => {
    if (isSubmitting) return;
    setMethod(nextMethod);
    setContactValue("");
    setError("");
    setSubmitted(false);
    window.requestAnimationFrame(() => contactInputRef.current?.focus());
  };

  const submitContact = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submissionInFlightRef.current !== null) return;
    const nextError = validateEnterpriseContact(method, contactValue);
    setError(nextError);
    if (nextError) {
      contactInputRef.current?.focus();
      return;
    }
    const sequence = submissionSequenceRef.current + 1;
    const fingerprint = JSON.stringify([method, contactValue.trim(), source]);
    const requestId = retryInquiryRef.current?.fingerprint === fingerprint
      ? retryInquiryRef.current.requestId
      : window.crypto.randomUUID();
    retryInquiryRef.current = { fingerprint, requestId };
    submissionSequenceRef.current = sequence;
    submissionInFlightRef.current = sequence;
    setIsSubmitting(true);
    try {
      const response = await submitEnterpriseInquiry({ requestId, method, contactValue, source });
      if (submissionSequenceRef.current !== sequence) return;
      if (!response.accepted) throw new Error("提交失败，请稍后重试。");
      retryInquiryRef.current = null;
      setSubmitted(true);
    } catch (submitError) {
      if (submissionSequenceRef.current === sequence) {
        setError(submitError instanceof Error ? submitError.message : "提交失败，请稍后重试。");
      }
    } finally {
      if (submissionInFlightRef.current === sequence) submissionInFlightRef.current = null;
      if (submissionSequenceRef.current === sequence) setIsSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="enterprise-contact-dialog"
      aria-labelledby="enterprise-contact-title"
      aria-describedby="enterprise-contact-description"
      onClose={resetDialog}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div className="enterprise-contact-card">
        <button className="enterprise-contact-close" type="button" onClick={closeDialog} aria-label="关闭联系方式表单">
          <X size={20} weight="bold" aria-hidden="true" />
        </button>

        {submitted ? (
          <div className="enterprise-contact-success" role="status">
            <span aria-hidden="true"><CheckCircle size={34} weight="fill" /></span>
            <p>联系方式填写完成</p>
            <h2 id="enterprise-contact-title">信息已确认</h2>
            <span id="enterprise-contact-description">你选择了{method === "phone" ? "电话" : "微信"}作为后续沟通方式。</span>
            <button type="button" onClick={closeDialog}>完成</button>
          </div>
        ) : (
          <form className="enterprise-contact-form" onSubmit={submitContact} noValidate>
            <header>
              <span>BUSINESS CONTACT</span>
              <h2 id="enterprise-contact-title">留下联系方式</h2>
              <p id="enterprise-contact-description">选择手机号或微信号，便于后续进一步梳理业务挑战。</p>
            </header>

            <fieldset>
              <legend>选择联系方式</legend>
              <div className="enterprise-contact-methods">
                <label data-selected={method === "phone"}>
                  <input type="radio" name="contact-method" value="phone" checked={method === "phone"} onChange={() => chooseMethod("phone")} />
                  <Phone size={21} weight={method === "phone" ? "fill" : "regular"} aria-hidden="true" />
                  <span><strong>手机号</strong><small>电话或短信联系</small></span>
                </label>
                <label data-selected={method === "wechat"}>
                  <input type="radio" name="contact-method" value="wechat" checked={method === "wechat"} onChange={() => chooseMethod("wechat")} />
                  <WechatLogo size={22} weight={method === "wechat" ? "fill" : "regular"} aria-hidden="true" />
                  <span><strong>微信号</strong><small>通过微信联系</small></span>
                </label>
              </div>
            </fieldset>

            <div className="enterprise-contact-field">
              <label htmlFor="enterprise-contact-value">{method === "phone" ? "手机号" : "微信号"}</label>
              <input
                ref={contactInputRef}
                id="enterprise-contact-value"
                type={method === "phone" ? "tel" : "text"}
                inputMode={method === "phone" ? "tel" : "text"}
                autoComplete={method === "phone" ? "tel" : "off"}
                value={contactValue}
                maxLength={32}
                placeholder={method === "phone" ? "例如：138 0000 0000" : "请输入你的微信号"}
                required
                aria-required="true"
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "enterprise-contact-error enterprise-contact-helper" : "enterprise-contact-helper"}
                onChange={(event) => {
                  setContactValue(event.target.value);
                  if (error) setError("");
                }}
                onBlur={() => {
                  if (contactValue.trim()) setError(validateEnterpriseContact(method, contactValue));
                }}
              />
              {error && <span id="enterprise-contact-error" className="enterprise-contact-error" role="alert">{error}</span>}
              <small id="enterprise-contact-helper">我们仅使用这一项联系方式，不需要同时填写。</small>
            </div>

            <p className="enterprise-contact-privacy"><ShieldCheck size={18} weight="fill" aria-hidden="true" />仅用于本次业务沟通，不会在平台公开展示。</p>
            <button className="enterprise-contact-submit" type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>{isSubmitting ? "正在提交…" : "确认留下"}{!isSubmitting && <ArrowRight size={18} weight="bold" aria-hidden="true" />}</button>
          </form>
        )}
      </div>
    </dialog>
  );
}

function EnterpriseClientPage() {
  const [activeStage, setActiveStage] = useState(0);
  const [contactOpen, setContactOpen] = useState(false);
  const [processVisible, setProcessVisible] = useState(false);
  const processRef = useRef<HTMLElement>(null);
  const currentStage = enterpriseLifecycleStages[activeStage];
  const StageIcon = currentStage.icon;

  useEffect(() => {
    const section = processRef.current;
    if (!section || typeof IntersectionObserver === "undefined") {
      setProcessVisible(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setProcessVisible(entry.isIntersecting),
      { threshold: 0.18 },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="enterprise-v2-page">
      <section
        ref={processRef}
        className="talent-process enterprise-v2-process-hero"
        data-visible={processVisible}
        aria-labelledby="enterprise-v2-hero-title"
      >
        <header className="talent-process-heading">
          <span>企业问题解决与项目交付</span>
          <h1 id="enterprise-v2-hero-title">
            <span>从复杂业务挑战出发，</span>
            <span>形成方案、组织团队、管理交付。</span>
          </h1>
          <p>DuduHire 先把问题说清，再设计解决方案与合作方式，按阶段配置团队并持续验证业务结果。</p>
        </header>
        <div className="talent-process-stage">
          <EnterpriseProcessList side="left" />
          <figure className="talent-process-core">
            <span className="talent-core-halo" aria-hidden="true" />
            <TalentLiquidCore active={processVisible} />
            <figcaption><small>从问题到成果</small><strong>全程交付管理</strong></figcaption>
          </figure>
          <EnterpriseProcessList side="right" />
        </div>
      </section>

      <section className="enterprise-v2-models" aria-labelledby="enterprise-v2-models-title">
        <header>
          <h2 id="enterprise-v2-models-title">
            <span>成熟的解决方案，</span>
            <span>适配不同复杂度的企业问题</span>
          </h2>
          <p>按项目清晰度、团队规模和交付责任选择合作方式。</p>
        </header>
        <div className="enterprise-v2-model-grid">
          {enterpriseServiceModes.map((mode) => {
            const ModeIcon = mode.icon;
            return (
              <article key={mode.label} className={mode.featured ? "is-featured" : undefined}>
                <div className="enterprise-v2-model-heading"><ModeIcon size={26} weight="duotone" /><span>{mode.label}</span></div>
                <h3>{mode.title}</h3>
                <p>{mode.body}</p>
                <dl><div><dt>适用范围</dt><dd>{mode.meta}</dd></div><div><dt>管理方式</dt><dd>{mode.owner}</dd></div></dl>
              </article>
            );
          })}
        </div>
      </section>

      <section className="enterprise-v2-lifecycle" aria-labelledby="enterprise-v2-lifecycle-title">
        <header>
          <h2 id="enterprise-v2-lifecycle-title">每一步，都知道要做什么</h2>
          <p>查看五个阶段的工作重点与交付内容。</p>
        </header>

        <div className="enterprise-v2-lifecycle-tabs" role="tablist" aria-label="企业项目交付流程">
          {enterpriseLifecycleStages.map((stage, index) => (
            <button
              key={stage.label}
              type="button"
              role="tab"
              id={`enterprise-v2-lifecycle-tab-${index}`}
              aria-selected={activeStage === index}
              aria-controls="enterprise-v2-lifecycle-panel"
              tabIndex={activeStage === index ? 0 : -1}
              onClick={() => setActiveStage(index)}
              onKeyDown={(event) => handleTabNavigation(event, index, enterpriseLifecycleStages.length, setActiveStage)}
            >
              <stage.icon size={19} weight={activeStage === index ? "fill" : "regular"} aria-hidden="true" />
              {stage.label}
            </button>
          ))}
        </div>

        <div className="enterprise-v2-lifecycle-panel" id="enterprise-v2-lifecycle-panel" role="tabpanel" aria-labelledby={`enterprise-v2-lifecycle-tab-${activeStage}`} tabIndex={0} key={currentStage.label}>
          <div className="enterprise-v2-lifecycle-copy">
            <span><StageIcon size={20} weight="duotone" aria-hidden="true" />{currentStage.eyebrow}</span>
            <h3>{currentStage.title}</h3>
            <p><EnterpriseText text={currentStage.body} /></p>
            <div className="enterprise-v2-stage-deliverables">
              <h4>本阶段交付</h4>
              <ul>{currentStage.details.map((detail) => <li key={detail}><CheckCircle size={18} weight="fill" aria-hidden="true" />{detail}</li>)}</ul>
            </div>
          </div>
          <div className="enterprise-v2-stage-output" aria-label={`${currentStage.label}阶段交付示例`}>
            <header>
              <div><span>示例项目</span><strong>OPC AI 客服产品落地</strong></div>
              <span className="enterprise-v2-stage-output-type">{currentStage.eyebrow}</span>
            </header>
            <div className="enterprise-v2-stage-output-grid">
              {currentStage.board.map((item) => (
                <article key={item.title}>
                  <small>{item.label}</small>
                  <h4>{item.title.match(/[^，]+，?/gu)?.map((phrase) => <span key={phrase}>{phrase}</span>)}</h4>
                  <p><EnterpriseText text={item.body} /></p>
                  {item.points && <dl>{item.points.map((point) => <div key={point.label}><dt>{point.label}</dt><dd><EnterpriseText text={point.text} /></dd></div>)}</dl>}
                </article>
              ))}
            </div>
            <footer><ArrowRight size={16} weight="bold" aria-hidden="true" /><p><EnterpriseText text={currentStage.handoff} /></p></footer>
          </div>
        </div>
      </section>

      <section className="enterprise-v2-governance" aria-labelledby="enterprise-v2-governance-title">
        <header>
          <h2 id="enterprise-v2-governance-title">清晰的项目责任与交付治理机制</h2>
          <p>AI 提升效率，企业、DuduHire 与项目团队分别对决策、管理和执行负责。</p>
        </header>
        <div className="enterprise-v2-governance-grid">
          <article><span>企业负责</span><h3>业务信息、资源与决策</h3><p>指定 Sponsor 和 Product Owner，提供数据、系统访问与业务反馈，按约定完成决策和验收。</p></article>
          <article className="is-primary"><span>DuduHire 负责</span><h3>方案、团队与交付管理</h3><p>完成问题诊断、团队组建、合同、里程碑、风险、质量、人员替换和结果报告。</p></article>
          <article><span>项目团队负责</span><h3>按职责完成工作与知识转移</h3><p>遵守安全规范，输出交付物，及时汇报风险，配合验收、修复和培训。</p></article>
        </div>
        <ul className="enterprise-v2-trust-list">
          <li><ShieldCheck size={20} weight="duotone" /><span><strong>数据与权限</strong>按角色控制访问范围，支持企业现有安全要求。</span></li>
          <li><Handshake size={20} weight="duotone" /><span><strong>合同与知识产权</strong>明确保密、成果归属、变更与退出机制。</span></li>
          <li><CheckCircle size={20} weight="duotone" /><span><strong>质量与验收</strong>每个里程碑都有交付物、标准和确认记录。</span></li>
        </ul>
      </section>

      <section className="enterprise-v2-closing" aria-labelledby="enterprise-v2-closing-title">
        <div>
          <h2 id="enterprise-v2-closing-title">不需要定义要找谁，从描述问题开始</h2>
          <p>用几分钟描述你的业务挑战，DuduHire 将梳理目标、现状与约束，形成清晰的需求说明，并判断最适合补充专家、组建团队，还是由 DuduHire 负责完整交付。</p>
        </div>
        <button className="enterprise-v2-contact-trigger" type="button" onClick={() => setContactOpen(true)}>
          与我们的专家联系<ArrowRight size={19} weight="bold" aria-hidden="true" />
        </button>
      </section>
      <EnterpriseContactDialog open={contactOpen} onClose={() => setContactOpen(false)} source="enterprise_page" />
    </div>
  );
}

function ParsedCapabilityProfile({ analysis }: { analysis: CapabilityIdentityArtifact }) {
  const isConfirmed = analysis.flow?.status === "confirmed";
  const profile: CapabilityIdentityProfile = {
    id: analysis.id || "my-capability",
    name: "用户",
    title: analysis.capabilityIdentity,
    location: "线上",
    initials: "ME",
    statusLabel: isConfirmed ? "用户已确认" : "AI 草稿",
    footerLabel: "VALUE PROFILE",
    footerValue: isConfirmed ? "CONFIRMED" : "DRAFT",
  };

  return (
    <section className="talent-parsed-profile" aria-labelledby="talent-parsed-profile-title">
      <CapabilityIdentityCard profile={profile} />
      <div className="talent-parsed-capabilities">
        <header>
          <span className="panel-label">能力身份卡 · {isConfirmed ? "已确认保存" : "草稿"}</span>
          <h2 id="talent-parsed-profile-title">你的核心价值，开始清晰了</h2>
          <p>{analysis.coreValue}</p>
        </header>
        <div className="capability-tags">
          {analysis.evidence.map((item) => <span key={item}>{item}</span>)}
        </div>
        <div className="capability-strength talent-evidence-status" aria-label="能力证据状态">
          {analysis.evidence.map((item) => (
            <div key={item}><span>{item}</span><strong>{isConfirmed ? "用户已确认 · 未经平台验证" : "AI 初步提炼 · 待确认"}</strong></div>
          ))}
        </div>
        <dl className="talent-capability-details">
          <div><dt>核心价值</dt><dd>{analysis.coreValue}</dd></div>
          <div><dt>能力定位</dt><dd>{analysis.capabilityIdentity}</dd></div>
          <div><dt>证据状态</dt><dd>{isConfirmed ? "你已确认当前表述。经历与材料未经平台独立验证，不代表能力认证。" : "当前内容由 AI 从对话和所提供材料中整理，尚未确认，也未经平台验证。"}</dd></div>
          <div><dt>下一步</dt><dd>{isConfirmed ? "需要调整时，直接在对话中补充或输入“继续完善”。" : analysis.nextStep}</dd></div>
        </dl>
      </div>
    </section>
  );
}

function DiscoveryDraftReview({ kind, flow, disabled, onEdit }: { kind: DiscoveryKind; flow: DiscoveryFlow; disabled: boolean; onEdit: (label: string, value: string) => void }) {
  const fields = discoveryReviewFields(kind, flow);
  const missing = discoveryMissingLabels(kind, flow);
  if (!fields.length) return null;
  const renderField = (field: typeof fields[number]) => <div key={field.key}>
    <dt>{field.label}<small>{field.statusLabel}</small></dt>
    <dd><p>{field.value}</p><button type="button" disabled={disabled} onClick={() => onEdit(field.label, field.value)} aria-label={`修改${field.label}`}>修改</button></dd>
  </div>;
  return <section className="talent-discovery-review" aria-label={kind === "problem" ? "用人需求草稿" : "能力档案草稿"}>
    <header><h2>{flow.status === "confirmed" ? "已确认的" : "已整理的"}{kind === "problem" ? "用人需求" : "能力档案"}</h2><span>{flow.status === "confirmed" ? "本人确认 · 未经平台验证" : "可随时修改"}</span></header>
    <dl className="talent-capability-details">{fields.slice(0, 3).map(renderField)}</dl>
    {fields.length > 3 && <details><summary>查看其余 {fields.length - 3} 项信息</summary><dl className="talent-capability-details">{fields.slice(3).map(renderField)}</dl></details>}
    {missing.length > 0 && <p className="talent-discovery-review__missing">待补充：{missing.join("、")}。可以继续描述，不必逐项填表。</p>}
    {fields.some((field) => field.evidence.length > 0) && <details><summary>查看提炼依据</summary><ul className="talent-discovery-review__evidence">{fields.filter((field) => field.evidence.length > 0).map((field) => <li key={field.key}><strong>{field.label}</strong>{field.evidence.map((entry, index) => <blockquote key={`${entry.sourceId}:${index}`}>{entry.quote}</blockquote>)}</li>)}</ul><p>引用来自你的对话或文本资料，表示提炼来源，不代表经历已获验证。</p></details>}
  </section>;
}

function DiscoveryClientPage({ mode }: { mode: DiscoveryMode }) {
  const [identityContextVersion] = useState(readApiAuthContextVersion);
  const isValueDiscovery = mode === "projects";
  const discoveryKind = isValueDiscovery ? "capability" : "problem";
  const copy = isValueDiscovery
    ? {
        title: "发现你的核心价值",
        description: "粘贴简历、项目经历或作品说明，AI 帮你整理能力与依据，只补充还不清楚的部分。",
        advisor: "AI 价值顾问",
        inputLabel: "讲述一段真实经历",
        placeholder: "粘贴一段经历，或说说你做过什么、负责什么、结果如何",
        helper: "不用先整理格式。可以一次说明个人职责、行动、结果和合作偏好，之后随时修改。",
        emptyError: "请先讲述一段真实经历，或上传相关材料。",
        loadingLabel: "AI 正在提炼核心价值",
      }
    : {
        title: "想解决什么问题？",
        description: "直接描述业务问题，或粘贴已有需求，AI 帮你整理工作目标、所需能力与合作条件。",
        advisor: "AI 人才顾问",
        inputLabel: "描述你想解决的问题",
        placeholder: "想完成什么工作？已有的需求、时间和条件都可以一起说",
        helper: "不用先确定岗位名称。一次说出已知情况，AI 会整理并补问关键缺口。",
        emptyError: "请先描述一个想解决的问题。",
        loadingLabel: "AI 正在分析问题",
      };
  const AdvisorIcon = isValueDiscovery ? Briefcase : UserFocus;
  const titleId = `${mode}-chat-title`;
  const promptId = `${mode}-chat-prompt`;
  const errorId = `${mode}-chat-error`;
  const storageErrorId = `${mode}-chat-storage-error`;
  const helpId = `${mode}-chat-help`;
  const [initialEntry] = useState(() => getInitialDiscoveryEntry(mode));
  const [composerStorageKey] = useState(() => {
    const session = readAuthSession();
    return session ? `duduhire-discovery-composer:${session.id}:${session.signedInAt}:${mode}` : "";
  });
  const [recoveredDraft] = useState(() => {
    if (!composerStorageKey || initialEntry.startsFresh) return null;
    try { return readDiscoveryComposerDraft(window.sessionStorage, composerStorageKey); } catch { return null; }
  });
  const [prompt, setPrompt] = useState(initialEntry.prompt || recoveredDraft?.prompt || "");
  const [exampleNotice, setExampleNotice] = useState("");
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [slowReply, setSlowReply] = useState(false);
  const [pendingAttachmentNames, setPendingAttachmentNames] = useState<string[]>([]);
  const [conversation, setConversation] = useState<DiscoveryTurn[]>([]);
  const [artifact, setArtifact] = useState<DiscoveryArtifact | null>(null);
  const [startsFresh, setStartsFresh] = useState(initialEntry.startsFresh || recoveredDraft?.startsFresh || false);
  const [attachments, setAttachments] = useState<DiscoveryAttachment[]>([]);
  const [inputError, setInputError] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [isReadingFiles, setIsReadingFiles] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [isLoadingDiscovery, setIsLoadingDiscovery] = useState(true);
  const [isClaimingIntake, setIsClaimingIntake] = useState(Boolean(initialEntry.intakeId));
  const [isResettingDiscovery, setIsResettingDiscovery] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<TalentSpeechRecognition | null>(null);
  const resetInFlightRef = useRef(false);
  const turnInFlightRef = useRef(false);
  const retryDiscoveryTurnRef = useRef<(DiscoveryPendingSubmission & { fingerprint: string }) | null>(
    recoveredDraft?.pending && !recoveredDraft.attachmentCount
      ? { ...recoveredDraft.pending, fingerprint: JSON.stringify([recoveredDraft.prompt.trim(), []]) } : null,
  );
  const discoveryVersionRef = useRef<DiscoveryVersion | null>(null);
  const discoveryMutationRevisionRef = useRef(0);
  const speechBasePromptRef = useRef("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const latestTurnRef = useRef<HTMLDivElement | null>(null);
  const fileReadInFlightRef = useRef(false);
  const fileDragDepthRef = useRef(0);
  const visibleConversation = startsFresh ? [] : conversation;
  const hasConversation = visibleConversation.length > 0 || Boolean(pendingPrompt);
  const parsedCapability = isValueDiscovery && !startsFresh && shouldShowCapabilityArtifact(artifact) ? artifact : null;
  const flow = startsFresh ? undefined : artifact?.flow;
  const flowHelper = discoveryFlowHelper(flow, copy.helper);
  const composerBusy = Boolean(pendingPrompt) || isReadingFiles || isLoadingDiscovery || isClaimingIntake || isResettingDiscovery;
  const quickActionDisabled = composerBusy || Boolean(prompt.trim()) || attachments.length > 0;
  const acceptDiscoveryState = useCallback((state: DiscoveryState) => {
    // An older component may resume an async reset/send after another tab changed identity.
    // Stop before its next mutation can reuse an empty thread under the new identity.
    if (identityContextVersion !== readApiAuthContextVersion()) {
      throw new ApiError("使用身份已更改，输入已保留；切回原身份后可继续。", 409, "ACTIVE_ROLE_CHANGED");
    }
    discoveryVersionRef.current = { threadId: state.threadId, version: state.version };
    setConversation(state.turns);
    setArtifact(state.artifact);
  }, [identityContextVersion]);
  const persistComposer = useCallback((draft: DiscoveryComposerDraft) => {
    if (!composerStorageKey) return;
    try { writeDiscoveryComposerDraft(window.sessionStorage, composerStorageKey, draft); } catch { /* Private browser storage may be unavailable. */ }
  }, [composerStorageKey]);

  useEffect(() => {
    if (!pendingPrompt && visibleConversation.length > 0) {
      latestTurnRef.current?.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  }, [pendingPrompt, visibleConversation.length]);

  useEffect(() => {
    if (!pendingPrompt) return;
    const timer = window.setTimeout(() => setSlowReply(true), 8_000);
    return () => window.clearTimeout(timer);
  }, [pendingPrompt]);

  useEffect(() => {
    const retry = retryDiscoveryTurnRef.current;
    persistComposer({
      prompt,
      startsFresh,
      attachmentCount: attachments.length,
      pending: retry && retry.fingerprint === JSON.stringify([prompt.trim(), []])
        ? { requestId: retry.requestId, threadId: retry.threadId, version: retry.version } : null,
    });
  }, [attachments.length, persistComposer, prompt, startsFresh]);

  useEffect(() => {
    let active = true;
    const initialRevision = discoveryMutationRevisionRef.current;
    void loadDiscovery()
      .then((state) => {
        if (!active || discoveryMutationRevisionRef.current !== initialRevision) return;
        acceptDiscoveryState(state);
        const recoveredSubmission = recoveredDraft?.pending;
        const alreadySaved = recoveredSubmission && state.turns.some((turn) => turn.requestId === recoveredSubmission.requestId);
        if (alreadySaved) {
          setPrompt((value) => value === recoveredDraft.prompt ? "" : value);
          retryDiscoveryTurnRef.current = null;
          setStorageError("");
        } else if (recoveredDraft?.attachmentCount) {
          setStorageError("已恢复未发送的文字。附件不会保存在浏览器中，请重新添加后发送。");
        } else {
          setStorageError("");
        }
      })
      .catch((error) => {
        if (active && discoveryMutationRevisionRef.current === initialRevision) {
          setStorageError(error instanceof Error ? error.message : "对话加载失败，请刷新页面重试。");
        }
      })
      .finally(() => { if (active) setIsLoadingDiscovery(false); });

    if (initialEntry.intakeId) {
      void claimDiscoveryIntake(initialEntry.intakeId)
        .then((claimedPrompt) => {
          if (!active) return;
          setPrompt((value) => value.trim() ? value : claimedPrompt.slice(0, MAX_DISCOVERY_MESSAGE_CHARS));
          setStartsFresh(true);
        })
        .catch((error) => {
          if (!active) return;
          setStartsFresh(false);
          clearDiscoveryEntryQuery();
          setInputError(error instanceof Error ? error.message : "首页内容读取失败，请重新输入。");
        })
        .finally(() => { if (active) setIsClaimingIntake(false); });
    }
    return () => {
      active = false;
    };
  }, [acceptDiscoveryState, initialEntry, persistComposer, recoveredDraft]);

  useEffect(() => {
    const speechWindow = window as Window & {
      SpeechRecognition?: TalentSpeechRecognitionConstructor;
      webkitSpeechRecognition?: TalentSpeechRecognitionConstructor;
    };
    const SpeechRecognitionApi = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognitionApi) return;

    let recognition: TalentSpeechRecognition;
    try {
      recognition = new SpeechRecognitionApi();
    } catch {
      setVoiceError("语音输入初始化失败，请改用键盘输入。");
      return;
    }
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let transcript = "";
      for (let index = 0; index < event.results.length; index += 1) {
        transcript += event.results[index][0]?.transcript ?? "";
      }
      const basePrompt = speechBasePromptRef.current;
      setPrompt(`${basePrompt}${basePrompt && transcript ? " " : ""}${transcript}`.slice(0, MAX_DISCOVERY_MESSAGE_CHARS));
      setInputError("");
      setVoiceError("");
    };
    recognition.onerror = (event) => {
      const errorMessage = event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "无法使用麦克风，请允许浏览器访问麦克风后重试。"
        : event.error === "audio-capture"
          ? "没有检测到可用的麦克风，请检查设备后重试。"
          : event.error === "no-speech"
            ? "没有听到语音，请靠近麦克风后重试。"
            : "语音输入暂时不可用，请重试或改用键盘输入。";
      setVoiceError(errorMessage);
      setIsListening(false);
    };
    recognition.onend = () => setIsListening(false);
    recognitionRef.current = recognition;
    setSpeechSupported(true);

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
      recognitionRef.current = null;
    };
  }, []);

  const addDiscoveryFiles = async (files: File[]) => {
    if (!files.length || pendingPrompt || resetInFlightRef.current || fileReadInFlightRef.current) return;
    setUploadError("");

    const existingKeys = new Set(attachments.map(({ file }) => `${file.name}-${file.size}-${file.lastModified}`));
    const uniqueFiles = files.filter((file) => {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
    if (!uniqueFiles.length) {
      setUploadError("所选文件已经添加，无需重复上传。");
      return;
    }
    const unsupported = uniqueFiles.find((file) => !isDiscoveryFileSupported(file));
    if (unsupported) {
      setUploadError(`无法读取“${unsupported.name}”。请将所需内容粘贴到输入框，或转为 TXT、MD、CSV、JSON、HTML、XML 文本文件后添加。`);
      return;
    }
    const oversized = uniqueFiles.find((file) => file.size > MAX_DISCOVERY_FILE_BYTES);
    if (oversized) {
      setUploadError(`“${oversized.name}”超过 10 MB，请精简文件内容后再添加。`);
      return;
    }

    const availableSlots = MAX_DISCOVERY_FILES - attachments.length;
    if (availableSlots <= 0) {
      setUploadError(`每次最多上传 ${MAX_DISCOVERY_FILES} 个文件。`);
      return;
    }
    const acceptedFiles = uniqueFiles.slice(0, availableSlots);
    if (uniqueFiles.length > availableSlots) {
      setUploadError(`每次最多上传 ${MAX_DISCOVERY_FILES} 个文件，已保留前 ${availableSlots} 个。`);
    }

    fileReadInFlightRef.current = true;
    setIsReadingFiles(true);
    const readResults = await Promise.all(acceptedFiles.map(async (file) => {
      let textExcerpt: string;
      try {
        textExcerpt = (await file.slice(0, 24 * 1024).text()).replace(/\uFFFD$/u, "").trim().slice(0, 8000);
        if (!textExcerpt || textExcerpt.includes("\0") || textExcerpt.includes("\uFFFD")) {
          return { attachment: null, failedFilename: file.name };
        }
      } catch {
        return { attachment: null, failedFilename: file.name };
      }
      return {
        attachment: {
          id: `${file.name}-${file.size}-${file.lastModified}`,
          file,
          textExcerpt,
        },
        failedFilename: null,
      };
    }));
    const nextAttachments = readResults.flatMap(({ attachment }) => attachment ? [attachment] : []);
    const failedFilenames = readResults.flatMap(({ failedFilename }) => failedFilename ? [failedFilename] : []);
    if (failedFilenames.length) {
      setUploadError(`“${failedFilenames.join("、")}”没有可读取的文本，未被添加。请使用 UTF-8 文本文件，或将内容直接粘贴到输入框。`);
    }
    setAttachments((items) => [...items, ...nextAttachments].slice(0, MAX_DISCOVERY_FILES));
    fileReadInFlightRef.current = false;
    setIsReadingFiles(false);
  };

  const handleFileSelection = (event: ChangeEvent<HTMLInputElement>) => {
    void addDiscoveryFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const handleFileDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files") || pendingPrompt) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setIsDraggingFiles(true);
  };

  const handleFileDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files") || pendingPrompt) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleFileDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setIsDraggingFiles(false);
  };

  const handleFileDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files") || pendingPrompt) return;
    event.preventDefault();
    fileDragDepthRef.current = 0;
    setIsDraggingFiles(false);
    void addDiscoveryFiles(Array.from(event.dataTransfer.files));
  };

  const sendDiscoveryPrompt = async (overridePrompt?: string) => {
    if (identityContextVersion !== readApiAuthContextVersion()) {
      setStorageError("使用身份已更改，输入已保留；切回原身份后可继续。");
      return;
    }
    if (turnInFlightRef.current || resetInFlightRef.current || fileReadInFlightRef.current || isLoadingDiscovery || isClaimingIntake) return;
    if (overridePrompt && (prompt.trim() || attachments.length)) return;
    const nextPrompt = (overridePrompt ?? prompt).trim().slice(0, MAX_DISCOVERY_MESSAGE_CHARS);
    if (!nextPrompt && attachments.length === 0) {
      setInputError(copy.emptyError);
      return;
    }
    if (/【示例输入[^】]*】/u.test(nextPrompt)) {
      setInputError("请先将示例改为你的真实情况，再删除开头的示例标记后发送。文字已保留。");
      return;
    }
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    }
    setInputError("");
    setUploadError("");
    setVoiceError("");
    turnInFlightRef.current = true;
    const fallbackPrompt = isValueDiscovery
      ? "请根据这些资料提炼我的核心价值，并构建能力身份卡草稿。"
      : "请根据这些资料梳理要解决的问题。";
    const submittedPrompt = nextPrompt || fallbackPrompt;
    if (overridePrompt) setPrompt(submittedPrompt);
    const submittedAttachments = attachments;
    const attachmentInputs: DiscoveryAttachmentInput[] = submittedAttachments.map(({ file, textExcerpt }) => ({
      name: file.name.slice(0, 255),
      contentType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      textExcerpt,
    }));
    const submissionFingerprint = JSON.stringify([submittedPrompt, attachmentInputs]);
    setPendingPrompt(submittedPrompt);
    setSlowReply(false);
    setPendingAttachmentNames(attachmentInputs.map(({ name }) => name));
    discoveryMutationRevisionRef.current += 1;
    if (fileInputRef.current) fileInputRef.current.value = "";
    try {
      if (!discoveryVersionRef.current) {
        const restoredState = await loadDiscovery();
        acceptDiscoveryState(restoredState);
        if (restoredState.turns.length && !startsFresh) {
          setStorageError("已恢复最新对话，输入仍保留。请阅读当前内容后再发送，以免确认了旧版本。");
          return;
        }
      }
      if (startsFresh) {
        const resetState = await resetDiscovery(discoveryVersionRef.current!);
        acceptDiscoveryState(resetState ?? await loadDiscovery());
        setStartsFresh(false);
        retryDiscoveryTurnRef.current = null;
        // Once reset succeeds, refreshing or retrying must not archive the newly started thread again.
        clearDiscoveryEntryQuery();
        persistComposer({ prompt: submittedPrompt, startsFresh: false, attachmentCount: attachmentInputs.length, pending: null });
      }
      const retry = retryDiscoveryTurnRef.current?.fingerprint === submissionFingerprint ? retryDiscoveryTurnRef.current : null;
      const submission = retry ?? {
        ...discoveryVersionRef.current!,
        fingerprint: submissionFingerprint,
        requestId: createRequestId(),
      };
      retryDiscoveryTurnRef.current = submission;
      persistComposer({
        prompt: submittedPrompt,
        startsFresh: false,
        attachmentCount: attachmentInputs.length,
        pending: { requestId: submission.requestId, threadId: submission.threadId, version: submission.version },
      });
      const state: DiscoveryState = await submitDiscoveryTurn({
        requestId: submission.requestId,
        prompt: submittedPrompt,
        attachments: attachmentInputs,
        expectedThreadId: submission.threadId,
        expectedVersion: submission.version,
      });
      acceptDiscoveryState(state);
      setPrompt("");
      setExampleNotice("");
      setAttachments([]);
      setStartsFresh(false);
      setStorageError("");
      retryDiscoveryTurnRef.current = null;
      persistComposer({ prompt: "", startsFresh: false, attachmentCount: 0, pending: null });
      clearDiscoveryEntryQuery();
    } catch (error) {
      if (error instanceof ApiError && (error.code === "DISCOVERY_STATE_CONFLICT" || error.code === "DISCOVERY_VERSION_REQUIRED")) {
        retryDiscoveryTurnRef.current = null;
        try {
          acceptDiscoveryState(await loadDiscovery());
          setStartsFresh(false);
          clearDiscoveryEntryQuery();
          persistComposer({ prompt: submittedPrompt, startsFresh: false, attachmentCount: attachmentInputs.length, pending: null });
          setStorageError("对话已在其他页面更新，最新内容已载入。你的输入仍保留，请阅读最新版本后再发送；如需新建，请点击“新对话”。");
        } catch {
          discoveryVersionRef.current = null;
          setStorageError("对话版本已更新，但暂时无法载入。输入已保留，请恢复连接后重新发送并检查最新内容。");
        }
      } else {
        setStorageError(`${error instanceof Error ? error.message : "消息发送失败。"} 输入和附件已保留，可再次发送重试。`);
      }
    } finally {
      turnInFlightRef.current = false;
      setPendingPrompt(null);
      setPendingAttachmentNames([]);
    }
  };

  const handleTalentSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendDiscoveryPrompt();
  };

  const editDiscoveryField = (label: string, value: string) => {
    setPrompt((current) => current.trim() ? `${current}\n${label}：${value}` : `${label}：${value}`);
    setInputError("");
    window.requestAnimationFrame(() => { promptRef.current?.focus(); promptRef.current?.scrollIntoView({ block: "center", behavior: "instant" }); });
  };

  const handlePromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const resetTalentConversation = async () => {
    if (identityContextVersion !== readApiAuthContextVersion()) {
      setStorageError("使用身份已更改，未清空对话；请刷新后继续。");
      return;
    }
    if (turnInFlightRef.current || pendingPrompt || fileReadInFlightRef.current || isLoadingDiscovery || isClaimingIntake) {
      setStorageError("请等待当前回复完成后再新建对话。");
      return;
    }
    if ((conversation.length || pendingPrompt) && !window.confirm("是否清空当前对话并新建对话？")) return;
    if (resetInFlightRef.current) return;
    resetInFlightRef.current = true;
    setIsResettingDiscovery(true);
    recognitionRef.current?.abort();
    setIsListening(false);
    discoveryMutationRevisionRef.current += 1;
    try {
      if (!discoveryVersionRef.current) acceptDiscoveryState(await loadDiscovery());
      const resetState = await resetDiscovery(discoveryVersionRef.current!);
      acceptDiscoveryState(resetState ?? await loadDiscovery());
    } catch (error) {
      if (error instanceof ApiError && error.code === "DISCOVERY_STATE_CONFLICT") {
        try {
          acceptDiscoveryState(await loadDiscovery());
          setStorageError("对话已在其他页面更新，未清空任何内容。请先检查最新对话，再决定是否新建。");
        } catch {
          discoveryVersionRef.current = null;
          setStorageError("对话已更新，暂时无法载入。未清空当前输入，请恢复连接后重试。");
        }
      } else setStorageError(error instanceof Error ? error.message : "新建对话失败，请稍后重试。");
      resetInFlightRef.current = false;
      setIsResettingDiscovery(false);
      return;
    }
    retryDiscoveryTurnRef.current = null;
    recognitionRef.current?.abort();
    setPrompt("");
    setExampleNotice("");
    setConversation([]);
    setArtifact(null);
    setPendingPrompt(null);
    setPendingAttachmentNames([]);
    setAttachments([]);
    setInputError("");
    setUploadError("");
    setVoiceError("");
    setStorageError("");
    setIsDraggingFiles(false);
    fileDragDepthRef.current = 0;
    if (fileInputRef.current) fileInputRef.current.value = "";
    setIsListening(false);
    setStartsFresh(false);
    persistComposer({ prompt: "", startsFresh: false, attachmentCount: 0, pending: null });
    clearDiscoveryEntryQuery();
    resetInFlightRef.current = false;
    setIsResettingDiscovery(false);
  };

  const toggleVoiceInput = () => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      setVoiceError("当前浏览器暂不支持语音识别，请改用键盘输入。");
      return;
    }

    if (isListening) {
      recognition.stop();
      setIsListening(false);
      return;
    }

    speechBasePromptRef.current = prompt.trim();
    setInputError("");
    setVoiceError("");
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      setVoiceError("语音输入未能启动，请稍后重试。");
      setIsListening(false);
    }
  };

  return (
    <div className="talent-client-page">
      <section className="talent-chat" data-has-conversation={hasConversation} data-has-profile={Boolean(parsedCapability)} aria-labelledby={titleId}>
        <div className="talent-chat-shell">
          <header className={hasConversation ? "sr-only" : "talent-chat-welcome"}>
            <h1 id={titleId}>{copy.title}</h1>
            {!hasConversation && (
              <p>{copy.description}</p>
            )}
          </header>

          {hasConversation && (
            <div className="talent-chat-thread" role="log" aria-label={isValueDiscovery ? "能力梳理对话" : "问题梳理对话"} aria-live="polite" aria-busy={Boolean(pendingPrompt) || isResettingDiscovery}>
              <div className="talent-chat-thread-heading">
                <div><span>{copy.advisor}</span><small>{flow?.status === "confirmed" ? "当前版本已确认保存 · 可继续修改" : flow?.status === "ready" ? "草稿待你确认 · 可直接提出修改" : "信息可随时补充与修正"}</small></div>
                <button type="button" disabled={isResettingDiscovery} onClick={resetTalentConversation}><ChatCircleText size={19} weight="regular" aria-hidden="true" />新对话</button>
              </div>
              {visibleConversation.map((item, index) => (
                <div className="talent-chat-turn" key={item.id}>
                  <article className="talent-chat-message talent-chat-message-user">
                    <p>{item.question}</p>
                    {item.attachments?.length ? (
                      <ul className="talent-chat-message-files" aria-label="本次消息的附件">
                        {item.attachments.map((filename) => <li key={filename}><FileText size={15} weight="duotone" aria-hidden="true" />{filename}</li>)}
                      </ul>
                    ) : null}
                  </article>
                  <article className="talent-chat-message talent-chat-message-assistant">
                    <span className="talent-chat-avatar" aria-hidden="true"><AdvisorIcon size={19} weight="duotone" /></span>
                    {index < visibleConversation.length - 1 && shouldFoldDiscoveryHistory(item.answer)
                      ? <details className="talent-chat-history-reply"><summary>查看第 {index + 1} 轮顾问回复</summary><p>{item.answer}</p></details>
                      : <p>{index === visibleConversation.length - 1 ? discoveryAnswerForDisplay(item.answer, artifact) : item.answer}</p>}
                  </article>
                </div>
              ))}
              {pendingPrompt && (
                <div className="talent-chat-turn">
                  <article className="talent-chat-message talent-chat-message-user">
                    <p>{pendingPrompt}</p>
                    {pendingAttachmentNames.length ? (
                      <ul className="talent-chat-message-files" aria-label="本次消息的附件">
                        {pendingAttachmentNames.map((filename) => <li key={filename}><FileText size={15} weight="duotone" aria-hidden="true" />{filename}</li>)}
                      </ul>
                    ) : null}
                  </article>
                  <article className="talent-chat-message talent-chat-message-assistant talent-chat-message-loading" role="status">
                    <span className="talent-chat-avatar" aria-hidden="true"><AdvisorIcon size={19} weight="duotone" /></span>
                    <p><span className="talent-chat-loading-label">{slowReply ? "正在核对已知信息与原文依据，内容已保留，请稍候" : copy.loadingLabel}</span><i /><i /><i /></p>
                  </article>
                </div>
              )}
              <div ref={latestTurnRef} />
              {flow && !pendingPrompt && <DiscoveryDraftReview kind={discoveryKind} flow={flow} disabled={composerBusy} onEdit={editDiscoveryField} />}
              {parsedCapability && <details className="talent-discovery-profile-details"><summary>查看能力身份卡</summary><ParsedCapabilityProfile analysis={parsedCapability} /></details>}
            </div>
          )}

          <div
            className="talent-chat-composer-zone"
            onDragEnter={handleFileDragEnter}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
          >
            {hasConversation && flow && !pendingPrompt && <div className="talent-chat-suggestions talent-chat-flow-actions" aria-label="梳理下一步">
              {flow.status === "ready" && <button type="button" disabled={quickActionDisabled} onClick={() => void sendDiscoveryPrompt("确认保存当前版本")}>确认保存当前版本<CheckCircle size={16} aria-hidden="true" /></button>}
              {flow.status === "collecting" && <><button type="button" disabled={quickActionDisabled} onClick={() => void sendDiscoveryPrompt("先生成草稿")}>先生成草稿</button><button type="button" disabled={quickActionDisabled} onClick={() => void sendDiscoveryPrompt("暂时跳过")}>暂时跳过</button></>}
              {flow.status !== "confirmed" && <button type="button" disabled={composerBusy} onClick={() => promptRef.current?.focus()}>补充或修改</button>}
            </div>}
            {isDraggingFiles && (
              <div className="talent-chat-drop-hint" role="status">
                <Paperclip size={20} weight="bold" aria-hidden="true" />
                松开即可添加文件
              </div>
            )}
            <form className="talent-chat-composer" onSubmit={handleTalentSubmit} noValidate>
              <label className="sr-only" htmlFor={promptId}>{copy.inputLabel}</label>
              <input
                ref={fileInputRef}
                className="talent-chat-file-input"
                type="file"
                accept={DISCOVERY_FILE_ACCEPT}
                multiple
                tabIndex={-1}
                aria-hidden="true"
                disabled={Boolean(pendingPrompt) || isReadingFiles || isResettingDiscovery}
                onChange={handleFileSelection}
              />
              <button
                className="talent-chat-attach"
                type="button"
                aria-label="添加文本文件"
                title="添加文本文件（最多 5 个，每个 10 MB；每个文件读取前 8,000 字符）"
                disabled={Boolean(pendingPrompt) || isReadingFiles || isResettingDiscovery}
                onClick={() => fileInputRef.current?.click()}
              >
                <Paperclip size={21} weight="regular" aria-hidden="true" />
              </button>
              <textarea
                ref={promptRef}
                id={promptId}
                value={prompt}
                onChange={(event) => { setPrompt(event.target.value); setInputError(""); }}
                onKeyDown={handlePromptKeyDown}
                maxLength={MAX_DISCOVERY_MESSAGE_CHARS}
                rows={1}
                placeholder={hasConversation ? flow?.status === "ready" ? "直接说出要修改的内容；无误可点击上方确认" : "回答问题，也可以一次补充、修改多项信息…" : copy.placeholder}
                aria-invalid={Boolean(inputError)}
                aria-describedby={`${inputError || uploadError || voiceError ? errorId : helpId}${storageError ? ` ${storageErrorId}` : ""}`}
                disabled={Boolean(pendingPrompt) || isResettingDiscovery}
              />
              <button
                className="talent-chat-voice"
                type="button"
                aria-label={isListening ? "停止语音输入" : "开始语音输入"}
                aria-pressed={isListening}
                data-listening={isListening}
                title={speechSupported ? (isListening ? "停止语音输入" : "语音输入") : "当前浏览器暂不支持语音识别"}
                disabled={Boolean(pendingPrompt) || isResettingDiscovery}
                onClick={toggleVoiceInput}
              >
                {isListening ? <StopCircle size={21} weight="fill" aria-hidden="true" /> : <Microphone size={21} weight="regular" aria-hidden="true" />}
              </button>
              <button className="talent-chat-submit" type="submit" aria-label={pendingPrompt ? copy.loadingLabel : "发送消息"} data-loading={Boolean(pendingPrompt)} disabled={Boolean(pendingPrompt) || isReadingFiles || isLoadingDiscovery || isClaimingIntake || isResettingDiscovery}>
                {pendingPrompt ? <CircleNotch size={20} weight="bold" aria-hidden="true" /> : <PaperPlaneTilt size={20} weight="fill" aria-hidden="true" />}
              </button>
            </form>
            {attachments.length > 0 && !pendingPrompt && (
              <ul className="talent-chat-attachments" aria-label={`已添加 ${attachments.length} 个附件`}>
                {attachments.map(({ id, file }) => (
                  <li key={id}>
                    <span className="talent-chat-file-icon" aria-hidden="true"><FileText size={18} weight="duotone" /></span>
                    <span className="talent-chat-file-details"><strong title={file.name}>{file.name}</strong><small>{formatDiscoveryFileSize(file.size)} · 读取前 8,000 字符以内的文本</small></span>
                    <button
                      type="button"
                      aria-label={`移除附件 ${file.name}`}
                      title="移除附件"
                      disabled={Boolean(pendingPrompt) || isResettingDiscovery}
                      onClick={() => { setAttachments((items) => items.filter((item) => item.id !== id)); setUploadError(""); }}
                    >
                      <X size={15} weight="bold" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="talent-chat-meta">
              {inputError
                ? <p id={errorId} role="alert">{inputError}</p>
                : uploadError
                  ? <p id={errorId} role="alert">{uploadError}</p>
                  : voiceError
                    ? <p id={errorId} role="alert">{voiceError}</p>
                    : <p id={helpId} role={isListening || isReadingFiles || isLoadingDiscovery || isClaimingIntake || isResettingDiscovery || flow ? "status" : undefined}>{isResettingDiscovery ? "正在新建对话，请稍候。" : isLoadingDiscovery || isClaimingIntake ? "正在恢复对话，输入的内容会保留。" : isReadingFiles ? "正在读取文本，完成后即可发送。" : isListening ? "正在聆听，说完后再点一次停止。" : flowHelper}</p>}
              {storageError ? <p id={storageErrorId} role="alert">{storageError}</p> : null}
              {exampleNotice && <p role="status">{exampleNotice}</p>}
              <span>Enter 发送，Shift + Enter 换行</span>
            </div>
            {!hasConversation && (
              <div className="talent-chat-suggestions" aria-label="问题示例">
                {discoveryExamples[discoveryKind].map((item) => <button key={item.label} type="button" disabled={composerBusy || Boolean(prompt.trim())} onClick={() => { setPrompt(item.prompt); setExampleNotice("已填入可编辑示例，请替换成你的真实情况；尚未发送。" ); setInputError(""); promptRef.current?.focus(); }}>示例：{item.label}</button>)}
              </div>
            )}
          </div>
        </div>
      </section>
      {flow?.status === "confirmed" && !pendingPrompt && !isResettingDiscovery && <MatchingPanel
        key={`matching:${artifact?.id}:${visibleConversation.at(-1)?.id}`}
        kind={isValueDiscovery ? "capability" : "problem"}
        compact
        autoOpen
      />}
    </div>
  );
}

function HowItWorksClientPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [allowsAutoplay, setAllowsAutoplay] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let hasStarted = video.currentTime > 0;
    let autoplayPending = !preference.matches;
    let playInFlight = false;
    let disposed = false;

    const attemptAutoplay = () => {
      if (disposed || !autoplayPending || preference.matches || document.visibilityState !== "visible" || playInFlight) return;
      video.muted = true;
      video.defaultMuted = true;
      playInFlight = true;
      void video.play().then(() => {
        if (!disposed) autoplayPending = false;
      }).catch(() => {
        // A later media/page lifecycle event may retry; controls remain available.
      }).finally(() => { playInFlight = false; });
    };
    const restartAutoplay = () => {
      if (preference.matches) return;
      autoplayPending = true;
      if (video.readyState > 0) video.currentTime = 0;
      attemptAutoplay();
    };
    const handlePlaying = () => { hasStarted = true; autoplayPending = false; };
    const handlePause = () => { autoplayPending = false; };
    const handleCanPlay = () => { if (!hasStarted) attemptAutoplay(); };
    const handlePageShow = (event: PageTransitionEvent) => { if (event.persisted) restartAutoplay(); };
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && (!hasStarted || video.ended)) restartAutoplay();
    };
    const syncPreference = () => {
      setAllowsAutoplay(!preference.matches);
      video.autoplay = !preference.matches;
      if (preference.matches) {
        autoplayPending = false;
        video.pause();
      } else if (!hasStarted || video.ended) {
        restartAutoplay();
      }
    };
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("pause", handlePause);
    video.addEventListener("canplay", handleCanPlay);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibility);
    preference.addEventListener("change", syncPreference);
    syncPreference();
    return () => {
      disposed = true;
      video.removeEventListener("playing", handlePlaying);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("canplay", handleCanPlay);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibility);
      preference.removeEventListener("change", syncPreference);
    };
  }, []);

  const process = [
    {
      icon: FileMagnifyingGlass,
      title: "AI 发现问题并定义约束",
      body: "从真实痛点开始，澄清目标、约束和成功结果，让模糊需求成为清晰问题。",
    },
    {
      icon: UserFocus,
      title: "AI 构建解决方案",
      body: "基于问题与价值目标，形成解决路径、所需能力、里程碑和验收标准。",
    },
    {
      icon: Target,
      title: "AI 完成匹配与合作确认",
      body: "匹配问题价值与真实能力证据，说明推荐理由，由双方确认是否继续沟通与合作。",
    },
  ];

  const confidenceFeatures = [
    {
      image: "/images/how-it-works-discovery-v4.webp",
      title: "AI 发现真实问题",
      body: "从目标、现状与现实约束中，识别真正需要解决的问题。",
    },
    {
      image: "/images/how-it-works-match-card-v2.webp",
      title: "AI 完成价值匹配",
      body: "将问题价值与候选人的真实能力证据进行匹配，并说明推荐理由。",
    },
    {
      image: "/images/how-it-works-conversation-card-v2.webp",
      title: "充分验证，放心合作",
      body: "核验 AI 证据、过往成果与合作评价，并通过直接沟通确认经验和工作方式。",
    },
    {
      image: "/images/how-it-works-delivery-card-v6.webp",
      title: "确认交付，保留结果记录",
      body: "按双方约定推进合作、确认交付结果，并把成果补充为后续可参考的记录。",
    },
  ];

  const trustPoints = [
    {
      icon: Database,
      title: "完整经历信息",
      body: "AI 整理候选人提供的项目经历、作品和交付记录，形成可继续核对的能力线索。",
    },
    {
      icon: Fingerprint,
      title: "多元验证信号",
      body: "结合候选人提供的成果材料、合作反馈和直接沟通，减少只看单一自述带来的判断偏差。",
    },
    {
      icon: ChatCircleText,
      title: "可核验能力证据",
      body: "价值访谈深入追问候选人的角色、行动、方法与结果，将真实经验转化为可核验、可比较的能力证据。",
    },
  ];

  const faqGroups = {
    start: {
      label: "开始探索",
      questions: [
        { question: "我需要先准备一份完整需求吗？", answer: "不需要。从一个真实痛点或模糊想法开始即可，AI 会帮助你识别目标、约束、风险和期待结果。" },
        { question: "开始探索需要付费吗？", answer: "基础功能免费。你可以先完成问题梳理、价值定义并了解匹配逻辑；正式合作的范围与费用由双方另行确认。" },
      ],
    },
    discovery: {
      label: "发现问题",
      questions: [
        { question: "AI 如何发现真正的问题？", answer: "系统会围绕目标、现状、限制条件和期待结果继续提问，帮助你区分表面需求与真正需要解决的痛点。" },
        { question: "问题发生变化时怎么办？", answer: "你可以随时补充新的事实和约束，AI 会重新整理问题边界、价值目标与后续解决路径。" },
      ],
    },
    solution: {
      label: "构建方案",
      questions: [
        { question: "AI 会直接替我完成解决方案吗？", answer: "AI 负责形成可讨论的解决框架，包括能力组合、里程碑和结果标准。专业判断与最终交付仍由合作双方完成。" },
        { question: "方案不符合实际情况怎么办？", answer: "每个关键环节都可以补充信息和重新确认，系统会根据新的目标、约束与反馈更新解决路径。" },
      ],
    },
    matching: {
      label: "价值匹配",
      questions: [
        { question: "目前如何判断匹配关系？", answer: "系统根据双方自行确认并公开的工作能力标签，以及工作方式、合作方式、地点和必需能力筛选相关结果，并说明共同点与待确认事项。匹配不代表胜任概率或能力认证，实际经历、成果、预算与可投入时间仍需双方核实。" },
        { question: "为什么系统推荐这些人？", answer: "系统会展示相关经历、成果证据、适配原因和待确认差距，让你知道为什么合适，也知道还需要问什么。" },
      ],
    },
    results: {
      label: "合作与结果",
      questions: [
        { question: "谁来决定是否开始合作？", answer: "决定权始终属于合作双方。AI 提供结构化方案和判断依据，不会自动作出合作决定。" },
        { question: "合作结果可以怎样复用？", answer: "双方确认后，可以把成果与反馈补充为能力证据，供未来的问题分析与价值匹配参考。" },
      ],
    },
  } as const;

  type FaqGroup = keyof typeof faqGroups;
  const faqGroupKeys = Object.keys(faqGroups) as FaqGroup[];
  const [activeFaqGroup, setActiveFaqGroup] = useState<FaqGroup>("start");
  const activeQuestions = faqGroups[activeFaqGroup].questions;

  return (
    <div className="how-client-page">
      <section className="how-client-hero">
        <div className="how-client-hero-copy">
          <h1>DuduHire 如何工作</h1>
          <p>DuduHire 从真实问题出发，用 AI 梳理目标、构建方案、匹配能力并记录可验证的交付结果。</p>
        </div>
        <div className="how-client-hero-media">
          <video
            ref={videoRef}
            autoPlay={allowsAutoplay}
            controls
            muted
            playsInline
            preload="auto"
            poster="/images/how-it-works-product-motion-poster-v2-4k.jpg"
            aria-label="DuduHire 工作方式：需求整理与能力档案演示"
          >
            <source src="/images/how-it-works-product-motion-v2-4k.mp4" type="video/mp4" />
          </video>
        </div>
      </section>

      <section className="how-client-process" aria-label="DuduHire AI 价值流程">
        <ol>
          {process.map((step) => {
            const StepIcon = step.icon;
            return (
              <li key={step.title}>
                <StepIcon size={31} weight="regular" aria-hidden="true" />
                <h2>{step.title}</h2>
                <p>{step.body}</p>
              </li>
            );
          })}
        </ol>
        <a className="button button-primary button-large" href="/talent">开始梳理真实问题<ArrowRight size={19} weight="bold" /></a>
      </section>

      <section className="how-client-confidence" aria-labelledby="how-client-confidence-title">
        <header>
          <h2 id="how-client-confidence-title">从问题到交付，步步有据</h2>
          <p>AI 帮你发现真实问题、理解匹配理由、核对候选人，并记录双方确认的结果。</p>
        </header>
        <div className="how-client-confidence-grid">
          {confidenceFeatures.map((feature) => (
            <article key={feature.title}>
              <img className="how-client-confidence-image" src={feature.image} width="1400" height="1182" alt={`${feature.title}的产品流程示意`} loading="lazy" decoding="async" />
              <h3>{feature.title}</h3>
              <p>{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="how-client-team" aria-labelledby="how-client-team-title">
        <div className="how-client-team-copy">
          <h2 id="how-client-team-title"><span>完成一次</span><span>清晰的问题解决</span></h2>
          <p>按 AI 形成的解决路径，自由组合当前问题真正需要的专业能力。</p>
          <nav aria-label="浏览能力领域">
            <a href="/talent?category=product">产品与技术<ArrowRight size={18} weight="bold" /></a>
            <a href="/talent?category=design">设计与创意<ArrowRight size={18} weight="bold" /></a>
            <a href="/talent?category=growth">市场与增长<ArrowRight size={18} weight="bold" /></a>
            <a href="/talent?category=operations">运营与支持<ArrowRight size={18} weight="bold" /></a>
          </nav>
        </div>
        <figure><img src="/images/outcome-team-v2.webp" width="1122" height="1402" alt="充满活力的创意团队围绕方案模型交流想法" loading="lazy" /></figure>
      </section>

      <section className="how-client-trust" aria-labelledby="how-client-trust-title">
        <header>
          <h2 id="how-client-trust-title">我们如何增强决策信心</h2>
          <p>AI 整理并解释候选人提供的分散信息，让人才选择建立在更清晰的线索、更多元的信号与可继续核对的证据之上。</p>
        </header>
        <div>
          {trustPoints.map((item) => {
            const TrustIcon = item.icon;
            return <article key={item.title}><TrustIcon size={28} weight="regular" aria-hidden="true" /><h3>{item.title}</h3><p>{item.body}</p></article>;
          })}
        </div>
      </section>

      <section className="how-client-faq" aria-labelledby="how-client-faq-title">
        <h2 id="how-client-faq-title">常见问题</h2>
        <div>
          <div className="how-client-faq-tabs" role="tablist" aria-label="常见问题分类">
            {faqGroupKeys.map((group, index) => (
              <button key={group} id={`how-client-faq-tab-${group}`} type="button" role="tab" aria-selected={activeFaqGroup === group} aria-controls="how-client-faq-panel" tabIndex={activeFaqGroup === group ? 0 : -1} onClick={() => setActiveFaqGroup(group)} onKeyDown={(event) => handleTabNavigation(event, index, faqGroupKeys.length, (nextIndex) => setActiveFaqGroup(faqGroupKeys[nextIndex]))}>
                {faqGroups[group].label}
              </button>
            ))}
          </div>
          <div className="how-client-faq-list" id="how-client-faq-panel" role="tabpanel" aria-labelledby={`how-client-faq-tab-${activeFaqGroup}`} tabIndex={0} key={activeFaqGroup}>
            {activeQuestions.map((item, index) => <details key={item.question} open={index === 0}>
              <summary>{item.question}<CaretDown size={20} weight="bold" aria-hidden="true" /></summary>
              <p>{item.answer}</p>
            </details>)}
          </div>
        </div>
      </section>

      <section className="how-client-closing">
        <div><h2>准备好解决第一个问题了吗？</h2><p>无需准备复杂材料，从你现在最想解决的事情开始。</p></div>
        <a className="button button-large" href="/talent">开始梳理<ArrowRight size={19} weight="bold" /></a>
      </section>
    </div>
  );
}

const pricingWalletPlans = [
  {
    id: "team",
    name: "团队协作",
    price: "按需",
    side: "left",
    tone: "navy",
    description: "适合持续采购、多人评审和项目结果追踪，让团队在同一套判断标准下协作。",
    features: ["共享需求与候选人评审", "项目证据和结果记录", "团队角色与协作权限"],
    action: "咨询团队方案",
  },
  {
    id: "flexible",
    name: "灵活用工",
    price: "按项目",
    side: "left",
    tone: "copper",
    description: "在业务峰值、岗位空缺或短期项目中快速补足专业能力，并提前确认合作边界。",
    features: ["按时间窗口配置人才", "身份、合同与入场协同", "里程碑和交付确认"],
    action: "讨论用工需求",
  },
  {
    id: "enterprise",
    name: "企业服务",
    price: "定制",
    side: "right",
    tone: "lime",
    description: "面向复杂权限、系统集成、安全治理和跨部门协作，设计一套可持续运行的外部人才流程。",
    features: ["企业人才池与供应商连接", "审批、权限和系统集成", "组织级结果与风险追踪"],
    action: "查看企业服务",
    href: "/enterprise",
  },
  {
    id: "managed",
    name: "托管交付",
    price: "按范围",
    side: "right",
    tone: "ivory",
    description: "将完整工作包交给一支为结果负责的跨职能团队，按范围、节奏和验收条件推进。",
    features: ["按问题组建专项工作队", "统一项目管理与风险处理", "按已确认结果完成收口"],
    action: "规划托管项目",
  },
] as const;

function MechanicalPricingWallet() {
  const [activePlanIndex, setActivePlanIndex] = useState(2);
  const [contactOpen, setContactOpen] = useState(false);
  const activePlan = pricingWalletPlans[activePlanIndex];
  const renderWalletHalf = (side: "left" | "right") => (
    <div className={`mechanical-wallet-half mechanical-wallet-half-${side}`}>
      <span className="mechanical-wallet-lining" aria-hidden="true" />
      {pricingWalletPlans.filter((plan) => plan.side === side).map((plan, layerIndex) => {
        const planIndex = pricingWalletPlans.findIndex((item) => item.id === plan.id);
        return (
          <button
            key={plan.id}
            type="button"
            className="mechanical-wallet-card"
            data-tone={plan.tone}
            aria-pressed={activePlanIndex === planIndex}
            aria-label={`选择${plan.name}方案，${plan.price}`}
            style={{ "--wallet-card-layer": layerIndex } as CSSProperties}
            onClick={() => setActivePlanIndex(planIndex)}
          >
            <span className="mechanical-card-brand">DUDUHIRE</span>
            <span className="mechanical-card-chip" aria-hidden="true" />
            <ContactlessPayment size={18} weight="bold" aria-hidden="true" />
            <strong>{plan.name}</strong>
            <small>{plan.price}</small>
          </button>
        );
      })}
      <span className="mechanical-wallet-pocket" aria-hidden="true" />
    </div>
  );

  return (
    <section
      className="pricing-wallet-offer"
      aria-labelledby="pricing-wallet-title"
    >
      <div className="pricing-wallet-stage">
        <header>
          <span>PAID PLANS</span>
          <p>点击卡片查看方案</p>
        </header>
        <div className="mechanical-wallet-scene">
          <span className="mechanical-wallet-shadow" aria-hidden="true" />
          <div className="mechanical-wallet" data-active-side={activePlan.side}>
            {renderWalletHalf("left")}
            <span className="mechanical-wallet-hinge" aria-hidden="true" />
            {renderWalletHalf("right")}
          </div>
        </div>
        <nav className="pricing-wallet-selector" aria-label="选择付费方案">
          {pricingWalletPlans.map((plan, index) => (
            <button key={plan.id} type="button" aria-current={activePlanIndex === index ? "true" : undefined} onClick={() => setActivePlanIndex(index)}>
              <span>0{index + 1}</span>{plan.name}
            </button>
          ))}
        </nav>
      </div>

      <div className="pricing-wallet-detail" key={activePlan.id}>
        <div>
          <span>付费方案 · 0{activePlanIndex + 1}</span>
          <h3 id="pricing-wallet-title"><strong>{activePlan.name}</strong><em>{activePlan.price}</em></h3>
          <p>{activePlan.description}</p>
        </div>
        <ul>{activePlan.features.map((feature) => <li key={feature}><CheckCircle size={18} weight="fill" />{feature}</li>)}</ul>
        {"href" in activePlan
          ? <a href={activePlan.href}>{activePlan.action}<ArrowRight size={18} weight="bold" /></a>
          : <button type="button" onClick={() => setContactOpen(true)}>{activePlan.action}<ArrowRight size={18} weight="bold" /></button>}
      </div>
      <EnterpriseContactDialog open={contactOpen} onClose={() => setContactOpen(false)} source="pricing_page" />
    </section>
  );
}

function PricingOptions() {
  return (
    <section className="pricing-options" aria-labelledby="pricing-options-title">
      <div className="pricing-options-heading">
        <h2 id="pricing-options-title">选择适合当前阶段的方案</h2>
        <p>没有长期合约。先从基础版验证工作方式，再按团队协作与治理需要升级。</p>
      </div>
      <div className="pricing-options-layout">
        <article className="pricing-option-primary">
          <div><span>基础版</span><strong>¥0</strong><small>当前免费</small></div>
          <p>适合个人、需求探索与单次项目。</p>
          <ul>
            <li><CheckCircle size={19} weight="fill" />结构化需求与能力档案</li>
            <li><CheckCircle size={19} weight="fill" />案例、证据与结果记录</li>
            <li><CheckCircle size={19} weight="fill" />可解释匹配机制</li>
          </ul>
          <a className="button button-primary" href="/signup">免费开始<ArrowRight size={18} weight="bold" /></a>
        </article>
        <MechanicalPricingWallet />
      </div>
    </section>
  );
}

export function SecondaryPage({ route }: { route: SecondaryRoute }) {
  if (route === "talent" || route === "projects") return <DiscoveryClientPage mode={route} />;
  if (route === "how-it-works") return <HowItWorksClientPage />;
  if (route === "enterprise") return <EnterpriseClientPage />;

  return (
    <div className="secondary-page secondary-page-pricing">
      <SecondaryHero page={pricingPage} />
      <SecondaryPrinciples page={pricingPage} />
      <SecondaryValue page={pricingPage} />
      <PricingOptions />
      <SecondaryFlow page={pricingPage} />
      <section className="secondary-closing">
        <div><h2>{pricingPage.closingTitle}</h2><p>{pricingPage.closingBody}</p></div>
        <a className="button button-primary button-large" href={pricingPage.closingHref}>{pricingPage.closingAction}<ArrowRight size={19} weight="bold" /></a>
      </section>
    </div>
  );
}

const personalProfileCountries = [
  { value: "", label: "未设置" },
  { value: "CN", label: "中国大陆" },
  { value: "HK", label: "中国香港" },
  { value: "SG", label: "新加坡" },
  { value: "JP", label: "日本" },
  { value: "US", label: "美国" },
  { value: "GB", label: "英国" },
  { value: "CA", label: "加拿大" },
  { value: "AU", label: "澳大利亚" },
];

function formatSessionTime(value: string | undefined) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function WorkspacePage({
  session,
  theme,
  onThemeToggle,
  onLogout,
  roleSwitch,
}: {
  session: AuthSession;
  theme: "light" | "dark";
  onThemeToggle: () => void;
  onLogout: () => void;
  roleSwitch: RoleSwitchProps;
}) {
  const isProfileView = new URLSearchParams(window.location.search).get("tab") === "profile";
  const profileDraftStorageKey = `duduhire-profile-draft:${session.id}:${session.signedInAt}:${session.role}`;
  const [personalProfile, setPersonalProfile] = useState(() => session.profile);
  const [profileDraft, setProfileDraft] = useState(() => {
    try { return readPersonalProfileDraft(window.sessionStorage, profileDraftStorageKey, session.profile); } catch { return session.profile; }
  });
  const [profileDraftRecovered] = useState(() => JSON.stringify(profileDraft) !== JSON.stringify(session.profile));
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState("");
  const [profileNameError, setProfileNameError] = useState("");
  const [isProfileSaving, setIsProfileSaving] = useState(false);
  const [discoveryCompleted, setDiscoveryCompleted] = useState(false);
  const [paymentAccountStatus, setPaymentAccountStatus] = useState<PaymentAccountStatus>("not_configured");
  const [workspaceLoadStatus, setWorkspaceLoadStatus] = useState<"loading" | "ready" | "error">("loading");
  const [workspaceLoadError, setWorkspaceLoadError] = useState("");
  const [workspaceLoadAttempt, setWorkspaceLoadAttempt] = useState(0);
  const profileSaveInFlightRef = useRef(false);
  const profileDraftRevisionRef = useRef(0);
  const profileNameRef = useRef<HTMLInputElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.matchMedia("(max-width: 900px)").matches);
  const mobileSidebarRef = useRef<HTMLElement>(null);
  const isTalent = session.role === "talent";
  const discoveryHref = isTalent ? "/projects" : "/talent";
  const discoveryLabel = isTalent ? "完善能力档案" : "梳理用人需求";
  const accountLabel = isTalent ? "能力方" : "需求方";
  const accountName = personalProfile.displayName || accountLabel;
  const accountInitial = (personalProfile.displayName || session.email || "D").slice(0, 1).toUpperCase();
  const emailVerified = Boolean(session.email && session.emailVerifiedAt);
  const phoneVerified = Boolean(session.phone && session.phoneVerifiedAt);
  const contactVerified = emailVerified || phoneVerified;
  const verificationTitle = emailVerified ? "邮箱地址已验证" : phoneVerified ? "手机号码已验证" : "联系方式尚未验证";
  const verificationDescription = emailVerified
    ? "已通过安全链接确认邮箱所有权"
    : phoneVerified ? "已通过短信验证码确认手机号所有权" : "请完成邮箱或手机号验证";
  const profileCountryLabel = personalProfileCountries.find(({ value }) => value === personalProfile.countryCode)?.label || "未设置";
  const paymentAccountComplete = paymentAccountStatus === "active";
  const workspaceNav = isTalent
      ? [
        { label: "工作台", href: "/workspace", icon: House, active: !isProfileView },
        { label: "个人信息", href: "/workspace?tab=profile", icon: UserCircle, active: isProfileView },
        { label: "完善能力档案", href: "/projects", icon: UserFocus },
        { label: "项目与合作", href: "/workspace#overview", icon: Briefcase },
        { label: "如何工作", href: "/how-it-works", icon: FileMagnifyingGlass },
      ]
    : [
        { label: "工作台", href: "/workspace", icon: House, active: !isProfileView },
        { label: "个人信息", href: "/workspace?tab=profile", icon: UserCircle, active: isProfileView },
        { label: "梳理用人需求", href: "/talent", icon: Briefcase },
        { label: "项目与短名单", href: "/workspace#overview", icon: Target },
        { label: "如何工作", href: "/how-it-works", icon: FileMagnifyingGlass },
      ];
  const setupItems = [
    {
      label: "收付款账户",
      title: isTalent ? "添加收款账户" : "添加付款账户",
      body: isTalent
        ? "用于接收已确认项目的结算款项，正式合作前完成即可。"
        : "用于合作确认后支付里程碑款项，添加前不会产生费用。",
      icon: ContactlessPayment,
      state: paymentAccountComplete ? "complete" : "required",
      status: paymentAccountComplete ? "已添加" : paymentAccountStatus === "pending" ? "审核中" : "待添加",
    },
    {
      label: "电话或邮箱（二选一）",
      title: verificationTitle,
      body: emailVerified ? session.email : session.phone || session.email || "尚未设置",
      icon: ShieldCheck,
      state: contactVerified ? "complete" : "required",
      status: contactVerified ? "已验证" : "待验证",
    },
    {
      label: isTalent ? "能力身份前置" : "需求发布前置",
      title: isTalent ? "构建能力身份卡" : "描述一个真实问题",
      body: isTalent
        ? "补充真实项目经历，让你的能力、行动与结果能够被清晰理解。"
        : "说明业务影响、现实约束与期待结果，形成第一份需求说明。",
      href: isTalent ? "/projects" : "/talent",
      action: isTalent ? "构建身份卡" : "描述问题",
      icon: ClipboardText,
      state: discoveryCompleted ? "complete" : "required",
      status: "已完成",
    },
  ];

  useEffect(() => {
    try { writePersonalProfileDraft(window.sessionStorage, profileDraftStorageKey, profileDraft, personalProfile); } catch { /* Browser storage may be disabled. */ }
  }, [personalProfile, profileDraft, profileDraftStorageKey]);

  useEffect(() => {
    let active = true;
    setWorkspaceLoadStatus("loading");
    setWorkspaceLoadError("");
    void loadWorkspace()
      .then((workspace) => {
        if (!active) return;
        setDiscoveryCompleted(workspace.discoveryCompleted);
        setPaymentAccountStatus(workspace.paymentAccountStatus);
        setWorkspaceLoadStatus("ready");
      })
      .catch((error) => {
        if (!active) return;
        setWorkspaceLoadStatus("error");
        setWorkspaceLoadError(error instanceof Error ? error.message : "暂时无法读取账户状态，请稍后重试。");
      });
    return () => {
      active = false;
    };
  }, [workspaceLoadAttempt]);

  const handleProfileSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (profileSaveInFlightRef.current) return;
    const displayName = profileDraft.displayName.trim();
    if (!displayName) {
      setProfileNameError("请填写姓名或常用称呼。");
      setProfileSaved(false);
      profileNameRef.current?.focus();
      return;
    }
    setProfileNameError("");
    profileSaveInFlightRef.current = true;
    setIsProfileSaving(true);
    const submittedRevision = profileDraftRevisionRef.current;
    try {
      const savedProfile = await savePersonalProfile({ ...profileDraft, displayName });
      setPersonalProfile(savedProfile);
      if (profileDraftRevisionRef.current === submittedRevision) setProfileDraft(savedProfile);
      setProfileSaved(true);
      setProfileSaveError("");
    } catch (error) {
      setProfileSaved(false);
      if (error instanceof ApiError && error.status === 409 && error.code !== "ACTIVE_ROLE_CHANGED") {
        try {
          const latestProfile = await loadPersonalProfile();
          setPersonalProfile(latestProfile);
          setProfileDraft((current) => mergePersonalProfileEdits(current, personalProfile, latestProfile));
          setProfileSaveError("资料已在其他页面更新。已载入最新资料并保留你的修改，请重新确认后保存。");
        } catch {
          setProfileSaveError("资料已在其他页面更新，本次修改未保存；最新版本加载失败，请刷新页面后重试。");
        }
      } else {
        setProfileSaveError(error instanceof Error ? error.message : "保存失败，请稍后重试。");
      }
    } finally {
      profileSaveInFlightRef.current = false;
      setIsProfileSaving(false);
    }
  };

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const handleViewportChange = () => {
      setIsMobileViewport(mediaQuery.matches);
      if (!mediaQuery.matches) setMobileMenuOpen(false);
    };
    mediaQuery.addEventListener("change", handleViewportChange);
    return () => mediaQuery.removeEventListener("change", handleViewportChange);
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen || !isMobileViewport) return;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const workspaceContent = document.getElementById("workspace-content");
    let secondFocusFrame: number | null = null;
    const focusFrame = window.requestAnimationFrame(() => {
      secondFocusFrame = window.requestAnimationFrame(() => mobileSidebarRef.current?.querySelector<HTMLElement>(".workspace-sidebar-mobile-close")?.focus());
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileMenuOpen(false);
      }
    };
    document.body.style.overflow = "hidden";
    workspaceContent?.setAttribute("inert", "");
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (secondFocusFrame !== null) window.cancelAnimationFrame(secondFocusFrame);
      document.body.style.overflow = previousOverflow;
      workspaceContent?.removeAttribute("inert");
      window.removeEventListener("keydown", closeOnEscape);
      if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus();
      else workspaceContent?.focus();
    };
  }, [mobileMenuOpen, isMobileViewport]);

  const handleMobileSidebarKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (!mobileMenuOpen || event.key !== "Tab") return;
    const focusable = Array.from(
      mobileSidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') || [],
    ).filter((element) => element.getClientRects().length > 0);
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
    <div
      className="workspace-app-shell"
      data-sidebar-collapsed={sidebarCollapsed}
      data-mobile-open={mobileMenuOpen}
    >
      <a className="skip-link" href="#workspace-content" inert={isMobileViewport && mobileMenuOpen}>跳到工作台内容</a>
      <button
        className="workspace-mobile-backdrop"
        type="button"
        aria-label="关闭工作台导航背景"
        aria-hidden={!isMobileViewport || !mobileMenuOpen}
        tabIndex={-1}
        onClick={() => setMobileMenuOpen(false)}
      />

      <aside id="workspace-navigation" ref={mobileSidebarRef} className="workspace-app-sidebar" aria-label="工作台导航" role={isMobileViewport && mobileMenuOpen ? "dialog" : undefined} aria-modal={isMobileViewport && mobileMenuOpen ? true : undefined} inert={isMobileViewport && !mobileMenuOpen} onKeyDown={handleMobileSidebarKeyDown}>
        <div className="workspace-sidebar-brand">
          <a href="/" aria-label="返回 DuduHire 首页">
            <img src="/images/duduhire-logo.png" width="1341" height="410" alt="DuduHire" />
          </a>
          <button
            className="workspace-sidebar-collapse"
            type="button"
            aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            aria-controls="workspace-navigation"
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            onClick={() => setSidebarCollapsed((value) => !value)}
          >
            <SidebarSimple size={19} weight="regular" />
          </button>
          <button
            className="workspace-sidebar-mobile-close"
            type="button"
            aria-label="关闭工作台导航"
            onClick={() => setMobileMenuOpen(false)}
          >
            <X size={21} aria-hidden="true" />
          </button>
        </div>

        <div className="workspace-account">
          <span className="workspace-account-avatar" aria-hidden="true">{accountInitial}</span>
          <div>
            <strong>{accountName}</strong>
                    <small>{session.email}</small>
          </div>
        </div>

        <nav className="workspace-app-nav" aria-label="主要功能">
          {workspaceNav.map(({ label, href, icon: Icon, active }) => (
            <a
              key={label}
              href={href}
              aria-current={active ? "page" : undefined}
              aria-label={sidebarCollapsed ? label : undefined}
              title={sidebarCollapsed ? label : undefined}
              onClick={() => setMobileMenuOpen(false)}
            >
              <Icon size={20} weight={active ? "fill" : "regular"} aria-hidden="true" />
              <span>{label}</span>
            </a>
          ))}
        </nav>

        <div className="workspace-sidebar-footer">
          <button type="button" onClick={onThemeToggle} title={sidebarCollapsed ? "切换显示模式" : undefined}>
            {theme === "light" ? <Moon size={20} aria-hidden="true" /> : <Sun size={20} aria-hidden="true" />}
            <span>{theme === "light" ? "深色模式" : "浅色模式"}</span>
          </button>
          <button type="button" disabled={roleSwitch.switching} onClick={onLogout} title={sidebarCollapsed ? "退出登录" : undefined}>
            <SignOut size={20} aria-hidden="true" />
            <span>退出登录</span>
          </button>
        </div>
      </aside>

      <div className="workspace-mobile-bar" inert={isMobileViewport && mobileMenuOpen}>
        <a href="/" aria-label="返回 DuduHire 首页">
          <img src="/images/duduhire-logo.png" width="1341" height="410" alt="DuduHire" />
        </a>
        <button type="button" aria-label="打开工作台导航" aria-controls="workspace-navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen(true)}>
          <List size={23} aria-hidden="true" />
        </button>
      </div>

      <div id="workspace-content" className="workspace-page" tabIndex={-1}>
        <div className="workspace-role-switch"><RoleSwitcher {...roleSwitch} /></div>
        {isProfileView ? (
          <>
            <header className="workspace-header workspace-profile-header" aria-labelledby="workspace-title">
              <div className="workspace-header-copy">
                <span className="workspace-kicker">账户与身份</span>
                <h1 id="workspace-title">个人信息</h1>
                <p>{isTalent ? "管理登录与协作识别资料；能力、案例与证据仍在身份卡中维护。" : "管理登录与协作识别资料，帮助合作方确认需求发起人的身份。"}</p>
              </div>
            </header>

            <section className="workspace-profile" aria-label="个人信息设置">
              <article className="workspace-profile-identity">
                <span className="workspace-profile-avatar" aria-hidden="true">{accountInitial}</span>
                <div>
                  <span>当前账户</span>
                  <h2>{accountName}</h2>
                  <p>{session.email}</p>
                </div>
                <span className="workspace-profile-status"><CheckCircle size={17} weight="fill" aria-hidden="true" />已登录</span>
              </article>

              <section className="workspace-profile-panel" aria-labelledby="workspace-profile-details-title">
                <header>
                  <div>
                    <span>可编辑资料</span>
                    <h2 id="workspace-profile-details-title">身份资料</h2>
                  </div>
                  <UserCircle size={28} weight="duotone" aria-hidden="true" />
                </header>
                <form noValidate onSubmit={handleProfileSubmit} onChange={() => { profileDraftRevisionRef.current += 1; if (profileSaveError) setProfileSaveError(""); }}>
                  <div className="workspace-profile-fields">
                    <div className="workspace-profile-field">
                      <label htmlFor="workspace-profile-name">显示名称 <small>必填</small></label>
                      <input
                        id="workspace-profile-name"
                        ref={profileNameRef}
                        type="text"
                        value={profileDraft.displayName}
                        maxLength={80}
                        autoComplete="name"
                        placeholder="填写你的姓名或常用称呼"
                        required
                        aria-invalid={Boolean(profileNameError)}
                        aria-describedby={profileNameError ? "workspace-profile-name-help workspace-profile-name-error" : "workspace-profile-name-help"}
                        onChange={(event) => {
                          setProfileDraft((current) => ({ ...current, displayName: event.target.value }));
                          if (profileNameError) setProfileNameError("");
                          setProfileSaved(false);
                        }}
                      />
                      <small id="workspace-profile-name-help">用于工作台和后续合作中的身份识别。</small>
                      {profileNameError ? <small id="workspace-profile-name-error" className="workspace-profile-error" role="alert">{profileNameError}</small> : null}
                    </div>
                    <div className="workspace-profile-field">
                      <label htmlFor="workspace-profile-country">所在国家或地区</label>
                      <select
                        id="workspace-profile-country"
                        value={profileDraft.countryCode}
                        autoComplete="country"
                        aria-describedby="workspace-profile-country-help"
                        onChange={(event) => {
                          setProfileDraft((current) => ({ ...current, countryCode: event.target.value }));
                          setProfileSaved(false);
                        }}
                      >
                        {personalProfileCountries.map(({ value, label }) => <option key={value || "unset"} value={value}>{label}</option>)}
                      </select>
                      <small id="workspace-profile-country-help">帮助平台采用合适的地区与合作信息。</small>
                    </div>
                    <div className="workspace-profile-field" data-span="full">
                      <label htmlFor="workspace-profile-contact">联系手机号或微信号 <small>选填</small></label>
                      <input
                        id="workspace-profile-contact"
                        type="text"
                        value={profileDraft.contact}
                        maxLength={80}
                        autoComplete="tel"
                        placeholder="填写一项常用联系方式"
                        aria-describedby="workspace-profile-contact-help"
                        onChange={(event) => {
                          setProfileDraft((current) => ({ ...current, contact: event.target.value }));
                          setProfileSaved(false);
                        }}
                      />
                      <small id="workspace-profile-contact-help">仅用于已确认的合作沟通，不在平台公开展示。</small>
                    </div>
                  </div>

                  <fieldset className="workspace-profile-role-fields">
                    <legend>{isTalent ? "能力方资料" : "需求方资料"}</legend>
                    <div className="workspace-profile-role-lock">
                      {isTalent ? <UserFocus size={20} weight="duotone" aria-hidden="true" /> : <Briefcase size={20} weight="duotone" aria-hidden="true" />}
                      <p><strong>当前：{isTalent ? "能力方" : "需求方"}</strong><span>同一账户可同时使用两种身份，通过页面上方按钮切换。基本资料共用，需求与能力档案分别保存。</span></p>
                    </div>
                    <div className="workspace-profile-fields">
                      {isTalent ? (
                        <div className="workspace-profile-field" data-span="full">
                          <label htmlFor="workspace-profile-professional-title">专业标题</label>
                          <input
                            id="workspace-profile-professional-title"
                            type="text"
                            value={profileDraft.professionalTitle}
                            maxLength={100}
                            placeholder="例如：AI 产品与业务流程顾问"
                            onChange={(event) => {
                              setProfileDraft((current) => ({ ...current, professionalTitle: event.target.value }));
                              setProfileSaved(false);
                            }}
                          />
                        </div>
                      ) : (
                        <>
                          <div className="workspace-profile-field">
                            <label htmlFor="workspace-profile-organization">公司或组织</label>
                            <input
                              id="workspace-profile-organization"
                              type="text"
                              value={profileDraft.organization}
                              maxLength={120}
                              autoComplete="organization"
                              placeholder="填写公司或组织名称"
                              onChange={(event) => {
                                setProfileDraft((current) => ({ ...current, organization: event.target.value }));
                                setProfileSaved(false);
                              }}
                            />
                          </div>
                          <div className="workspace-profile-field">
                            <label htmlFor="workspace-profile-job-title">职位</label>
                            <input
                              id="workspace-profile-job-title"
                              type="text"
                              value={profileDraft.jobTitle}
                              maxLength={80}
                              autoComplete="organization-title"
                              placeholder="填写你的职位"
                              onChange={(event) => {
                                setProfileDraft((current) => ({ ...current, jobTitle: event.target.value }));
                                setProfileSaved(false);
                              }}
                            />
                          </div>
                        </>
                      )}
                      <div className="workspace-profile-field" data-span="full">
                        <label htmlFor="workspace-profile-bio">{isTalent ? "专业简介" : "职责与需求方向"}</label>
                        <textarea
                          id="workspace-profile-bio"
                          value={profileDraft.bio}
                          maxLength={500}
                          rows={4}
                          placeholder={isTalent ? "简要说明你的专业方向、经验与合作方式" : "简要说明你负责的业务、团队或常见需求"}
                          onChange={(event) => {
                            setProfileDraft((current) => ({ ...current, bio: event.target.value }));
                            setProfileSaved(false);
                          }}
                        />
                      </div>
                    </div>
                  </fieldset>
                  <div className="workspace-profile-actions">
                    <button className="button button-primary workspace-discovery-action" type="submit" disabled={isProfileSaving} aria-busy={isProfileSaving}>保存修改<ArrowRight size={17} weight="bold" aria-hidden="true" /></button>
                    {profileSaveError
                      ? <span role="alert">{profileSaveError}</span>
                      : profileSaved
                        ? <span role="status"><CheckCircle size={16} weight="fill" aria-hidden="true" />个人信息已更新</span>
                        : profileDraftRecovered
                          ? <span role="status">已恢复此身份未保存的修改，请确认后保存。</span>
                        : null}
                  </div>
                </form>
              </section>

              <aside className="workspace-profile-panel workspace-profile-account" aria-labelledby="workspace-profile-account-title">
                <header>
                  <div>
                    <span>账户状态</span>
                    <h2 id="workspace-profile-account-title">登录与身份</h2>
                  </div>
                  <ShieldCheck size={28} weight="duotone" aria-hidden="true" />
                </header>
                <dl>
                  {session.email && <div><dt>登录邮箱</dt><dd>{session.email}</dd></div>}
                  {session.phone && <div><dt>登录手机号</dt><dd>{session.phone}</dd></div>}
                  <div><dt>当前身份</dt><dd>{isTalent ? "能力方" : "需求方"}</dd></div>
                  <div><dt>可用身份</dt><dd>需求方、能力方</dd></div>
                  <div><dt>所在地区</dt><dd>{profileCountryLabel}</dd></div>
                  <div><dt>本次登录</dt><dd>{formatSessionTime(session.signedInAt)}</dd></div>
                </dl>
                {session.email && <a className="auth-password-link" href="/account/password">设置或修改登录密码</a>}
                <div className="workspace-profile-verification">{contactVerified ? <CheckCircle size={17} weight="fill" aria-hidden="true" /> : <ShieldCheck size={17} aria-hidden="true" />}<span><strong>{verificationTitle}</strong><small>{verificationDescription}</small></span></div>
              </aside>
            </section>
          </>
        ) : (
          <>
        <header className="workspace-header" aria-labelledby="workspace-title">
          <div className="workspace-header-copy">
            <span className="workspace-kicker">{accountLabel}</span>
            <h1 id="workspace-title">欢迎回来</h1>
            <p>{isTalent ? "让真实能力被合适的需求看见，并继续推进值得投入的合作。" : "从一个真实问题开始，推进到有依据的匹配与可验证结果。"}</p>
          </div>
          <div className="workspace-header-actions">
            <a className="button button-primary workspace-discovery-action" href={discoveryHref}>{discoveryLabel}<ArrowRight size={18} weight="bold" /></a>
          </div>
        </header>

        <section className="workspace-setup" aria-labelledby="workspace-setup-title">
          <div className="workspace-section-heading">
            <div>
              <h2 id="workspace-setup-title">账户准备状态</h2>
              <p>验证邮箱或手机号并确认{isTalent ? "能力档案" : "用人需求"}后，可预览并发布匹配资料。当前参与匹配无需添加收付款账户。</p>
            </div>
          </div>
          {workspaceLoadStatus === "loading" ? (
            <div className="workspace-empty" role="status" aria-busy="true">
              <div className="workspace-empty-copy">
                <CircleNotch size={28} aria-hidden="true" />
                <h3>正在读取账户状态</h3>
                <p>加载完成后将显示最新的账户准备状态。</p>
              </div>
            </div>
          ) : workspaceLoadStatus === "error" ? (
            <div className="workspace-empty">
              <div className="workspace-empty-copy">
                <h3>账户状态加载失败</h3>
                <p role="alert">{workspaceLoadError}</p>
                <div><button type="button" className="button button-primary" onClick={() => setWorkspaceLoadAttempt((attempt) => attempt + 1)}>重新加载<ArrowRight size={18} weight="bold" aria-hidden="true" /></button></div>
              </div>
            </div>
          ) : <div className="workspace-setup-grid">
            {setupItems.map(({ label, title, body, href, action, icon: Icon, state, status }) => (
              <article key={title} data-state={state}>
                <header>
                  <span>{label}</span>
                  <span className="workspace-setup-icon" aria-hidden="true"><Icon size={25} weight="duotone" /></span>
                </header>
                <h3>{title}</h3>
                <p>{body}</p>
                {state === "complete" ? (
                  <span className="workspace-setup-complete"><CheckCircle size={17} weight="fill" />{status}</span>
                ) : href ? (
                  <a href={href}>{action}<ArrowRight size={16} weight="bold" /></a>
                ) : (
                  <span className="workspace-setup-pending">{status}</span>
                )}
              </article>
            ))}
          </div>}
        </section>

        <section id="overview" className="workspace-overview" aria-labelledby="workspace-overview-title">
          <div className="workspace-section-heading">
            <div>
              <h2 id="workspace-overview-title">项目概览</h2>
              <p>查看已确认的{isTalent ? "能力档案" : "用人需求"}与匹配结果；合作细节仍需双方另行确认。</p>
            </div>
          </div>
          <MatchingPanel kind={isTalent ? "capability" : "problem"} />
        </section>
          </>
        )}
      </div>
    </div>
  );
}

function authValidityLabel(seconds: number) {
  return [
    seconds >= 60 ? `${Math.floor(seconds / 60)} 分钟` : "",
    seconds % 60 ? `${seconds % 60} 秒` : "",
  ].filter(Boolean).join(" ");
}

const signupStoryCopy: Record<AuthRole, { title: string; description: string }> = {
  client: {
    title: "找到合适的人",
    description: "说说你想解决的问题，AI 帮你理清需求、匹配候选人，并说明推荐理由。",
  },
  talent: {
    title: "让你的能力，\n成为合作的理由",
    description: "展示你擅长的工作，AI 帮你整理项目经历、呈现能力，找到更合适的合作机会。",
  },
};

export function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const isSignup = mode === "signup";
  const authParams = new URLSearchParams(window.location.search);
  const returnTo = normalizeReturnTo(authParams.get("returnTo"));
  const suggestedRole = inferAuthRole(returnTo);
  const [pendingPhone] = useState(() => {
    try { return readPendingPhoneAuth(window.sessionStorage, mode, returnTo); } catch { return null; }
  });
  const [method, setMethod] = useState<"password" | "email" | "phone">(() => {
    if (authParams.get("method") === "phone" || (pendingPhone && !authParams.has("method"))) return "phone";
    return isSignup || authParams.get("method") === "email" ? "email" : "password";
  });
  const [role, setRole] = useState<AuthRole>(pendingPhone?.role ?? suggestedRole);
  const storyCopy = isSignup ? signupStoryCopy[role] : {
    title: "工作台已准备就绪",
    description: "发现合适的合作机会，一起把事情做好。",
  };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupAfterSignup, setSetupAfterSignup] = useState(false);
  const passwordSetupReturnTo = `/account/password?${new URLSearchParams({ returnTo })}`;
  const [phone, setPhone] = useState(pendingPhone?.phone ?? "");
  const [eligibilityAttempt, setEligibilityAttempt] = useState(0);
  const [eligibility, setEligibility] = useState<{ key: string; status: "registered" | "unregistered" | "invalid" | "error" } | null>(null);
  const [code, setCode] = useState("");
  const [phoneAvailable, setPhoneAvailable] = useState<boolean | null>(null);
  const [emailAvailable, setEmailAvailable] = useState<boolean | null>(null);
  const [methodsFailed, setMethodsFailed] = useState(false);
  const [methodsAttempt, setMethodsAttempt] = useState(0);
  const [phoneChallenge, setPhoneChallenge] = useState<PendingPhoneAuth["challenge"] | null>(pendingPhone?.challenge ?? null);
  const [phoneResendAt, setPhoneResendAt] = useState(pendingPhone?.resendAt ?? 0);
  const [phoneClock, setPhoneClock] = useState(() => Date.now());
  const [isVerifyingPhone, setIsVerifyingPhone] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; phone?: string; code?: string; submit?: string }>(() => ({
    submit: authParams.get("authError") === "invalid_or_expired"
      ? "验证链接无效或已过期，请重新发送。"
      : authParams.get("authError") === "browser_context_required"
        ? "请在申请验证邮件的同一浏览器中打开链接，或重新发送。"
      : authParams.get("authError") === "account_not_found"
        ? "该邮箱尚未注册，请先创建账户。"
      : authParams.get("authError") === "phone_account_not_found"
        ? "该手机号尚未注册。请重新输入手机号，选择先使用的身份并验证后创建账户。"
        : undefined,
  }));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [emailDelivery, setEmailDelivery] = useState<"email" | "development" | null>(null);
  const [sentEmailDetails, setSentEmailDetails] = useState<{ email: string; expiresInSeconds: number } | null>(null);
  const [resendReady, setResendReady] = useState(false);
  const submissionInFlightRef = useRef(false);
  const requestRevisionRef = useRef(0);
  const resendTimerRef = useRef<number | null>(null);
  const linkExpiryTimerRef = useRef<number | null>(null);
  const emailSent = emailDelivery === "email";
  const resendCoolingDown = emailDelivery !== null && !resendReady;
  const phoneResendSeconds = Math.max(0, Math.ceil((phoneResendAt - phoneClock) / 1000));
  const phoneExpired = phoneChallenge !== null && phoneClock >= phoneChallenge.expiresAt;
  const phoneBusy = isSubmitting || isVerifyingPhone;
  const persistPhoneAuth = (value: PendingPhoneAuth | null) => {
    try { savePendingPhoneAuth(window.sessionStorage, value); } catch { /* Storage may be disabled. */ }
  };

  useEffect(() => {
    try {
      savePendingPhoneAuth(window.sessionStorage, method === "phone" && phoneChallenge && !phoneExpired
        ? { intent: mode, returnTo, role, phone: phone.trim(), challenge: phoneChallenge, resendAt: phoneResendAt }
        : null);
    } catch { /* Verification can continue without storage. */ }
  }, [method, mode, returnTo, role, phone, phoneChallenge, phoneExpired, phoneResendAt]);
  const loginAccount = method !== "phone" ? email.trim().toLowerCase() : phone.trim();
  const loginAccountValid = method !== "phone"
    ? loginAccount.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(loginAccount)
    : /^1[3-9]\d{9}$/u.test(loginAccount);
  const eligibilityKey = `${method}:${loginAccount}:${eligibilityAttempt}`;
  const eligibilityStatus = !loginAccountValid ? "idle"
    : eligibility?.key === eligibilityKey ? eligibility.status : "checking";
  const canSendAuth = isSignup || eligibilityStatus === "registered";

  useEffect(() => {
    if (isSignup || !loginAccountValid) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void checkLoginEligibility(method === "phone" ? "phone" : "email", loginAccount, controller.signal).then((registered) => {
        if (!controller.signal.aborted) setEligibility({ key: eligibilityKey, status: registered ? "registered" : "unregistered" });
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && ["INVALID_EMAIL", "INVALID_PHONE"].includes(error.code)) {
          setEligibility({ key: eligibilityKey, status: "invalid" });
          setErrors((current) => ({ ...current, [method === "phone" ? "phone" : "email"]: error.message }));
        } else {
          setEligibility({ key: eligibilityKey, status: "error" });
        }
      });
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isSignup, loginAccountValid, loginAccount, method, eligibilityKey]);

  useEffect(() => {
    let active = true;
    setMethodsFailed(false);
    void loadAuthMethods().then((methods) => {
      if (active) {
        setPhoneAvailable(methods.phone.available);
        setEmailAvailable(methods.email.available);
        if (isSignup && !methods.email.available && methods.phone.available) setMethod("phone");
      }
    }).catch(() => {
      if (active) {
        setPhoneAvailable(null);
        setEmailAvailable(null);
        setMethodsFailed(true);
      }
    });
    return () => { active = false; };
  }, [methodsAttempt, isSignup]);

  useEffect(() => {
    if (!phoneChallenge && !phoneResendAt) return;
    const timer = window.setInterval(() => setPhoneClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [phoneChallenge, phoneResendAt]);

  useEffect(() => () => {
    requestRevisionRef.current += 1;
    if (resendTimerRef.current !== null) window.clearTimeout(resendTimerRef.current);
    if (linkExpiryTimerRef.current !== null) window.clearTimeout(linkExpiryTimerRef.current);
  }, []);

  const validateEmail = (input: HTMLInputElement) => {
    const error = !input.value.trim()
      ? "请输入邮箱地址。"
      : input.value.trim().length > 254
        ? "邮箱地址不能超过 254 个字符。"
      : input.validity.typeMismatch
        ? "请输入有效的邮箱地址。"
        : !isSignup && eligibilityStatus === "invalid"
          ? errors.email
        : undefined;
    setErrors((current) => ({ ...current, email: error }));
    return !error;
  };

  const resetEmailFeedback = () => {
    requestRevisionRef.current += 1;
    setEmailDelivery(null);
    setSentEmailDetails(null);
    setResendReady(false);
    if (resendTimerRef.current !== null) window.clearTimeout(resendTimerRef.current);
    if (linkExpiryTimerRef.current !== null) window.clearTimeout(linkExpiryTimerRef.current);
    setErrors({});
  };

  const resetPhoneFeedback = (clearCode = true) => {
    requestRevisionRef.current += 1;
    persistPhoneAuth(null);
    setPhoneChallenge(null);
    setPhoneResendAt(0);
    if (clearCode) setCode("");
    setErrors({});
  };

  const changeAuthIdentity = () => {
    setPassword("");
    setEligibility(null);
    setEligibilityAttempt((attempt) => attempt + 1);
    resetEmailFeedback();
    resetPhoneFeedback();
  };

  const linkValidityLabel = sentEmailDetails
    ? authValidityLabel(sentEmailDetails.expiresInSeconds)
    : "";

  const sendEmail = async (form: HTMLFormElement) => {
    if (submissionInFlightRef.current || resendCoolingDown || emailAvailable !== true || !canSendAuth) return;
    const emailInput = form.elements.namedItem("email") as HTMLInputElement;
    const isEmailValid = validateEmail(emailInput);
    if (!isEmailValid) {
      emailInput.focus();
      return;
    }
    const submittedEmail = emailInput.value.trim();
    submissionInFlightRef.current = true;
    resetEmailFeedback();
    const revision = requestRevisionRef.current;
    setIsSubmitting(true);
    try {
      const response = await requestEmailAuth({
        email: submittedEmail,
        intent: isSignup ? "signup" : "login",
        ...(isSignup ? { role: role === "talent" ? "talent" : "client" } : {}),
        returnTo: isSignup && setupAfterSignup ? passwordSetupReturnTo : returnTo,
      });
      if (revision !== requestRevisionRef.current) return;
      setEmailDelivery(response.delivery);
      setSentEmailDetails(response.delivery === "email" ? { email: submittedEmail, expiresInSeconds: response.expiresInSeconds } : null);
      setResendReady(false);
      if (resendTimerRef.current !== null) window.clearTimeout(resendTimerRef.current);
      if (linkExpiryTimerRef.current !== null) window.clearTimeout(linkExpiryTimerRef.current);
      linkExpiryTimerRef.current = null;
      resendTimerRef.current = window.setTimeout(() => {
        if (revision === requestRevisionRef.current) setResendReady(true);
      }, response.resendAfterSeconds * 1000);
      if (response.delivery === "email") {
        linkExpiryTimerRef.current = window.setTimeout(() => {
          if (revision !== requestRevisionRef.current) return;
          setEmailDelivery(null);
          setSentEmailDetails(null);
          setResendReady(false);
          setErrors((current) => ({ ...current, submit: "验证链接已过期，请重新发送邮件。" }));
        }, response.expiresInSeconds * 1000);
      }
      setErrors({});
    } catch (error) {
      if (revision !== requestRevisionRef.current) return;
      if (error instanceof ApiError && error.code === "EMAIL_AUTH_DISABLED") setEmailAvailable(false);
      if (!isSignup && error instanceof ApiError && error.code === "ACCOUNT_NOT_REGISTERED") {
        setEligibility({ key: eligibilityKey, status: "unregistered" });
        setErrors({});
        return;
      }
      setErrors((current) => ({ ...current, submit: error instanceof Error ? error.message : "验证邮件发送失败，请稍后重试。" }));
    } finally {
      if (revision === requestRevisionRef.current) {
        submissionInFlightRef.current = false;
        setIsSubmitting(false);
      }
    }
  };

  const sendPhone = async () => {
    if (submissionInFlightRef.current || phoneAvailable !== true || Date.now() < phoneResendAt || !canSendAuth) return;
    // This form accepts a mainland mobile number; country selection is intentionally fixed to +86.
    if (!/^1[3-9]\d{9}$/u.test(phone.trim())) {
      setErrors({ phone: "请输入 11 位中国大陆手机号。" });
      document.getElementById("auth-phone")?.focus();
      return;
    }
    submissionInFlightRef.current = true;
    // Rate-limit rejection happens before the server supersedes the existing challenge.
    // Keep it until the response tells us whether a resend was actually attempted.
    const revision = ++requestRevisionRef.current;
    setErrors({});
    setIsSubmitting(true);
    try {
      const response = await requestPhoneAuth({
        phone: phone.trim(), intent: mode, ...(isSignup ? { role } : {}), returnTo,
      });
      if (revision !== requestRevisionRef.current) return;
      const now = Date.now();
      setPhoneClock(now);
      setPhoneChallenge({ id: response.challengeId, expiresAt: now + response.expiresInSeconds * 1000, expiresInSeconds: response.expiresInSeconds });
      setPhoneResendAt(now + response.resendAfterSeconds * 1000);
      setCode("");
      setErrors({});
    } catch (error) {
      if (revision !== requestRevisionRef.current) return;
      if (error instanceof ApiError && error.status === 429 && error.code === "RATE_LIMITED") {
        const now = Date.now();
        setPhoneClock(now);
        setPhoneResendAt(now + Math.max(1, error.retryAfterSeconds ?? 60) * 1000);
        const canUseExistingCode = phoneChallenge && phoneChallenge.expiresAt > now;
        setErrors({ submit: canUseExistingCode
          ? "暂时不能重新发送。已收到的验证码仍可在有效期内提交，请在下方输入并验证。"
          : "短信发送过于频繁，请等待下方倒计时结束后再试。" });
        return;
      }
      // Unknown send outcomes may have superseded the previous server challenge.
      persistPhoneAuth(null);
      setPhoneChallenge(null);
      if (error instanceof ApiError && error.code === "PHONE_AUTH_UNAVAILABLE") setPhoneAvailable(false);
      if (!isSignup && error instanceof ApiError && error.code === "ACCOUNT_NOT_REGISTERED") {
        setEligibility({ key: eligibilityKey, status: "unregistered" });
        setErrors({});
        return;
      }
      setErrors({ submit: error instanceof Error ? error.message : "验证码申请发送失败，请稍后重试。" });
    } finally {
      if (revision === requestRevisionRef.current) {
        submissionInFlightRef.current = false;
        setIsSubmitting(false);
      }
    }
  };

  const verifyPhone = async () => {
    if (submissionInFlightRef.current || !phoneChallenge) return;
    if (Date.now() >= phoneChallenge.expiresAt) {
      setPhoneClock(Date.now());
      return;
    }
    if (!/^\d{6}$/u.test(code.trim())) {
      setErrors({ code: "请输入 6 位短信验证码。" });
      document.getElementById("auth-phone-code")?.focus();
      return;
    }
    submissionInFlightRef.current = true;
    const revision = ++requestRevisionRef.current;
    setIsVerifyingPhone(true);
    setErrors({});
    try {
      const result = await completePhoneAuth(phoneChallenge.id, code.trim());
      if (revision !== requestRevisionRef.current) return;
      persistPhoneAuth(null);
      setPhoneChallenge(null);
      if (result.authenticated) {
        window.location.replace(normalizeReturnTo(result.returnTo));
      } else {
        const params = new URLSearchParams({ method: "phone", authError: "phone_account_not_found", returnTo: normalizeReturnTo(result.returnTo) });
        window.location.replace(`/signup?${params.toString()}`);
      }
    } catch (error) {
      if (revision !== requestRevisionRef.current) return;
      if (error instanceof ApiError && ["INVALID_OR_EXPIRED_CODE", "BROWSER_CONTEXT_REQUIRED"].includes(error.code)) {
        setPhoneChallenge(null);
      }
      setErrors({ submit: error instanceof Error ? error.message : "验证码验证失败，请稍后重试。" });
    } finally {
      if (revision === requestRevisionRef.current) {
        submissionInFlightRef.current = false;
        setIsVerifyingPhone(false);
      }
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (method === "password") {
      if (submissionInFlightRef.current || !canSendAuth || !password) return;
      submissionInFlightRef.current = true;
      const revision = ++requestRevisionRef.current;
      setIsSubmitting(true); setErrors({});
      try {
        const result = await loginWithPassword(email.trim(), password, returnTo);
        if (revision === requestRevisionRef.current) { setPassword(""); window.location.replace(normalizeReturnTo(result.returnTo)); }
      } catch (error) {
        if (revision === requestRevisionRef.current) setErrors({ submit: error instanceof Error ? error.message : "登录失败，请重试。" });
      } finally {
        if (revision === requestRevisionRef.current) { submissionInFlightRef.current = false; setIsSubmitting(false); }
      }
    } else if (method === "email") await sendEmail(event.currentTarget);
    else if (phoneChallenge) await verifyPhone();
    else await sendPhone();
  };

  const eligibilityFeedback = !isSignup && !["idle", "registered", "invalid"].includes(eligibilityStatus) ? (
    <div id="auth-login-eligibility" className="auth-login-eligibility" aria-live="polite">
      {eligibilityStatus === "checking" ? <p>正在检查账号是否已注册…</p>
        : eligibilityStatus === "unregistered" ? <>
          <p>该{method !== "phone" ? "邮箱" : "手机号"}尚未注册，请先注册账户。</p>
          <a href={`${buildAuthHref("signup", returnTo)}${method === "phone" ? "&method=phone" : ""}`}>去注册<ArrowRight size={15} aria-hidden="true" /></a>
        </> : <>
          <p>暂时无法确认账号是否已注册，请重新检查。</p>
          <button type="button" onClick={() => setEligibilityAttempt((attempt) => attempt + 1)}>重新检查账号</button>
        </>}
    </div>
  ) : null;

  return (
    <section className="auth-page">
      <div className="auth-story">
        <Fingerprint size={34} weight="duotone" aria-hidden="true" />
        <div>
          <p>{isSignup ? "建立你的 DuduHire 账户" : "欢迎回到 DuduHire"}</p>
          <h1 className={!isSignup ? "auth-story-title-login" : role === "talent" ? "auth-story-title-talent" : undefined}>{storyCopy.title}</h1>
          <span>{storyCopy.description}</span>
        </div>
      </div>
      <div className="auth-panel">
        <div className="auth-heading">
          <h2>{isSignup ? "免费注册" : "登录"}</h2>
          <p>{isSignup ? "已有账户？" : "还没有账户？"} <a href={`${buildAuthHref(isSignup ? "login" : "signup", returnTo)}${method === "phone" ? "&method=phone" : ""}`}>{isSignup ? "直接登录" : "免费注册"}</a></p>
        </div>
        <form onSubmit={handleSubmit} aria-busy={phoneBusy} noValidate>
          <fieldset disabled={phoneBusy}>
            <legend>{isSignup ? "注册方式" : "登录方式"}</legend>
            {!isSignup && <label><input type="radio" name="method" value="password" checked={method === "password"} onChange={() => { changeAuthIdentity(); setMethod("password"); }} />密码登录</label>}
            <label><input type="radio" name="method" value="email" checked={method === "email"} disabled={emailAvailable === false} onChange={() => { changeAuthIdentity(); setMethod("email"); }} />邮件链接{emailAvailable === false ? "（暂不可用）" : ""}</label>
            <label><input type="radio" name="method" value="phone" checked={method === "phone"} onChange={() => { changeAuthIdentity(); setMethod("phone"); }} />手机短信</label>
          </fieldset>
          {method === "email" && emailAvailable === false && <p className="auth-role-description" id="auth-email-service">邮箱注册与登录暂未启用。{phoneAvailable === true ? "请使用手机短信继续。" : "请稍后再试或联系管理员。"}</p>}
          {method !== "password" && methodsFailed && <>
            <p className="auth-field-error" role="alert">暂时无法确认注册与登录服务状态，请稍后重试。</p>
            <button className="button button-ghost" type="button" onClick={() => setMethodsAttempt((attempt) => attempt + 1)}>重新检查</button>
          </>}
          {isSignup && (
            <fieldset disabled={phoneBusy} aria-describedby="auth-role-description">
              <legend>选择先使用的身份</legend>
              <label><input type="radio" name="role" value="client" checked={role === "client"} onChange={() => { changeAuthIdentity(); setRole("client"); }} />需求方：我有一个需求</label>
              <label><input type="radio" name="role" value="talent" checked={role === "talent"} onChange={() => { changeAuthIdentity(); setRole("talent"); }} />能力方：我想展示能力</label>
              <p className="auth-role-description" id="auth-role-description">一个账户同时具备需求方和能力方身份，注册后可随时切换。已注册的{method === "phone" ? "手机号" : "邮箱"}验证后将登录原账户，登录后可切换使用身份。</p>
            </fieldset>
          )}
          {method === "password" ? <>
            {authParams.get("passwordSaved") === "true" && <p role="status">密码已保存，请使用新密码登录。</p>}
            <label htmlFor="password-email">邮箱 <span aria-hidden="true">*</span></label>
            <input id="password-email" type="email" autoComplete="username" autoCapitalize="none" maxLength={254} value={email} disabled={phoneBusy} onChange={event => { resetEmailFeedback(); setEmail(event.target.value); setEligibilityAttempt(value => value + 1); }} aria-describedby={eligibilityFeedback ? "auth-login-eligibility" : errors.email ? "password-email-error" : undefined} aria-invalid={Boolean(errors.email) || eligibilityStatus === "unregistered"} />
            {errors.email && <p className="auth-field-error" id="password-email-error" role="alert">{errors.email}</p>}
            {eligibilityFeedback}
            <label htmlFor="login-password">密码 <span aria-hidden="true">*</span></label>
            <input id="login-password" type="password" autoComplete="current-password" maxLength={128} value={password} disabled={phoneBusy} onChange={event => { setPassword(event.target.value); setErrors(current => ({ ...current, submit: undefined })); }} />
            {errors.submit && <p className="auth-field-error" role="alert">{errors.submit}</p>}
            <a className="auth-password-link" href={`${buildAuthHref("login", passwordSetupReturnTo)}&method=email`}>首次设置密码 / 忘记密码</a>
            <button className="button button-primary button-large" type="submit" disabled={phoneBusy || !canSendAuth || !password}>{phoneBusy ? "正在登录…" : "登录"}<ArrowRight size={19} /></button>
          </> : method === "email" ? <>
          <label htmlFor="auth-email">邮箱 <span aria-hidden="true">*</span></label>
          <input id="auth-email" name="email" type="email" inputMode="email" autoCapitalize="none" autoComplete="email" maxLength={254} value={email} required disabled={isSubmitting || emailAvailable !== true} placeholder="name@company.com" aria-invalid={Boolean(errors.email) || (!isSignup && eligibilityStatus === "unregistered")} aria-describedby={eligibilityFeedback ? "auth-login-eligibility" : errors.email ? "auth-email-error" : emailAvailable === false ? "auth-email-service" : !isSubmitting && emailDelivery ? emailSent ? "auth-email-sent" : "auth-email-development" : undefined} onBlur={(event) => validateEmail(event.currentTarget)} onChange={(event) => { resetEmailFeedback(); setEmail(event.target.value); setEligibilityAttempt((attempt) => attempt + 1); }} />
          {errors.email && <p className="auth-field-error" id="auth-email-error" role="alert">{errors.email}</p>}
          {eligibilityFeedback}
          {!isSignup && new URL(returnTo, window.location.origin).pathname === "/account/password" && <p className="auth-role-description">先发送验证邮件，在当前浏览器打开链接后即可设置新密码。</p>}
          {isSignup && <label className="auth-password-option"><input type="checkbox" checked={setupAfterSignup} onChange={event => setSetupAfterSignup(event.target.checked)} disabled={phoneBusy} />验证后设置登录密码</label>}
          {errors.submit && <p className="auth-field-error" role="alert">{errors.submit}</p>}
          {emailDelivery === "development" && !isSubmitting && (
            <p className="auth-field-error" id="auth-email-development" role="alert">当前为开发演练，未发送真实验证邮件。请联系管理员启用邮件发送服务后再试。</p>
          )}
          {emailSent && sentEmailDetails && !isSubmitting && (
            <div className="auth-heading" id="auth-email-sent" role="status">
              <p>验证邮件已发送至 {sentEmailDetails.email}。请使用发起申请的同一浏览器打开邮件中的链接，链接有效期为 {linkValidityLabel}。</p>
              <p>如果暂未收到，请检查垃圾邮件；稍后可点击“重新发送”。</p>
            </div>
          )}
          <button className="button button-primary button-large" type="submit" disabled={isSubmitting || resendCoolingDown || emailAvailable !== true || !canSendAuth} aria-busy={isSubmitting} aria-live="polite">{isSubmitting ? "正在发送…" : emailAvailable === false ? "邮箱暂不可用" : emailAvailable === null && !methodsFailed ? "正在确认服务…" : emailDelivery === "development" ? resendReady ? "重试" : "稍后重试" : emailSent ? resendReady ? "重新发送" : "请检查邮箱" : isSignup ? "创建账户" : "登录"}{!isSubmitting && !resendCoolingDown && <ArrowRight size={19} weight="bold" />}</button>
          </> : <>
            <label htmlFor="auth-phone">中国大陆手机号 <span aria-hidden="true">*</span></label>
            <input id="auth-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel-national" maxLength={11} value={phone} required disabled={phoneBusy} placeholder="11 位手机号（+86）" aria-invalid={Boolean(errors.phone) || (!isSignup && eligibilityStatus === "unregistered")} aria-describedby={eligibilityFeedback ? "auth-login-eligibility" : errors.phone ? "auth-phone-error" : "auth-phone-service"} onChange={(event) => { resetPhoneFeedback(); setPhone(event.target.value); setEligibilityAttempt((attempt) => attempt + 1); }} />
            {errors.phone && <p className="auth-field-error" id="auth-phone-error" role="alert">{errors.phone}</p>}
            {eligibilityFeedback}
            <p className="auth-role-description" id="auth-phone-service">{phoneAvailable === true ? "使用短信验证码验证手机号。" : phoneAvailable === false ? emailAvailable === true ? "手机号验证暂不可用，请选择邮件链接继续。" : "手机号验证暂不可用，请稍后再试或联系管理员。" : methodsFailed ? "请重新检查服务状态后再申请验证码。" : "正在确认手机号验证服务状态…"}</p>
            <label htmlFor="auth-phone-code">验证码 <span aria-hidden="true">*</span></label>
            <input id="auth-phone-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} disabled={phoneBusy || phoneAvailable !== true} placeholder="6 位短信验证码" aria-invalid={Boolean(errors.code)} aria-describedby={errors.code ? "auth-code-error" : phoneExpired ? "auth-phone-expired" : undefined} onChange={(event) => { setCode(event.target.value); setErrors((current) => ({ ...current, code: undefined })); }} />
            {errors.code && <p className="auth-field-error" id="auth-code-error" role="alert">{errors.code}</p>}
            {errors.submit && <p className="auth-field-error" role="alert">{errors.submit}</p>}
            {phoneExpired && !phoneBusy && <p className="auth-field-error" id="auth-phone-expired" role="alert">验证码已过期，请重新申请发送。</p>}
            {phoneChallenge && !phoneExpired && !phoneBusy && <div className="auth-heading" role="status"><p>验证码已申请发送，有效期 {authValidityLabel(phoneChallenge.expiresInSeconds)}。如未收到，请核对号码并检查短信拦截；倒计时结束后可重新申请。</p></div>}
            <button className="button button-ghost button-large" type="button" disabled={phoneBusy || phoneAvailable !== true || phoneResendSeconds > 0 || !canSendAuth} aria-busy={isSubmitting} onClick={() => void sendPhone()}>{isSubmitting ? "正在申请发送…" : phoneResendSeconds > 0 ? `${phoneResendSeconds} 秒后可重新发送` : phoneChallenge || phoneResendAt ? "重新发送验证码" : "发送验证码"}</button>
            <button className="button button-primary button-large" type="submit" disabled={phoneBusy || phoneAvailable !== true || !phoneChallenge || phoneExpired} aria-busy={isVerifyingPhone}>{isVerifyingPhone ? "正在验证…" : isSignup ? "验证并创建账户" : "验证并登录"}{!phoneBusy && <ArrowRight size={19} weight="bold" />}</button>
          </>}
        </form>
      </div>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section className="not-found-page">
      <FileMagnifyingGlass size={48} weight="duotone" aria-hidden="true" />
      <p>页面未找到</p>
      <h1>这里没有你要找的内容</h1>
      <a className="button button-primary button-large" href="/">返回首页<ArrowRight size={19} weight="bold" /></a>
    </section>
  );
}
