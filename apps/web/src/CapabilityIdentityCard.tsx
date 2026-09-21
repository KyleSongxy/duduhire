import { useEffect, useId, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { CheckCircle } from "@phosphor-icons/react/CheckCircle";

export type CapabilityIdentityProfile = {
  id: string;
  name: string;
  title: string;
  location: string;
  initials: string;
  statusLabel: string;
  footerLabel: string;
  footerValue: string;
};

type HeatPoint = {
  x: number;
  y: number;
  bornAt: number;
};

export function CapabilityIdentityCard({ profile }: { profile: CapabilityIdentityProfile }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const heatPointsRef = useRef<HeatPoint[]>([]);
  const heatTargetRef = useRef({ x: 0, y: 0, active: false });
  const startHeatRef = useRef<() => void>(() => undefined);
  const lanyardId = useId().replace(/:/g, "");
  const lanyardFabricId = `capability-lanyard-fabric-${lanyardId}`;
  const lanyardShadowId = `capability-lanyard-shadow-${lanyardId}`;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let frameId: number | null = null;
    let lastEmitAt = 0;
    let canvasWidth = 0;
    let canvasHeight = 0;

    const syncCanvasSize = () => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvasWidth = bounds.width;
      canvasHeight = bounds.height;
      canvas.width = Math.round(canvasWidth * pixelRatio);
      canvas.height = Math.round(canvasHeight * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const drawFrame = (now: number) => {
      const target = heatTargetRef.current;
      if (target.active && now - lastEmitAt >= 70) {
        heatPointsRef.current.push({ x: target.x, y: target.y, bornAt: now });
        heatPointsRef.current = heatPointsRef.current.slice(-30);
        lastEmitAt = now;
      }

      const lifespan = 1500;
      heatPointsRef.current = heatPointsRef.current.filter((point) => now - point.bornAt < lifespan);
      context.clearRect(0, 0, canvasWidth, canvasHeight);
      context.globalCompositeOperation = "screen";

      heatPointsRef.current.forEach((point) => {
        const progress = Math.min(1, (now - point.bornAt) / lifespan);
        const strength = Math.pow(1 - progress, 1.35) * 0.058;
        const radius = 62 + Math.min(1, (now - point.bornAt) / 420) * 22;
        const gradient = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
        gradient.addColorStop(0, `rgba(255, 66, 28, ${strength * 1.75})`);
        gradient.addColorStop(0.34, `rgba(255, 128, 28, ${strength * 1.55})`);
        gradient.addColorStop(0.55, `rgba(255, 231, 97, ${strength * 1.2})`);
        gradient.addColorStop(0.73, `rgba(48, 132, 255, ${strength * 1.35})`);
        gradient.addColorStop(1, "rgba(31, 75, 255, 0)");
        context.fillStyle = gradient;
        context.fillRect(point.x - radius, point.y - radius, radius * 2, radius * 2);
      });

      context.globalCompositeOperation = "source-over";
      if (target.active || heatPointsRef.current.length) {
        frameId = window.requestAnimationFrame(drawFrame);
      } else {
        frameId = null;
      }
    };

    startHeatRef.current = () => {
      if (frameId === null) frameId = window.requestAnimationFrame(drawFrame);
    };

    syncCanvasSize();
    const resizeObserver = new ResizeObserver(syncCanvasSize);
    resizeObserver.observe(canvas);
    return () => {
      resizeObserver.disconnect();
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      heatPointsRef.current = [];
      startHeatRef.current = () => undefined;
    };
  }, []);

  const updateHeatTarget = (event: ReactPointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    heatTargetRef.current = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      active: true,
    };
    startHeatRef.current();
  };

  const releaseHeatTarget = () => {
    heatTargetRef.current.active = false;
    startHeatRef.current();
  };

  return (
    <div className="capability-id-stage">
      <div className="capability-id-lanyard" aria-hidden="true">
        <svg viewBox="0 0 150 138" focusable="false">
          <defs>
            <linearGradient id={lanyardFabricId} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#17211c" />
              <stop offset="18%" stopColor="#334239" />
              <stop offset="47%" stopColor="#6e7d73" />
              <stop offset="72%" stopColor="#3c4c43" />
              <stop offset="100%" stopColor="#15201a" />
            </linearGradient>
            <filter id={lanyardShadowId} x="-35%" y="-20%" width="170%" height="160%">
              <feDropShadow dx="0" dy="5" stdDeviation="4" floodColor="#07100b" floodOpacity="0.38" />
            </filter>
          </defs>
          <g filter={`url(#${lanyardShadowId})`}>
            <path className="capability-id-lanyard-band" stroke={`url(#${lanyardFabricId})`} d="M 25 4 C 27 15, 31 31, 37 52 C 43 74, 52 97, 66 116" />
            <path className="capability-id-lanyard-weave" d="M 25 4 C 27 15, 31 31, 37 52 C 43 74, 52 97, 66 116" />
            <path className="capability-id-lanyard-edge" transform="translate(-7 0)" d="M 25 4 C 27 15, 31 31, 37 52 C 43 74, 52 97, 66 116" />

            <path className="capability-id-lanyard-band" stroke={`url(#${lanyardFabricId})`} d="M 126 7 C 123 18, 118 36, 113 57 C 107 78, 97 101, 83 116" />
            <path className="capability-id-lanyard-weave" d="M 126 7 C 123 18, 118 36, 113 57 C 107 78, 97 101, 83 116" />
            <path className="capability-id-lanyard-edge" transform="translate(7 0)" d="M 126 7 C 123 18, 118 36, 113 57 C 107 78, 97 101, 83 116" />
          </g>
        </svg>
        <span className="capability-id-lanyard-clip"><i /><b /></span>
      </div>
      <article
        className="capability-id-card"
        aria-label={`${profile.name}的能力身份卡，${profile.statusLabel}`}
        tabIndex={0}
        onPointerEnter={updateHeatTarget}
        onPointerMove={updateHeatTarget}
        onPointerLeave={releaseHeatTarget}
        onPointerCancel={releaseHeatTarget}
      >
        <canvas ref={canvasRef} className="capability-id-heatmap" aria-hidden="true" />
        <span className="capability-id-glass" aria-hidden="true" />
        <div className="capability-id-content">
          <header><strong>DUDUHIRE</strong><span>NO {profile.id.slice(0, 2).toUpperCase()}427</span></header>
          <p className="capability-id-session">CAPABILITY PROFILE · 2026</p>
          <div className="capability-id-name"><h3>{profile.name}</h3><span>{profile.initials}</span></div>
          <p className="capability-id-origin">FROM · {profile.location.toUpperCase()}</p>
          <div className="capability-id-status"><span><CheckCircle size={14} weight="fill" />{profile.statusLabel}</span><small>{profile.title}</small></div>
          <div className="capability-id-barcode" aria-hidden="true" />
          <footer><span>{profile.footerLabel}</span><strong>{profile.footerValue}</strong></footer>
        </div>
      </article>
    </div>
  );
}
