"use client";

import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton, type IconButtonProps } from "@/components/ui/IconButton";
import { useAppMenu } from "./AppMenuProvider";

type Props = Pick<IconButtonProps, "variant" | "size" | "className">;

/** Butonul ☰ care deschide meniul aplicației. Pune-l în stânga oricărui header. */
export default function AppMenuButton({ variant = "ghost", size = "md", className }: Props) {
  const t = useTranslations("nav");
  const menu = useAppMenu();
  if (!menu) return null;
  return (
    <IconButton
      label={t("openMenu")}
      variant={variant}
      size={size}
      className={className}
      aria-haspopup="dialog"
      aria-expanded={menu.open}
      onClick={() => menu.setOpen(true)}
    >
      <Menu aria-hidden />
    </IconButton>
  );
}
