/**
 * Mesajul unei valori aruncate, cu aceeași semantică ca `error?.message`:
 * sub `strict`, variabila din `catch` este `unknown`, deci nu poate fi accesată direct.
 */
export function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const { message } = error as { message: unknown };
    if (typeof message === "string") return message;
  }
  return undefined;
}
