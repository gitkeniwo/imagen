import { type ButtonHTMLAttributes, forwardRef, type ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

type Variant = "secondary" | "primary" | "ghost" | "danger" | "link";

const VARIANT_CLASS: Record<Variant, string> = {
  secondary: "",
  primary: "primary",
  ghost: "ghost-btn",
  danger: "danger-btn",
  link: "link-btn",
};

function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  variant?: Variant;
  size?: "sm" | "md";
  icon?: IconName;
  children?: ReactNode;
};

// Text button with an optional leading icon. Variants map onto the existing
// global button styles so screens that still use bare <button> look the same.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("btn", VARIANT_CLASS[variant], size === "sm" && "btn-sm", className)}
      {...rest}
    >
      {icon && <Icon name={icon} size="sm" />}
      {children}
    </button>
  );
});

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "title"> & {
  icon: IconName;
  // Required: an icon-only button must say what it does (tooltip + screen reader).
  label: string;
  variant?: "ghost" | "outline" | "overlay";
  size?: "sm" | "md" | "lg";
  filled?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = "ghost", size = "sm", filled, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      className={cx("icon-button", `icon-button-${variant}`, `icon-button-${size}`, className)}
      {...rest}
    >
      <Icon name={icon} size={size === "lg" ? "lg" : size === "md" ? "md" : "sm"} filled={filled} />
    </button>
  );
});
