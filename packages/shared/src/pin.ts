// PIN rules, shared by the sign-in screen and the server. A PIN is 4 to 6 digits. A role that can move money, see the books or manage
// pay needs 6 (and the Admin always does): the more a person can do, the harder their PIN must be to guess. Obvious PINs are refused.

export const PIN_MIN = 4;
export const PIN_MAX = 6;
export const PIN_LONG = 6;

/** The permissions that make a role "privileged": they touch money, costs, pay or the books. */
export const PRIVILEGED_PERMISSIONS = ['canAccessFinance', 'canAccessAccounting', 'canManagePayments', 'canAccessPnl', 'canSeeCosts', 'canManageCommission'] as const;

/** How many digits the PIN of this role must have at least (the Admin and any privileged role: 6; everyone else: 4). */
export function requiredPinLength(role: string, permissions?: Partial<Record<string, boolean>> | null): number {
  if (role === 'Admin') return PIN_LONG;
  if (permissions && PRIVILEGED_PERMISSIONS.some((k) => permissions[k])) return PIN_LONG;
  return PIN_MIN;
}

const COMMON = new Set(['2580', '1122', '1212', '1004', '2000', '2001', '1010', '6969', '1357', '2468', '0852', '1313', '4200', '5683', '8888']);

/** An obvious PIN: one digit repeated (0000), a run up or down (1234, 4321, 123456), a repeated pair (1212), or a very common choice. */
export function isWeakPin(pin: string): boolean {
  if (!/^\d+$/.test(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true;
  if (COMMON.has(pin)) return true;
  const d = [...pin].map(Number);
  const step = (n: number) => d.every((x, i) => i === 0 || (x - d[i - 1]! + 10) % 10 === n);
  if (step(1) || step(9)) return true; // 1234 / 4321 (also wrapping, 7890)
  if (pin.length % 2 === 0) {
    const half = pin.slice(0, pin.length / 2);
    if (half.repeat(2) === pin) return true; // 1212, 123123
  }
  return false;
}

/** Why this PIN cannot be used (in words for the person), or null when it is fine. */
export function pinProblem(pin: string, role: string, permissions?: Partial<Record<string, boolean>> | null): string | null {
  if (!/^\d+$/.test(pin)) return 'A PIN is made of digits only';
  const need = requiredPinLength(role, permissions);
  if (pin.length > PIN_MAX) return `A PIN is at most ${PIN_MAX} digits`;
  if (pin.length < need) return need === PIN_MIN ? `A PIN is at least ${PIN_MIN} digits` : `This role needs a ${need}-digit PIN`;
  if (isWeakPin(pin)) return 'That PIN is too easy to guess (like 1234 or 0000). Choose a less obvious one';
  return null;
}
