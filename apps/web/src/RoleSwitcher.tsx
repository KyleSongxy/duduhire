import { ArrowsLeftRight } from "@phosphor-icons/react/ArrowsLeftRight";
import type { AuthRole } from "./auth";

export type RoleSwitchProps = {
  role: AuthRole;
  switching: boolean;
  error: string;
  onSwitch: () => void;
};

export function RoleSwitcher({ role, switching, error, onSwitch }: RoleSwitchProps) {
  return (
    <div className="role-switcher">
      <span className="role-switcher-current">当前：{role === "client" ? "需求方" : "能力方"}</span>
      <button className="role-switcher-button" type="button" disabled={switching} aria-busy={switching} onClick={onSwitch}>
        <ArrowsLeftRight size={16} weight="bold" aria-hidden="true" />
        {switching ? "切换中…" : `切换为${role === "client" ? "能力方" : "需求方"}`}
      </button>
      {error && <p className="role-switcher-error" role="alert">{error}</p>}
    </div>
  );
}
