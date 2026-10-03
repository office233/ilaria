/** Erori Postgres de integritate → coduri 4xx stabile (în loc de 500). */
const PG_FK_VIOLATION = "23503";
const PG_UNIQUE_VIOLATION = "23505";

export type ConstraintError = { status: 404 | 409; error: "not_found" | "conflict" };

export function constraintError(err: unknown): ConstraintError | null {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === PG_FK_VIOLATION) return { status: 404, error: "not_found" };
    if (code === PG_UNIQUE_VIOLATION) return { status: 409, error: "conflict" };
    return null;
}
