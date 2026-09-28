"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/lib/i18n/navigation";
import { ListItem } from "@/components/ui/ListItem";
import ThemeToggle from "@/components/theme/ThemeToggle";
import LocaleQuickPicker from "@/components/i18n/LocaleQuickPicker";
import { isEnabledClient } from "@/lib/feature-flags-client";
import { LEGAL_LINKS, type ViewerRole } from "@/lib/nav/modules";
import { buildMenuSections, matchesRoute } from "@/lib/nav/visibility";
import { SUPPORT_EMAIL } from "@/lib/contact";

/** Grupurile meniului + setări (temă, limbă), linkuri legale. */
export default function AppMenuSections({ roles }: { roles: Set<ViewerRole> }) {
  const t = useTranslations("appMenu");
  const pathname = usePathname();
  const sections = buildMenuSections(roles, isEnabledClient);

  return (
    <nav aria-label={t("title")} className="space-y-4">
      {sections.map((section) => (
        <section key={section.group} aria-labelledby={`menu-group-${section.group}`}>
          <h2
            id={`menu-group-${section.group}`}
            className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-subtle"
          >
            {t(`groups.${section.group}`)}
          </h2>
          <div className="space-y-0.5">
            {section.entries.map(({ module, mode }) =>
              mode === "become" && module.become ? (
                <ListItem
                  key={module.id}
                  href={module.become.route}
                  icon={module.icon}
                  title={t(`become.${module.become.labelKey}`)}
                  subtitle={t(`items.${module.labelKey}`)}
                />
              ) : (
                <ListItem
                  key={module.id}
                  href={module.route}
                  icon={module.icon}
                  title={t(`items.${module.labelKey}`)}
                  active={matchesRoute(pathname, module.route)}
                />
              ),
            )}
          </div>
          {section.group === "settings" ? <SettingsExtras /> : null}
        </section>
      ))}
      <LegalFooter />
    </nav>
  );
}

function SettingsExtras() {
  const t = useTranslations("appMenu");
  return (
    <div className="mt-2 space-y-3 px-3">
      <div>
        <p className="pb-1.5 text-xs font-medium text-muted">{t("theme.label")}</p>
        <ThemeToggle />
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted">{t("language")}</p>
        <LocaleQuickPicker variant="light" />
      </div>
    </div>
  );
}

function LegalFooter() {
  const t = useTranslations("appMenu");
  return (
    <footer className="border-t border-subtle px-3 pt-4">
      <ul className="grid grid-cols-2 gap-1">
        {LEGAL_LINKS.map((l) => (
          <li key={l.key}>
            {l.route ? (
              <Link
                href={l.route}
                className="flex min-h-11 items-center rounded-control px-2 text-xs font-medium text-muted hover:bg-surface-2"
              >
                {t(`legal.${l.key}`)}
              </Link>
            ) : (
              <a
                href={l.externalHref}
                target="_blank"
                rel="noreferrer"
                className="flex min-h-11 items-center rounded-control px-2 text-xs font-medium text-muted hover:bg-surface-2"
              >
                {t(`legal.${l.key}`)}
              </a>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-subtle">
        {t("copyright", { year: new Date().getFullYear() })}
        <span className="block">{SUPPORT_EMAIL}</span>
      </p>
    </footer>
  );
}
