import { useI18n } from "../../i18n";
import Icon from "./Icon";

export type Role = "owner" | "admin" | "member";

export default function RoleBadge({
  role,
  className,
}: {
  role: Role;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <span className={`role-badge ${role}${className ? ` ${className}` : ""}`}>
      <Icon name={role === "owner" ? "key" : role === "admin" ? "shield" : "user"} size="sm" />
      {t(`remote_role_${role}`)}
    </span>
  );
}
