"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ActionDialog } from "@/components/admin/ActionDialog";
import { Field } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { ADMIN_ROLES, type AdminRole } from "@/lib/admin/permissions";

/** Durate de suspendare oferite (zile); 36500 = permanent. */
const SUSPEND_DAYS = [1, 7, 30, 36500] as const;
const ACCOUNT_ROLES = ["shopper", "creator", "seller", "admin"] as const;

type Props = {
  userId: string;
  username: string;
  role: string;
  adminRole: string | null;
  isSuspended: boolean;
  /** Adminul curent poate acorda/retrage roluri de admin (owner). */
  canManageAdmins: boolean;
  isSelf: boolean;
};

export default function UserActions({ userId, username, role, adminRole, isSuspended, canManageAdmins, isSelf }: Props) {
  const t = useTranslations("adminUsers");
  const tc = useTranslations("adminConsole.users");
  const ts = useTranslations("adminShell");
  const [days, setDays] = useState<number>(7);
  const [newRole, setNewRole] = useState<string>(role);
  const [newAdminRole, setNewAdminRole] = useState<AdminRole>((adminRole as AdminRole) ?? "support");

  const errors: Record<string, string> = {
    forbidden: t("errForbidden"),
    unauthorized: t("errForbidden"),
    invalid_id: t("errInvalidId"),
    invalid_role: t("errInvalidRole"),
    user_not_found: t("errUserNotFound"),
    cannot_demote_self: t("errCannotDemoteSelf"),
    last_admin_lockout: t("errLastAdminLockout"),
    role_change_failed: t("errRoleChangeFailed"),
    cannot_suspend_admin: tc("errCannotSuspendAdmin"),
    reason_required: tc("errReasonRequired"),
    last_owner_lockout: tc("errLastOwner"),
    cannot_change_own_role: tc("errOwnRole"),
  };
  const durationLabel = (d: number) => (d >= 36500 ? t("suspendPermanent") : t("daysCount", { count: d }));
  const roleOptions = ACCOUNT_ROLES.filter((r) => r !== "admin" || canManageAdmins || role === "admin").map((r) => ({
    value: r,
    label: tc(`accountRole.${r}`),
  }));
  const adminRoleOptions = ADMIN_ROLES.map((r) => ({ value: r, label: ts(`role.${r}`) }));
  const adminLocked = role === "admin" && !canManageAdmins;

  return (
    <>
      {isSuspended ? (
        <ActionDialog
          label={t("liftSuspension")}
          title={t("liftSuspension")}
          description={t("confirmUnsuspend", { username })}
          confirmLabel={t("liftSuspension")}
          url={`/api/admin/users/${userId}/unsuspend`}
          errors={errors}
          successMessage={tc("unsuspendedToast")}
        />
      ) : role !== "admin" ? (
        <ActionDialog
          label={t("suspendSectionTitle")}
          variant="danger"
          title={tc("suspendTitle", { username })}
          confirmLabel={t("suspendSectionTitle")}
          url={`/api/admin/users/${userId}/suspend`}
          body={(reason) => ({ days, reason })}
          note={{ label: tc("reasonLabel"), required: true }}
          errors={errors}
          successMessage={tc("suspendedToast")}
        >
          <Field label={tc("durationLabel")}>
            {(f) => (
              <Select
                {...f}
                value={String(days)}
                onChange={(e) => setDays(Number(e.target.value))}
                options={SUSPEND_DAYS.map((d) => ({ value: String(d), label: durationLabel(d) }))}
              />
            )}
          </Field>
        </ActionDialog>
      ) : null}

      {!isSelf && !adminLocked ? (
        <ActionDialog
          label={t("roleSectionTitle")}
          title={tc("roleTitle", { username })}
          confirmLabel={tc("save")}
          url={`/api/admin/users/${userId}/role`}
          body={() => ({ role: newRole, ...(newRole === "admin" ? { adminRole: newAdminRole } : {}) })}
          errors={errors}
          successMessage={tc("roleToast")}
        >
          <Field label={t("thRole")}>
            {(f) => <Select {...f} value={newRole} onChange={(e) => setNewRole(e.target.value)} options={roleOptions} />}
          </Field>
          {newRole === "admin" && role !== "admin" ? (
            <Field label={tc("adminRoleLabel")} hint={tc("adminRoleHint")}>
              {(f) => (
                <Select
                  {...f}
                  value={newAdminRole}
                  onChange={(e) => setNewAdminRole(e.target.value as AdminRole)}
                  options={adminRoleOptions}
                />
              )}
            </Field>
          ) : null}
        </ActionDialog>
      ) : null}

      {role === "admin" && canManageAdmins && !isSelf ? (
        <ActionDialog
          label={tc("adminRoleLabel")}
          title={tc("adminRoleTitle", { username })}
          confirmLabel={tc("save")}
          url={`/api/admin/users/${userId}/admin-role`}
          body={() => ({ adminRole: newAdminRole })}
          errors={errors}
          successMessage={tc("roleToast")}
        >
          <Field label={tc("adminRoleLabel")} hint={tc("adminRoleHint")}>
            {(f) => (
              <Select
                {...f}
                value={newAdminRole}
                onChange={(e) => setNewAdminRole(e.target.value as AdminRole)}
                options={adminRoleOptions}
              />
            )}
          </Field>
        </ActionDialog>
      ) : null}
    </>
  );
}
